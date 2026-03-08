import { redeemCodeInternal, RedemptionError } from '../routes/redemption-codes.js'

const DEFAULT_OPEN_ACCOUNTS_CHANNELS = ['linux-do']
const OPEN_ACCOUNTS_ALLOWED_CHANNELS = new Set(['common', 'linux-do'])

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()

const getOpenAccountsCodeChannels = () => {
  const raw = String(process.env.OPEN_ACCOUNTS_CODE_CHANNELS || '').trim()
  const list = raw
    ? raw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
    : []
  const filtered = list.filter(item => OPEN_ACCOUNTS_ALLOWED_CHANNELS.has(item))
  return filtered.length ? filtered : DEFAULT_OPEN_ACCOUNTS_CHANNELS
}

const mapCodeRow = (row) => {
  if (!row) return null
  return {
    id: Number(row[0]),
    code: String(row[1] || ''),
    accountEmail: row[2] ? String(row[2]) : '',
    channel: row[3] ? String(row[3]) : 'common',
    isRedeemed: Number(row[4] || 0) === 1,
    redeemedBy: row[5] ? String(row[5]) : ''
  }
}

export const reserveOpenAccountsCode = (db, { orderNo, accountEmail, email }) => {
  if (!db || !orderNo || !accountEmail || !email) return null
  const channels = getOpenAccountsCodeChannels()
  const placeholders = channels.map(() => '?').join(',')
  const normalizedAccount = normalizeEmail(accountEmail)
  const result = db.exec(
    `
      SELECT id, code, account_email, channel, is_redeemed, redeemed_by
	      FROM redemption_codes
	      WHERE is_redeemed = 0
	        AND account_email IS NOT NULL
	        AND lower(trim(account_email)) = ?
	        AND channel IN (${placeholders})
	        AND (reserved_for_uid IS NULL OR reserved_for_uid = '')
        AND (reserved_for_order_no IS NULL OR reserved_for_order_no = '')
        AND (reserved_for_entry_id IS NULL OR reserved_for_entry_id = 0)
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [normalizedAccount, ...channels]
  )

  const row = result[0]?.values?.[0]
  const codeInfo = mapCodeRow(row)
  if (!codeInfo) return null

  db.run(
    `
      UPDATE redemption_codes
      SET reserved_for_order_no = ?,
          reserved_for_order_email = ?,
          reserved_at = DATETIME('now', 'localtime'),
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
        AND is_redeemed = 0
        AND (reserved_for_order_no IS NULL OR reserved_for_order_no = '')
    `,
    [orderNo, normalizeEmail(email), codeInfo.id]
  )

  const verify = db.exec(
    `SELECT reserved_for_order_no FROM redemption_codes WHERE id = ? LIMIT 1`,
    [codeInfo.id]
  )
  const reservedFor = verify[0]?.values?.[0]?.[0]
  if (String(reservedFor || '') !== String(orderNo)) return null

  return codeInfo
}

export const attachOpenAccountsCodeToOrder = (db, orderNo, codeInfo) => {
  if (!db || !orderNo || !codeInfo) return
  db.run(
    `
      UPDATE credit_orders
      SET code_id = ?,
          code = ?,
          code_account_email = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [codeInfo.id, codeInfo.code, codeInfo.accountEmail || null, orderNo]
  )
}

const fetchCodeByOrderNo = (db, orderNo) => {
  const result = db.exec(
    `
      SELECT id, code, account_email, channel, is_redeemed, redeemed_by
      FROM redemption_codes
      WHERE reserved_for_order_no = ?
      ORDER BY reserved_at DESC, updated_at DESC
      LIMIT 1
    `,
    [orderNo]
  )
  return mapCodeRow(result[0]?.values?.[0])
}

const fetchCodeByOrderRow = (db, orderRow) => {
  if (!db || !orderRow) return null
  const codeId = orderRow[0]
  const code = orderRow[1]
  if (!codeId && !code) return null

  const result = db.exec(
    `
      SELECT id, code, account_email, channel, is_redeemed, redeemed_by
      FROM redemption_codes
      WHERE ${codeId ? 'id = ?' : 'code = ?'}
      LIMIT 1
    `,
    [codeId || code]
  )
  return mapCodeRow(result[0]?.values?.[0])
}

export const ensureOpenAccountsOrderCode = (db, { orderNo, accountEmail, email }) => {
  if (!db || !orderNo) return null
  const orderRow = db.exec(
    `SELECT code_id, code, code_account_email FROM credit_orders WHERE order_no = ? LIMIT 1`,
    [orderNo]
  )[0]?.values?.[0]

  const existing = fetchCodeByOrderRow(db, orderRow)
  if (existing) return existing

  const reserved = fetchCodeByOrderNo(db, orderNo)
  if (reserved) {
    attachOpenAccountsCodeToOrder(db, orderNo, reserved)
    return reserved
  }

  if (!accountEmail || !email) return null
  const reservedNow = reserveOpenAccountsCode(db, { orderNo, accountEmail, email })
  if (reservedNow) {
    attachOpenAccountsCodeToOrder(db, orderNo, reservedNow)
  }
  return reservedNow
}

export const releaseOpenAccountsOrderCode = (db, orderNo) => {
  if (!db || !orderNo) return { released: 0 }
  db.run(
    `
      UPDATE redemption_codes
      SET reserved_for_order_no = NULL,
          reserved_for_order_email = NULL,
          reserved_at = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE reserved_for_order_no = ?
        AND is_redeemed = 0
    `,
    [orderNo]
  )
  db.run(
    `
      UPDATE credit_orders
      SET code_id = NULL,
          code = NULL,
          code_account_email = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [orderNo]
  )
  return { released: 1 }
}

export const redeemOpenAccountsOrderCode = async (db, { orderNo, uid, email, accountEmail, capacityLimit = 5, orderType }) => {
  const codeInfo = ensureOpenAccountsOrderCode(db, { orderNo, accountEmail, email })
  if (!codeInfo?.code) {
    return { ok: false, error: 'no_code' }
  }

  try {
    const redemption = await redeemCodeInternal({
      email,
      code: codeInfo.code,
      channel: codeInfo.channel || 'common',
      orderType,
      redeemerUid: uid,
      capacityLimit
    })
    return { ok: true, redemption, code: codeInfo }
  } catch (error) {
    if (error instanceof RedemptionError) {
      return { ok: false, error: error.message, statusCode: error.statusCode || 400 }
    }
    return { ok: false, error: error?.message || 'redeem_failed', statusCode: 500 }
  }
}
