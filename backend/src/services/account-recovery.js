const toInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const ORDER_TYPE_WARRANTY = 'warranty'
const ORDER_TYPE_NO_WARRANTY = 'no_warranty'
const ORDER_TYPE_ANTI_BAN = 'anti_ban'
const ORDER_TYPE_SET = new Set([ORDER_TYPE_WARRANTY, ORDER_TYPE_NO_WARRANTY, ORDER_TYPE_ANTI_BAN])

const normalizeOrderType = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  return ORDER_TYPE_SET.has(normalized) ? normalized : ORDER_TYPE_WARRANTY
}

const isNoWarrantyOrderType = (value) => normalizeOrderType(value) === ORDER_TYPE_NO_WARRANTY

const DEFAULT_WARRANTY_SERVICE_DAYS = Math.max(1, toInt(process.env.PURCHASE_SERVICE_DAYS, 30))
const DEFAULT_NO_WARRANTY_SERVICE_DAYS = Math.max(
  1,
  toInt(process.env.PURCHASE_NO_WARRANTY_SERVICE_DAYS, DEFAULT_WARRANTY_SERVICE_DAYS)
)

const resolveDefaultServiceDays = (orderType) => (
  isNoWarrantyOrderType(orderType) ? DEFAULT_NO_WARRANTY_SERVICE_DAYS : DEFAULT_WARRANTY_SERVICE_DAYS
)

const pad2 = (value) => String(value).padStart(2, '0')

const addDays = (date, days) => {
  const base = date instanceof Date ? date.getTime() : new Date(date).getTime()
  if (Number.isNaN(base)) return new Date(NaN)
  const deltaDays = Number(days || 0)
  if (!Number.isFinite(deltaDays)) return new Date(NaN)
  return new Date(base + deltaDays * 24 * 60 * 60 * 1000)
}

const EXPIRE_AT_PARSE_REGEX = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
const parseExpireAtToMs = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const match = raw.match(EXPIRE_AT_PARSE_REGEX)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] != null ? Number(match[6]) : 0

  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  if (hour < 0 || hour > 23) return null
  if (minute < 0 || minute > 59) return null
  if (second < 0 || second > 59) return null

  // NOTE: gpt_accounts.expire_at is stored as Asia/Shanghai time.
  const iso = `${match[1]}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+08:00`
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? null : parsed
}

export function resolveOrderDeadlineMs(db, { originalCodeId, originalCode, redeemedAt, orderType } = {}) {
  if (!db) return NaN

  const codeId = Number(originalCodeId || 0)
  const sanitizedCode = String(originalCode || '').trim().toUpperCase()
  const defaultServiceDays = resolveDefaultServiceDays(orderType)

  let orderMetaResult
  if (Number.isFinite(codeId) && codeId > 0 && sanitizedCode) {
    orderMetaResult = db.exec(
      `
        SELECT service_days, created_at, paid_at, redeemed_at
        FROM purchase_orders
        WHERE code_id = ?
           OR (code_id IS NULL AND code = ?)
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [codeId, sanitizedCode]
    )
  } else if (Number.isFinite(codeId) && codeId > 0) {
    orderMetaResult = db.exec(
      `
        SELECT service_days, created_at, paid_at, redeemed_at
        FROM purchase_orders
        WHERE code_id = ?
           OR (code_id IS NULL AND code = (SELECT code FROM redemption_codes WHERE id = ?))
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [codeId, codeId]
    )
  } else if (sanitizedCode) {
    orderMetaResult = db.exec(
      `
        SELECT service_days, created_at, paid_at, redeemed_at
        FROM purchase_orders
        WHERE code = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [sanitizedCode]
    )
  } else {
    return NaN
  }

  const orderMetaRow = orderMetaResult?.[0]?.values?.[0] || null
  const resolvedServiceDays = orderMetaRow ? Math.max(1, toInt(orderMetaRow[0], defaultServiceDays)) : defaultServiceDays
  const orderStartAt = orderMetaRow?.[1] || orderMetaRow?.[2] || orderMetaRow?.[3] || redeemedAt
  const orderDeadlineDate = addDays(orderStartAt, resolvedServiceDays)
  return orderDeadlineDate instanceof Date ? orderDeadlineDate.getTime() : NaN
}

export function selectRecoveryCode(
  db,
  {
    minExpireMs,
    capacityLimit = 6,
    preferNonToday = true,
    preferLatestExpire = false,
    limit = 200,
    excludeCodeIds,
    codeCreatedWithinDays
  } = {}
) {
  if (!db) return null

  const nowMs = Date.now()
  const parsedMinExpireMs = Number(minExpireMs)
  const effectiveMinExpireMs = Math.max(nowMs, Number.isFinite(parsedMinExpireMs) ? parsedMinExpireMs : nowMs)
  const effectiveMinExpireSeconds = Math.floor(effectiveMinExpireMs / 1000)
  const maxSeats = Math.max(1, Number(capacityLimit) || 6)
  const queryLimit = Math.min(500, Math.max(1, toInt(limit, 200)))
  const createdWithinDays = Math.min(365, Math.max(1, toInt(codeCreatedWithinDays, 7)))
  const createdSinceOffsetDays = Math.max(0, createdWithinDays - 1)
  const createdSinceModifier = `-${createdSinceOffsetDays} day`
  const excludedCodeIds = Array.isArray(excludeCodeIds)
    ? new Set(
        excludeCodeIds
          .map(value => Number(value))
          .filter(value => Number.isFinite(value) && value > 0)
      )
    : null
  const orderSql = preferLatestExpire
    ? 'ORDER BY ga.expire_at DESC, occupancy ASC, rc.id ASC'
    : 'ORDER BY is_today ASC, ga.expire_at ASC, occupancy ASC, rc.id ASC'

  const recoveryCodeResult = db.exec(
    `
      SELECT
        rc.id,
        rc.code,
        rc.account_email,
        ga.expire_at,
        CASE WHEN DATE(ga.created_at) = DATE('now', 'localtime') THEN 1 ELSE 0 END AS is_today,
        COALESCE(ga.user_count, 0) + COALESCE(ga.invite_count, 0) AS occupancy
      FROM redemption_codes rc
      JOIN gpt_accounts ga ON lower(trim(ga.email)) = lower(trim(rc.account_email))
      WHERE rc.is_redeemed = 0
        AND rc.account_email IS NOT NULL
        AND trim(rc.account_email) != ''
        AND COALESCE(NULLIF(lower(trim(rc.channel)), ''), 'common') = 'common'
        AND rc.created_at >= DATETIME(DATE('now', 'localtime', ?))
        AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
        AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
        AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
        AND COALESCE(ga.user_count, 0) + COALESCE(ga.invite_count, 0) < ?
        AND COALESCE(ga.is_open, 0) = 1
        AND COALESCE(ga.is_banned, 0) = 0
        AND ga.token IS NOT NULL
        AND trim(ga.token) != ''
        AND ga.chatgpt_account_id IS NOT NULL
        AND trim(ga.chatgpt_account_id) != ''
        AND ga.expire_at IS NOT NULL
        AND trim(ga.expire_at) != ''
        AND DATETIME(REPLACE(ga.expire_at, '/', '-')) >= DATETIME(?, 'unixepoch', 'localtime')
      ${orderSql}
      LIMIT ?
    `,
    [createdSinceModifier, maxSeats, effectiveMinExpireSeconds, queryLimit]
  )

  const rows = recoveryCodeResult?.[0]?.values || []
  if (!rows.length) return null

  const candidates = []

  for (const row of rows) {
    const recoveryCodeId = Number(row[0])
    const recoveryCode = String(row[1] || '').trim()
    const recoveryAccountEmail = String(row[2] || '').trim()
    const expireAtRaw = row[3] ? String(row[3]).trim() : ''
    const isToday = Number(row[4] || 0) === 1
    const occupancy = Number(row[5] || 0)

    if (!recoveryCodeId || !recoveryCode || !recoveryAccountEmail || !expireAtRaw) continue
    if (excludedCodeIds && excludedCodeIds.has(recoveryCodeId)) continue

    const expireAtMs = parseExpireAtToMs(expireAtRaw)
    if (expireAtMs == null || expireAtMs < effectiveMinExpireMs) continue

    candidates.push({
      recoveryCodeId,
      recoveryCode,
      recoveryChannel: 'common',
      recoveryAccountEmail,
      expireAt: expireAtRaw,
      expireAtMs,
      isToday,
      occupancy,
    })
  }

  if (!candidates.length) return null

  let pool = candidates
  if (preferNonToday) {
    const nonToday = candidates.filter(item => !item.isToday)
    if (nonToday.length) pool = nonToday
  }

  pool.sort((a, b) => {
    if (a.expireAtMs !== b.expireAtMs) {
      return preferLatestExpire ? b.expireAtMs - a.expireAtMs : a.expireAtMs - b.expireAtMs
    }
    if (a.occupancy !== b.occupancy) return a.occupancy - b.occupancy
    return a.recoveryCodeId - b.recoveryCodeId
  })

  return pool[0] || null
}
