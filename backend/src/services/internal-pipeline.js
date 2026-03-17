import crypto from 'crypto'

const DEFAULT_CHANNEL = 'common'
const DEFAULT_CHANNEL_NAME = '通用渠道'
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const EXPIRE_AT_REGEX = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/

const normalizeText = (value) => {
  if (value == null) return ''
  return String(value).trim()
}

const normalizeEmail = (value) => normalizeText(value).toLowerCase()

const formatDateTime = (date) => {
  const pad = (value) => String(value).padStart(2, '0')
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export const timingSafeTokenEqual = (provided, expected) => {
  const left = normalizeText(provided)
  const right = normalizeText(expected)
  if (!left || !right) return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

export const normalizeExpireAt = (value) => {
  const raw = normalizeText(value)
  if (!raw) return null

  const match = raw.match(EXPIRE_AT_REGEX)
  if (match) {
    const seconds = match[6] || '00'
    return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}:${seconds}`
  }

  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && asNumber > 0) {
    const date = new Date(asNumber)
    const formatted = formatDateTime(date)
    if (formatted) return formatted
  }

  const parsed = new Date(raw)
  const formatted = formatDateTime(parsed)
  if (formatted) return formatted

  return null
}

export const validateImportPayload = (payload) => {
  const body = payload && typeof payload === 'object' ? payload : {}

  const email = normalizeEmail(body.email)
  if (!email) {
    throw new Error('email is required')
  }

  const password = normalizeText(body.password)
  if (!password) {
    throw new Error('password is required')
  }

  const accessToken = normalizeText(body.access_token ?? body.accessToken)
  if (!accessToken) {
    throw new Error('access_token is required')
  }

  const refreshToken = normalizeText(body.refresh_token ?? body.refreshToken)
  const sessionToken = normalizeText(body.session_token ?? body.sessionToken)
  const teamName = normalizeText(body.team_name ?? body.teamName)
  const cardLast4 = normalizeText(body.card_last4 ?? body.cardLast4)
  const expiresAt = normalizeExpireAt(body.expires_at ?? body.expiresAt)

  if ((body.expires_at != null || body.expiresAt != null) && !expiresAt) {
    throw new Error('expires_at format is invalid')
  }

  return {
    email,
    password,
    teamName: teamName || null,
    accessToken,
    refreshToken: refreshToken || null,
    sessionToken: sessionToken || null,
    cardLast4: cardLast4 || null,
    expiresAt: expiresAt || null,
  }
}

export const generateRedemptionCode = (length = 12, randomFn = Math.random) => {
  let code = ''
  for (let i = 0; i < length; i += 1) {
    code += CODE_CHARS.charAt(Math.floor(randomFn() * CODE_CHARS.length))
    if ((i + 1) % 4 === 0 && i < length - 1) {
      code += '-'
    }
  }
  return code
}

const getExistingAccountId = (db, email) => {
  const result = db.exec('SELECT id FROM gpt_accounts WHERE lower(email) = ? LIMIT 1', [email])
  if (!result[0]?.values?.length) return null
  return Number(result[0].values[0][0])
}

const insertAccount = (db, payload) => {
  db.run(
    `INSERT INTO gpt_accounts (
      email,
      password,
      team_name,
      token,
      refresh_token,
      session_token,
      user_count,
      invite_count,
      chatgpt_account_id,
      oai_device_id,
      expire_at,
      is_open,
      is_banned,
      ban_processed,
      card_last4,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
    [
      payload.email,
      payload.password,
      payload.teamName,
      payload.accessToken,
      payload.refreshToken,
      payload.sessionToken,
      1,
      0,
      null,
      null,
      payload.expiresAt,
      1,
      0,
      0,
      payload.cardLast4,
    ]
  )

  const idResult = db.exec('SELECT id FROM gpt_accounts WHERE id = last_insert_rowid()')
  return Number(idResult[0].values[0][0])
}

const updateAccount = (db, accountId, payload) => {
  db.run(
    `UPDATE gpt_accounts
     SET password = ?,
         team_name = ?,
         token = ?,
         refresh_token = ?,
         session_token = ?,
         card_last4 = ?,
         expire_at = ?,
         is_open = 1,
         is_banned = 0,
         updated_at = DATETIME('now', 'localtime')
     WHERE id = ?`,
    [
      payload.password,
      payload.teamName,
      payload.accessToken,
      payload.refreshToken,
      payload.sessionToken,
      payload.cardLast4,
      payload.expiresAt,
      accountId,
    ]
  )
}

export const upsertImportedAccount = (db, payload) => {
  const existingAccountId = getExistingAccountId(db, payload.email)
  if (existingAccountId) {
    updateAccount(db, existingAccountId, payload)
    return { accountId: existingAccountId, action: 'updated' }
  }

  const accountId = insertAccount(db, payload)
  return { accountId, action: 'created' }
}

const findAvailableRedemptionCode = (db, email) => {
  const result = db.exec(
    `SELECT code
     FROM redemption_codes
     WHERE lower(account_email) = ?
       AND is_redeemed = 0
       AND reserved_for_order_no IS NULL
     ORDER BY created_at ASC
     LIMIT 1`,
    [email]
  )

  if (!result[0]?.values?.length) return null
  return String(result[0].values[0][0])
}

const insertRedemptionCode = (db, email, code) => {
  db.run(
    `INSERT INTO redemption_codes (
      code,
      account_email,
      channel,
      channel_name,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
    [code, email, DEFAULT_CHANNEL, DEFAULT_CHANNEL_NAME]
  )
}

export const getOrCreateRedemptionCode = (db, email, options = {}) => {
  const existingCode = findAvailableRedemptionCode(db, email)
  if (existingCode) return existingCode

  const generateCodeFn = options.generateCodeFn || generateRedemptionCode
  const maxAttempts = Math.max(3, Number(options.maxAttempts || 8))

  let attempts = 0
  while (attempts < maxAttempts) {
    const code = String(generateCodeFn()).trim()
    if (!code) {
      attempts += 1
      continue
    }

    try {
      insertRedemptionCode(db, email, code)
      return code
    } catch (error) {
      const message = String(error?.message || '')
      if (message.includes('UNIQUE')) {
        attempts += 1
        continue
      }
      throw error
    }
  }

  throw new Error('failed to generate redemption code')
}

export const buildImportNotification = ({ accountId, email, redemptionCode }) => {
  return [
    '【流水线导入成功】',
    `账号ID: ${accountId}`,
    `邮箱: ${email}`,
    `兑换码: ${redemptionCode}`,
  ].join('\n')
}

export const importAccountFromPipeline = async ({
  db,
  payload,
  saveFn,
  notifyEnabled = false,
  notifyFn,
  generateCodeFn,
}) => {
  const { accountId, action } = upsertImportedAccount(db, payload)
  const redemptionCode = getOrCreateRedemptionCode(db, payload.email, { generateCodeFn })

  if (typeof saveFn === 'function') {
    await saveFn()
  }

  if (notifyEnabled && typeof notifyFn === 'function') {
    const message = buildImportNotification({ accountId, email: payload.email, redemptionCode })
    await notifyFn(message)
  }

  return { accountId, redemptionCode, action }
}
