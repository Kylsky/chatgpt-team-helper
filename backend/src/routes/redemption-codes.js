import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireMenu } from '../middleware/rbac.js'
import { apiKeyAuth } from '../middleware/api-key-auth.js'
import { verifyLinuxDoSessionToken } from '../middleware/linuxdo-session.js'
import { syncAccountInviteCount, syncAccountUserCount } from '../services/account-sync.js'
import { inviteUserToChatGPTTeam } from '../services/chatgpt-invite.js'
import {
  getXhsConfig,
  getXhsOrderByNumber,
  markXhsOrderRedeemed,
  normalizeXhsOrderNumber,
  recordXhsSyncResult,
  syncOrdersFromApi,
} from '../services/xhs-orders.js'
import { isXhsSyncing, setXhsSyncing } from '../services/xhs-sync-runner.js'
import {
  getXianyuConfig,
  updateXianyuConfig,
  getXianyuOrderById,
  markXianyuOrderRedeemed,
  normalizeXianyuOrderId,
  recordXianyuSyncResult,
  queryXianyuOrderDetailFromApi,
  transformXianyuApiOrder,
  transformApiOrderForImport as transformXianyuApiOrderForImport,
  importXianyuOrders,
} from '../services/xianyu-orders.js'
import { withLocks } from '../utils/locks.js'
import { requireFeatureEnabled } from '../middleware/feature-flags.js'
import { SPACE_MEMBER_LIMIT, calcRedeemableSlots } from '../utils/space-capacity.js'

const router = express.Router()
const CHANNEL_LABELS = {
  common: '通用渠道',
  'linux-do': 'Linux DO 渠道',
  xhs: '小红书渠道',
  xianyu: '闲鱼渠道',
  'artisan-flow': 'ArtisanFlow 渠道'
}
const CHANNEL_KEYS = Object.keys(CHANNEL_LABELS)
const normalizeChannel = (value = 'common') => (CHANNEL_KEYS.includes(value) ? value : 'common')
const getChannelName = (value = 'common') => CHANNEL_LABELS[normalizeChannel(value)] || CHANNEL_LABELS.common
const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}
const ACCOUNT_RECOVERY_WINDOW_DAYS = Math.max(1, toInt(process.env.ACCOUNT_RECOVERY_WINDOW_DAYS, 30))
const ORDER_TYPE_WARRANTY = 'warranty'
const ORDER_TYPE_NO_WARRANTY = 'no_warranty'
const ORDER_TYPE_ANTI_BAN = 'anti_ban'
const ORDER_TYPE_SET = new Set([ORDER_TYPE_WARRANTY, ORDER_TYPE_NO_WARRANTY, ORDER_TYPE_ANTI_BAN])
const normalizeOrderType = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  return ORDER_TYPE_SET.has(normalized) ? normalized : ORDER_TYPE_WARRANTY
}
const isNoWarrantyOrderType = (value) => normalizeOrderType(value) === ORDER_TYPE_NO_WARRANTY
const isAntiBanOrderType = (value) => normalizeOrderType(value) === ORDER_TYPE_ANTI_BAN

const parseAmountNumber = (value) => {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const normalized = String(value).trim()
  if (!normalized) return null
  const cleaned = normalized.replace(/[^\d.-]/g, '')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const resolveXianyuOrderTypeFromActualPaid = (actualPaid) => {
  const paid = parseAmountNumber(actualPaid)
  if (paid == null) return ORDER_TYPE_WARRANTY
  // 兼容两种单位：
  // - 直接是元：5 / 15
  // - 被同步成“分”：500 / 1500
  const asYuan = paid
  const asCentToYuan = paid / 100
  const tierDistance = (value) => Math.min(Math.abs(value - 5), Math.abs(value - 15))
  const normalized = tierDistance(asCentToYuan) < tierDistance(asYuan) ? asCentToYuan : asYuan

  // 约定：< 10 元按“无质保（5元档）”，>= 10 元按“质保（15元档）”
  return normalized < 10 ? ORDER_TYPE_NO_WARRANTY : ORDER_TYPE_WARRANTY
}
const mapCodeRow = row => {
  if (!row) return null
  const channelValue = normalizeChannel(row[6] || 'common')
  return {
    id: row[0],
    code: row[1],
    isRedeemed: row[2] === 1,
    redeemedAt: row[3],
    redeemedBy: row[4],
    accountEmail: row[5],
    channel: channelValue,
    channelName: row[7] || getChannelName(channelValue),
    createdAt: row[8],
    updatedAt: row[9],
    reservedForUid: row.length > 10 ? row[10] || null : null,
    reservedForUsername: row.length > 11 ? row[11] || null : null,
    reservedForEntryId: row.length > 12 ? row[12] || null : null,
    reservedAt: row.length > 13 ? row[13] || null : null,
    reservedForOrderNo: row.length > 14 ? row[14] || null : null,
    reservedForOrderEmail: row.length > 15 ? row[15] || null : null,
    orderType: row.length > 16 ? row[16] || null : null
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE_REGEX = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
const OUT_OF_STOCK_MESSAGE = '暂无可用兑换码，请联系管理员补货'
const extractEmailFromRedeemedBy = (redeemedBy) => {
  const raw = String(redeemedBy ?? '').trim()
  if (!raw) return ''

  const match = raw.match(/email\s*:\s*([^|]+)(?:\||$)/i)
  if (match?.[1]) {
    return String(match[1]).trim()
  }

  return EMAIL_REGEX.test(raw) ? raw : ''
}
export class RedemptionError extends Error {
  constructor(statusCode, message, payload = {}) {
    super(message)
    this.statusCode = statusCode
    this.payload = payload
  }
}

// 生成随机兑换码
function generateRedemptionCode(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 排除容易混淆的字符
  let code = ''
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
    // 每4位添加一个分隔符
    if ((i + 1) % 4 === 0 && i < length - 1) {
      code += '-'
    }
  }
  return code
}

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()


const upsertRedemptionSeatProtection = (db, email, sourceChannel = 'system_redemption') => {
  if (!db) return
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) return

  const existing = db.exec(
    `
      SELECT id
      FROM open_account_seat_protections
      WHERE lower(target_email) = ?
        AND source_channel = ?
      LIMIT 1
    `,
    [normalizedEmail, sourceChannel]
  )

  if (existing[0]?.values?.length) {
    const protectionId = Number(existing[0].values[0][0])
    db.run(
      `
        UPDATE open_account_seat_protections
        SET expires_at = NULL,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
      `,
      [protectionId]
    )
    return
  }

  db.run(
    `
      INSERT INTO open_account_seat_protections (
        target_email,
        source_channel,
        created_at,
        updated_at
      )
      VALUES (?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
    `,
    [normalizedEmail, sourceChannel]
  )
}

const buildRecoveryWindowEndsAt = (redeemedAt) => {
  if (!redeemedAt) return null
  const redeemedTime = new Date(redeemedAt).getTime()
  if (Number.isNaN(redeemedTime)) return null
  const windowMs = ACCOUNT_RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000
  return new Date(redeemedTime + windowMs).toISOString()
}

const isAccountAccessFailure = (error) => {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status)
  return status === 400 || status === 401 || status === 403 || status === 404
}

const recordAccountRecovery = (db, payload) => {
  if (!db || !payload) return
  db.run(
    `
      INSERT INTO account_recovery_logs (
        email,
        original_code_id,
        original_redeemed_at,
        original_account_email,
        recovery_mode,
        recovery_code_id,
        recovery_code,
        recovery_account_email,
        status,
        error_message,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
    `,
    [
      payload.email,
      payload.originalCodeId,
      payload.originalRedeemedAt || null,
      payload.originalAccountEmail || null,
      payload.recoveryMode || null,
      payload.recoveryCodeId || null,
      payload.recoveryCode || null,
      payload.recoveryAccountEmail || null,
      payload.status || 'pending',
      payload.errorMessage || null,
    ]
  )
}

export async function redeemCodeInternal({
  email,
  code,
  channel = 'common',
  orderType,
  redeemerUid,
  capacityLimit = SPACE_MEMBER_LIMIT,
  skipCodeFormatValidation = false,
  allowCommonChannelFallback = false,
}) {
  const normalizedEmail = (email || '').trim()
  if (!normalizedEmail) {
    throw new RedemptionError(400, '请输入邮箱地址')
  }

  if (!EMAIL_REGEX.test(normalizedEmail)) {
    throw new RedemptionError(400, '请输入有效的邮箱地址')
  }

  const sanitizedCode = (code || '').trim().toUpperCase()
  if (!sanitizedCode) {
    throw new RedemptionError(400, '请输入兑换码')
  }

  if (!skipCodeFormatValidation && !CODE_REGEX.test(sanitizedCode)) {
    throw new RedemptionError(400, '兑换码格式不正确（格式：XXXX-XXXX-XXXX）')
  }

  const requestedChannel = normalizeChannel(channel)
  const normalizedRedeemerUid = redeemerUid != null ? String(redeemerUid).trim() : ''

  if (requestedChannel === 'linux-do' && !normalizedRedeemerUid) {
    throw new RedemptionError(400, 'Linux DO 渠道兑换需要填写论坛 UID')
  }

  const db = await getDatabase()
  const codeResult = db.exec(`
      SELECT id, code, is_redeemed, redeemed_at, redeemed_by,
             account_email, channel, channel_name, created_at, updated_at,
             reserved_for_uid, reserved_for_username, reserved_for_entry_id, reserved_at,
             reserved_for_order_no, reserved_for_order_email, order_type
      FROM redemption_codes
      WHERE code = ?
    `, [sanitizedCode])

  if (codeResult.length === 0 || codeResult[0].values.length === 0) {
    throw new RedemptionError(404, '兑换码不存在或已失效')
  }

  const codeRow = codeResult[0].values[0]
  const codeRecord = mapCodeRow(codeRow)
  const codeId = codeRecord.id
  const isRedeemed = codeRecord.isRedeemed
  const boundAccountEmail = codeRecord.accountEmail
  const codeChannel = codeRecord.channel
  const storedChannel = codeRow[6] == null ? '' : String(codeRow[6]).trim().toLowerCase()
  const isStoredCommonChannel = storedChannel === '' || storedChannel === 'common'
  const reservedForUid = codeRecord.reservedForUid ? String(codeRecord.reservedForUid).trim() : ''
  const reservedForEntryId = codeRecord.reservedForEntryId
  const reservedForOrderNo = codeRecord.reservedForOrderNo ? String(codeRecord.reservedForOrderNo).trim() : ''
  const reservedForOrderEmail = codeRecord.reservedForOrderEmail ? normalizeEmail(codeRecord.reservedForOrderEmail) : ''
  let resolvedOrderType = normalizeOrderType(orderType || codeRecord.orderType)
  const redeemerIdentifier = requestedChannel === 'linux-do' && normalizedRedeemerUid
    ? `UID:${normalizedRedeemerUid} | Email:${normalizedEmail}`
    : normalizedEmail

  if (isRedeemed) {
    throw new RedemptionError(400, '该兑换码已被使用')
  }

  const fallbackFromCommonChannelAllowed = Boolean(allowCommonChannelFallback)
    && isStoredCommonChannel
    && (requestedChannel === 'xhs' || requestedChannel === 'xianyu')

  if (codeChannel !== requestedChannel && !fallbackFromCommonChannelAllowed) {
    throw new RedemptionError(403, '该兑换码仅能在对应渠道的兑换页使用')
  }

  if (requestedChannel === 'linux-do' && reservedForUid && reservedForUid !== normalizedRedeemerUid) {
    throw new RedemptionError(403, '该兑换码已绑定其他 Linux DO 用户')
  }

  if (reservedForOrderNo) {
    const orderResult = db.exec(
      `
        SELECT status, email, refunded_at, order_type
        FROM purchase_orders
        WHERE order_no = ?
        LIMIT 1
      `,
      [reservedForOrderNo]
    )

    const orderRow = orderResult[0]?.values?.[0]
    if (orderRow) {
      const orderStatus = String(orderRow[0] || '')
      const orderEmail = normalizeEmail(orderRow[1])
      const refundedAt = orderRow[2]
      const orderTypeFromOrder = orderRow[3]
      if (orderTypeFromOrder != null && String(orderTypeFromOrder).trim()) {
        resolvedOrderType = normalizeOrderType(orderTypeFromOrder)
      }

      if (refundedAt || orderStatus === 'refunded') {
        throw new RedemptionError(403, '该订单已退款，兑换码已失效')
      }

      if (orderStatus !== 'paid') {
        throw new RedemptionError(403, '该兑换码对应订单未完成支付')
      }

      if (reservedForOrderEmail && reservedForOrderEmail !== normalizeEmail(normalizedEmail)) {
        throw new RedemptionError(403, '该兑换码已绑定购买邮箱，请使用下单邮箱兑换')
      }

      if (orderEmail && orderEmail !== normalizeEmail(normalizedEmail)) {
        throw new RedemptionError(403, '该兑换码已绑定购买邮箱，请使用下单邮箱兑换')
      }
    } else {
      const creditOrderResult = db.exec(
        `
          SELECT status, paid_at, refunded_at, scene
          FROM credit_orders
          WHERE order_no = ?
          LIMIT 1
        `,
        [reservedForOrderNo]
      )
      const creditRow = creditOrderResult[0]?.values?.[0]
      if (!creditRow) {
        throw new RedemptionError(403, '该兑换码绑定的订单不存在或已失效')
      }

      const creditStatus = String(creditRow[0] || '')
      const paidAt = creditRow[1]
      const refundedAt = creditRow[2]
      const scene = String(creditRow[3] || '')

      if (scene && scene !== 'open_accounts_board') {
        throw new RedemptionError(403, '该兑换码绑定的订单不可用于兑换')
      }

      if (refundedAt || creditStatus === 'refunded') {
        throw new RedemptionError(403, '该订单已退款，兑换码已失效')
      }

      if (creditStatus !== 'paid' && !paidAt) {
        throw new RedemptionError(403, '该兑换码对应订单未完成支付')
      }

      if (reservedForOrderEmail && reservedForOrderEmail !== normalizeEmail(normalizedEmail)) {
        throw new RedemptionError(403, '该兑换码已绑定购买邮箱，请使用下单邮箱兑换')
      }
    }
  }

  let accountResult

  const maxSeats = Math.max(1, Math.min(SPACE_MEMBER_LIMIT, Number(capacityLimit) || SPACE_MEMBER_LIMIT))

  if (boundAccountEmail) {
    accountResult = db.exec(`
        SELECT id, email, token, user_count, chatgpt_account_id, oai_device_id
        FROM gpt_accounts
        WHERE email = ?
          AND COALESCE(user_count, 0) + COALESCE(invite_count, 0) < ?
      `, [boundAccountEmail, maxSeats])

    if (accountResult.length === 0 || accountResult[0].values.length === 0) {
      throw new RedemptionError(503, '该兑换码绑定的账号已达到人数上限，请联系管理员')
    }
  } else {
    accountResult = db.exec(`
        SELECT id, email, token, user_count, chatgpt_account_id, oai_device_id
        FROM gpt_accounts
        WHERE COALESCE(user_count, 0) + COALESCE(invite_count, 0) < ?
        ORDER BY COALESCE(user_count, 0) + COALESCE(invite_count, 0) ASC, RANDOM()
        LIMIT 1
      `, [maxSeats])

    if (accountResult.length === 0 || accountResult[0].values.length === 0) {
      throw new RedemptionError(
        503,
        '暂无可用账号，请稍后再试或联系管理员'
      )
    }
  }

  const account = accountResult[0].values[0]
  const accountId = account[0]
  const accountEmail = account[1]
  const accountToken = account[2]
  const currentUserCount = account[3] || 0
  const chatgptAccountId = account[4]
  const oaiDeviceId = account[5]
  const accountData = {
    token: accountToken,
    chatgpt_account_id: chatgptAccountId,
    oai_device_id: oaiDeviceId
  }

  try {
    const updates = [
      'is_redeemed = 1',
      "redeemed_at = DATETIME('now', 'localtime')",
      'redeemed_by = ?',
      'order_type = ?',
      "updated_at = DATETIME('now', 'localtime')",
    ]
    const updateParams = [redeemerIdentifier, resolvedOrderType]

    if (fallbackFromCommonChannelAllowed && codeChannel !== requestedChannel) {
      updates.push('channel = ?')
      updates.push('channel_name = ?')
      updateParams.push(requestedChannel, getChannelName(requestedChannel))
    }

    db.run(
      `UPDATE redemption_codes SET ${updates.join(', ')} WHERE id = ?`,
      [...updateParams, codeId]
    )

    if (requestedChannel === 'linux-do' && normalizedRedeemerUid) {
      if (reservedForEntryId) {
        db.run(
          `
              UPDATE waiting_room_entries
              SET status = 'boarded',
                  boarded_at = DATETIME('now', 'localtime'),
                  updated_at = DATETIME('now', 'localtime')
              WHERE id = ?
            `,
          [reservedForEntryId]
        )
      } else {
        db.run(
          `
              UPDATE waiting_room_entries
              SET status = 'boarded',
                  boarded_at = DATETIME('now', 'localtime'),
                  updated_at = DATETIME('now', 'localtime')
              WHERE linuxdo_uid = ? AND status = 'waiting'
            `,
          [normalizedRedeemerUid]
        )
      }
    }

    const protectionSourceChannel = reservedForOrderNo ? 'system_purchase' : 'system_redemption'
    upsertRedemptionSeatProtection(db, normalizedEmail, protectionSourceChannel)

    saveDatabase()
  } catch (error) {
    console.error('更新数据库时出错:', error)
    throw new RedemptionError(500, '兑换过程中出现错误，请重试')
  }

  let inviteResult = { success: false, message: '邀请功能未启用' }
  let syncedAccount = null
  let syncedUserCount = null
  let syncedInviteCount = null

  if (chatgptAccountId && accountToken) {
    inviteResult = await inviteUserToChatGPTTeam(normalizedEmail, accountData)

    if (!inviteResult.success) {
      console.error(`邀请用户 ${normalizedEmail} 失败:`, inviteResult.error)
    } else {
      console.log(`成功邀请用户 ${normalizedEmail} 加入账号 ${chatgptAccountId}`)
      try {
        const userSync = await syncAccountUserCount(accountId, {
          userListParams: { offset: 0, limit: 1, query: '' }
        })
        syncedAccount = userSync.account
        if (typeof userSync.syncedUserCount === 'number') {
          syncedUserCount = userSync.syncedUserCount
        }
      } catch (error) {
        console.warn('同步账号人数失败:', error)
      }

      try {
        const inviteSync = await syncAccountInviteCount(accountId, {
          inviteListParams: { offset: 0, limit: 1, query: '' }
        })
        syncedAccount = inviteSync.account || syncedAccount
        if (typeof inviteSync.inviteCount === 'number') {
          syncedInviteCount = inviteSync.inviteCount
        }
      } catch (error) {
        console.warn('同步邀请数量失败:', error)
      }
    }
  } else {
    console.log(`账号 ${accountEmail} 缺少 ChatGPT 认证信息，跳过邀请步骤`)
  }

  const resolvedUserCount = typeof syncedAccount?.userCount === 'number'
    ? syncedAccount.userCount
    : typeof syncedUserCount === 'number'
      ? syncedUserCount
      : currentUserCount
  const resolvedInviteCount = typeof syncedAccount?.inviteCount === 'number'
    ? syncedAccount.inviteCount
    : typeof syncedInviteCount === 'number'
      ? syncedInviteCount
      : null

  return {
    data: {
      accountEmail: accountEmail,
      userCount: resolvedUserCount,
      inviteStatus: inviteResult.success ? '邀请已发送' : '邀请未发送（需要手动添加）',
      inviteDetails: inviteResult.success ? inviteResult.response : inviteResult.error,
      message: `您已成功加入 GPT team账号${inviteResult.success ? '，邀请邮件已发送至您的邮箱' : '，请联系管理员手动添加'}`,
      inviteCount: resolvedInviteCount
    },
    metadata: {
      codeId,
      code: sanitizedCode,
      requestedChannel,
      accountEmail,
      accountId
    }
  }
}

// 获取兑换码（支持可选分页）
router.get('/', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const db = await getDatabase()

    const paginated =
      req.query.page != null ||
      req.query.pageSize != null ||
      req.query.search != null ||
      req.query.status != null

    if (!paginated) {
      const result = db.exec(`
        SELECT id, code, is_redeemed, redeemed_at, redeemed_by,
               account_email, channel, channel_name, created_at, updated_at,
               reserved_for_uid, reserved_for_username, reserved_for_entry_id, reserved_at,
               reserved_for_order_no, reserved_for_order_email, order_type
        FROM redemption_codes
        ORDER BY created_at DESC
      `)

      if (result.length === 0 || result[0].values.length === 0) {
        return res.json([])
      }

      return res.json(result[0].values.map(mapCodeRow))
    }

    const pageSizeMax = 200
    const pageSize = Math.min(pageSizeMax, Math.max(1, toInt(req.query.pageSize, 10)))
    const rawPage = Math.max(1, toInt(req.query.page, 1))
    const search = String(req.query.search || '').trim().toLowerCase()
    const status = String(req.query.status || 'all').trim().toLowerCase()

    const conditions = []
    const params = []

    if (status === 'redeemed') {
      conditions.push('is_redeemed = 1')
    } else if (status === 'unused' || status === 'unredeemed') {
      conditions.push('is_redeemed = 0')
    }

    if (search) {
      const keyword = `%${search}%`
      conditions.push(
        `
          (
            LOWER(code) LIKE ?
            OR LOWER(COALESCE(account_email, '')) LIKE ?
            OR LOWER(COALESCE(redeemed_by, '')) LIKE ?
            OR LOWER(COALESCE(reserved_for_username, '')) LIKE ?
            OR LOWER(COALESCE(channel, '')) LIKE ?
            OR LOWER(COALESCE(channel_name, '')) LIKE ?
          )
        `.trim()
      )
      params.push(keyword, keyword, keyword, keyword, keyword, keyword)
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = db.exec(
      `
        SELECT COUNT(*)
        FROM redemption_codes
        ${whereClause}
      `,
      params
    )
    const total = Number(countResult[0]?.values?.[0]?.[0] || 0)
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const page = total > 0 ? Math.min(rawPage, totalPages) : 1
    const offset = (page - 1) * pageSize

    const dataResult = db.exec(
      `
        SELECT id, code, is_redeemed, redeemed_at, redeemed_by,
               account_email, channel, channel_name, created_at, updated_at,
               reserved_for_uid, reserved_for_username, reserved_for_entry_id, reserved_at,
               reserved_for_order_no, reserved_for_order_email, order_type
        FROM redemption_codes
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
    )
    const codes = (dataResult[0]?.values || []).map(mapCodeRow)

    return res.json({
      codes,
      pagination: {
        page,
        pageSize,
        total
      }
    })
  } catch (error) {
    console.error('获取兑换码错误:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

router.post('/:id/reinvite', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const codeId = toInt(req.params.id, 0)
    if (!codeId) {
      return res.status(400).json({ error: '无效的兑换码 ID' })
    }

    return await withLocks([`redemption-code:reinvite:${codeId}`], async () => {
      const db = await getDatabase()
      const result = db.exec(
        `
          SELECT id, code, is_redeemed, redeemed_by, account_email, channel
          FROM redemption_codes
          WHERE id = ?
          LIMIT 1
        `,
        [codeId]
      )

      if (result.length === 0 || result[0].values.length === 0) {
        return res.status(404).json({ error: '兑换码不存在' })
      }

      const row = result[0].values[0]
      const isRedeemed = row[2] === 1
      const redeemedBy = row[3]
      const accountEmail = row[4]

      if (!isRedeemed) {
        return res.status(400).json({ error: '该兑换码尚未使用，无法重新邀请' })
      }

      const inviteEmail = extractEmailFromRedeemedBy(redeemedBy)
      if (!inviteEmail) {
        return res.status(400).json({ error: '兑换用户邮箱缺失，无法重新邀请' })
      }

      if (!accountEmail) {
        return res.status(400).json({ error: '该兑换码未绑定账号，无法重新邀请' })
      }

      const accountResult = db.exec(
        `
          SELECT id, email, token, chatgpt_account_id, oai_device_id
          FROM gpt_accounts
          WHERE lower(email) = ?
          LIMIT 1
        `,
        [normalizeEmail(accountEmail)]
      )

      if (accountResult.length === 0 || accountResult[0].values.length === 0) {
        return res.status(404).json({ error: '所属账号不存在，无法重新邀请' })
      }

      const accountRow = accountResult[0].values[0]
      const token = accountRow[2]
      const chatgptAccountId = accountRow[3]
      const oaiDeviceId = accountRow[4]

      if (!token || !chatgptAccountId) {
        return res.status(400).json({ error: '所属账号缺少 token 或 chatgpt_account_id，无法重新邀请' })
      }

      const inviteResult = await inviteUserToChatGPTTeam(inviteEmail, {
        token,
        chatgpt_account_id: chatgptAccountId,
        oai_device_id: oaiDeviceId
      })

      if (!inviteResult.success) {
        const errorMessage = typeof inviteResult.error === 'string' ? inviteResult.error : '重新邀请失败'
        return res.status(503).json({ error: errorMessage })
      }

      return res.json({ message: '重新邀请已发送' })
    })
  } catch (error) {
    console.error('重新邀请失败:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 批量创建兑换码
router.post('/batch', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const { count, accountEmail, channel } = req.body

    if (!count || count < 1 || count > 1000) {
      return res.status(400).json({ error: '数量必须在 1-1000 之间' })
    }

    // 必须指定账号
    if (!accountEmail) {
      return res.status(400).json({ error: '必须指定所属账号邮箱' })
    }

    const db = await getDatabase()

    // 检查账号是否存在并获取当前人数
    const accountResult = db.exec(`
      SELECT id, email, user_count FROM gpt_accounts WHERE email = ?
    `, [accountEmail])

    if (accountResult.length === 0 || accountResult[0].values.length === 0) {
      return res.status(404).json({ error: '指定的账号不存在' })
    }

    const accountRow = accountResult[0].values[0]
    const currentUserCount = accountRow[2] || 0

    // 如果账号已满员，不能创建兑换码
    if (currentUserCount >= SPACE_MEMBER_LIMIT) {
      return res.status(400).json({
        error: `该账号已满员（${SPACE_MEMBER_LIMIT}人），无法创建兑换码`,
        currentUserCount: currentUserCount
      })
    }

    // 获取该账号未使用的兑换码数量
    const unusedCodesResult = db.exec(`
      SELECT COUNT(*) as count FROM redemption_codes
      WHERE account_email = ? AND is_redeemed = 0
    `, [accountEmail])

    const unusedCodesCount = unusedCodesResult[0]?.values[0]?.[0] || 0

    // 计算实际可以生成的数量
    // 可创建数量 = 总容量(5) - 当前人数 - 未使用的兑换码数
    const availableSlots = calcRedeemableSlots(currentUserCount, SPACE_MEMBER_LIMIT) - unusedCodesCount

    if (availableSlots <= 0) {
      return res.status(400).json({
        error: '该账号已无可用名额（当前人数 + 未使用兑换码数已达上限）',
        currentUserCount: currentUserCount,
        unusedCodesCount: unusedCodesCount,
        allCodesCount: unusedCodesCount, // 兼容旧前端字段
        availableSlots: 0
      })
    }

    const actualCount = Math.min(count, availableSlots)

    // 如果请求数量超过可用名额，给出详细提示
    if (count > availableSlots) {
      console.log(`请求生成${count}个兑换码，但账号只有${availableSlots}个可用名额（当前${currentUserCount}人，已有${unusedCodesCount}个未使用兑换码），将只生成${actualCount}个`)
    }

    const normalizedChannel = normalizeChannel(channel)
    const resolvedChannelName = getChannelName(normalizedChannel)

    const createdCodes = []
    const failedCodes = []

    for (let i = 0; i < actualCount; i++) {
      let code = generateRedemptionCode()
      let attempts = 0
      let success = false

      // 尝试生成唯一的兑换码（最多重试4次）
      while (attempts < 4 && !success) {
        try {
          db.run(
            `INSERT INTO redemption_codes (code, account_email, channel, channel_name, created_at, updated_at) VALUES (?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
            [code, accountEmail, normalizedChannel, resolvedChannelName]
          )
          createdCodes.push(code)
          success = true
        } catch (err) {
          if (err.message.includes('UNIQUE')) {
            // 如果重复，重新生成
            code = generateRedemptionCode()
            attempts++
          } else {
            throw err
          }
        }
      }

      if (!success) {
        failedCodes.push(`尝试${attempts}次后仍然重复`)
      }
    }

    saveDatabase()

    // 获取新创建的兑换码
    const result = db.exec(`
      SELECT id, code, is_redeemed, redeemed_at, redeemed_by,
             account_email, channel, channel_name, created_at, updated_at,
             reserved_for_uid, reserved_for_username, reserved_for_entry_id, reserved_at,
             reserved_for_order_no, reserved_for_order_email, order_type
      FROM redemption_codes
      WHERE code IN (${createdCodes.map(() => '?').join(',')})
      ORDER BY created_at DESC
    `, createdCodes)

    const codes = result[0]?.values.map(mapCodeRow) || []

    res.status(201).json({
      message: `成功为账号 ${accountEmail} 创建 ${createdCodes.length} 个兑换码`,
      codes,
      failed: failedCodes.length,
      currentUserCount: currentUserCount,
      unusedCodesCount: unusedCodesCount + createdCodes.length,
      allCodesCount: unusedCodesCount + createdCodes.length, // 兼容旧前端字段
      availableSlots: availableSlots - createdCodes.length,
      info: count > availableSlots ? `由于账号可用名额限制（当前${currentUserCount}人 + ${unusedCodesCount}个未使用兑换码），只生成了${actualCount}个兑换码` : undefined
    })
  } catch (error) {
    console.error('批量创建兑换码错误:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 删除兑换码
router.delete('/:id', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const db = await getDatabase()

    // 检查兑换码是否存在
    const checkResult = db.exec('SELECT id FROM redemption_codes WHERE id = ?', [req.params.id])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: '兑换码不存在' })
    }

    db.run('DELETE FROM redemption_codes WHERE id = ?', [req.params.id])
    saveDatabase()

    res.json({ message: '兑换码删除成功' })
  } catch (error) {
    console.error('删除兑换码错误:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 更新兑换码渠道
router.patch('/:id/channel', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const { channel } = req.body

    if (!channel) {
      return res.status(400).json({ error: '请选择要更新的渠道' })
    }

    const normalizedChannel = normalizeChannel(channel)
    const channelName = getChannelName(normalizedChannel)

    const db = await getDatabase()
    const checkResult = db.exec('SELECT id FROM redemption_codes WHERE id = ?', [req.params.id])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: '兑换码不存在' })
    }

    db.run(
      `UPDATE redemption_codes SET channel = ?, channel_name = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
      [normalizedChannel, channelName, req.params.id]
    )
    saveDatabase()

    const updatedResult = db.exec(`
      SELECT id, code, is_redeemed, redeemed_at, redeemed_by,
             account_email, channel, channel_name, created_at, updated_at,
             reserved_for_uid, reserved_for_username, reserved_for_entry_id, reserved_at,
             reserved_for_order_no, reserved_for_order_email, order_type
      FROM redemption_codes
      WHERE id = ?
    `, [req.params.id])

    const updatedCode = updatedResult.length > 0 && updatedResult[0].values.length > 0
      ? mapCodeRow(updatedResult[0].values[0])
      : null

    res.json({
      message: '渠道已更新',
      code: updatedCode
    })
  } catch (error) {
    console.error('更新兑换码渠道失败:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 批量删除兑换码
router.post('/batch-delete', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const { ids } = req.body

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '请提供要删除的兑换码ID数组' })
    }

    const db = await getDatabase()
    const placeholders = ids.map(() => '?').join(',')

    db.run(`DELETE FROM redemption_codes WHERE id IN (${placeholders})`, ids)
    saveDatabase()

    res.json({ message: `成功删除 ${ids.length} 个兑换码` })
  } catch (error) {
    console.error('批量删除兑换码错误:', error)
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 管理后台兑换（需要认证）
router.post('/admin/redeem', authenticateToken, requireMenu('redemption_codes'), async (req, res) => {
  try {
    const { code, email, channel, redeemerUid, orderType, order_type: orderTypeLegacy } = req.body || {}
    const result = await redeemCodeInternal({
      code,
      email,
      channel,
      redeemerUid,
      orderType: orderType ?? orderTypeLegacy
    })
    res.json({
      message: '兑换成功',
      data: result.data
    })
  } catch (error) {
    if (error instanceof RedemptionError) {
      return res.status(error.statusCode || 400).json({
        error: error.message,
        message: error.message,
        ...(error.payload || {})
      })
    }
    console.error('管理后台兑换错误:', error)
    res.status(500).json({
      error: '内部服务器错误',
      message: '服务器错误，请稍后重试'
    })
  }
})

// 兑换接口（无需认证）
router.post('/redeem', async (req, res) => {
  try {
    const { code, email, channel, orderType, order_type: orderTypeLegacy } = req.body || {}
    const normalizedChannel = normalizeChannel(channel)

    let redeemerUid = req.body?.redeemerUid
    if (normalizedChannel === 'linux-do') {
      const decoded = verifyLinuxDoSessionToken(req.headers['x-linuxdo-token'])
      const uid = decoded?.uid ? String(decoded.uid).trim() : ''
      if (!uid) {
        return res.status(401).json({ error: '缺少 Linux DO session token', code: 'LINUXDO_SESSION_REQUIRED' })
      }
      redeemerUid = uid
    }

    const result = await redeemCodeInternal({
      code,
      email,
      channel: normalizedChannel,
      redeemerUid,
      orderType: orderType ?? orderTypeLegacy
    })
    res.json({
      message: '兑换成功',
      data: result.data
    })
  } catch (error) {
    if (error instanceof RedemptionError) {
      return res.status(error.statusCode || 400).json({
        error: error.message,
        message: error.message,
        ...(error.payload || {})
      })
    }
    console.error('兑换错误:', error)
    res.status(500).json({
      error: '内部服务器错误',
      message: '服务器错误，请稍后重试'
    })
  }
})

// 账号补录（无需认证）
router.post('/recover', async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body?.email)
    if (!normalizedEmail) {
      return res.status(400).json({ error: '请输入邮箱地址', message: '请输入邮箱地址' })
    }

    if (!EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址', message: '请输入有效的邮箱地址' })
    }

    return await withLocks([`account-recovery:${normalizedEmail}`], async () => {
      const db = await getDatabase()
      const emailPattern = `%email:${normalizedEmail}%`

      const threshold = `-${ACCOUNT_RECOVERY_WINDOW_DAYS} days`
      const candidatesResult = db.exec(
        `
          WITH candidates AS (
            SELECT
              rc.id AS original_code_id,
              rc.redeemed_at AS original_redeemed_at,
              rc.redeemed_by AS original_redeemed_by,
              rc.account_email AS original_account_email,
              rc.channel AS original_channel,
              COALESCE(
                NULLIF((
                  SELECT po2.order_type
                  FROM purchase_orders po2
                  WHERE (po2.code_id = rc.id OR (po2.code_id IS NULL AND po2.code = rc.code))
                  ORDER BY po2.created_at DESC
                  LIMIT 1
                ), ''),
                NULLIF(rc.order_type, ''),
                'warranty'
              ) AS order_type,
              (
                SELECT ar.recovery_account_email
                FROM account_recovery_logs ar
                WHERE ar.original_code_id = rc.id
                  AND ar.status IN ('success', 'skipped')
                ORDER BY ar.id DESC
                LIMIT 1
              ) AS last_completed_recovery_account_email,
              (
                SELECT COUNT(1)
                FROM account_recovery_logs ar2
                WHERE ar2.original_code_id = rc.id
              ) AS attempts,
              co.status AS credit_order_status,
              co.refunded_at AS credit_order_refunded_at
            FROM redemption_codes rc
            LEFT JOIN credit_orders co
              ON co.order_no = rc.reserved_for_order_no
              AND co.scene = 'open_accounts_board'
            LEFT JOIN account_recovery_logs ar_recovery
              ON ar_recovery.recovery_code_id = rc.id
              AND ar_recovery.status IN ('success', 'skipped')
            WHERE rc.is_redeemed = 1
              AND rc.redeemed_at IS NOT NULL
              AND rc.redeemed_at >= DATETIME('now', 'localtime', ?)
              AND ar_recovery.id IS NULL
              AND (
                lower(rc.redeemed_by) = ?
                OR lower(rc.redeemed_by) LIKE ?
              )
          ),
          candidates_with_current AS (
            SELECT
              c.*,
              COALESCE(NULLIF(lower(c.last_completed_recovery_account_email), ''), lower(c.original_account_email)) AS current_account_email
            FROM candidates c
          )
          SELECT
            cw.original_code_id,
            cw.original_redeemed_at,
            cw.original_redeemed_by,
            cw.original_account_email,
            cw.original_channel,
            cw.order_type,
            cw.last_completed_recovery_account_email,
            cw.attempts,
            cw.current_account_email,
            ga.id AS current_account_id,
            ga.email AS current_account_record_email,
            COALESCE(ga.is_banned, 0) AS current_is_banned,
            cw.credit_order_status,
            cw.credit_order_refunded_at
          FROM candidates_with_current cw
          LEFT JOIN gpt_accounts ga ON lower(ga.email) = cw.current_account_email
          ORDER BY cw.original_redeemed_at ASC, cw.original_code_id ASC
        `,
        [threshold, normalizedEmail, emailPattern]
      )

      const candidateRows = candidatesResult[0]?.values || []
      if (candidateRows.length === 0) {
        return res.status(404).json({
          error: `${ACCOUNT_RECOVERY_WINDOW_DAYS}天内不存在订单，请联系客服`,
          message: `${ACCOUNT_RECOVERY_WINDOW_DAYS}天内不存在订单，请联系客服`,
          code: 'NO_RECENT_ORDER'
        })
      }

      const candidates = candidateRows.map(row => ({
        originalCodeId: Number(row[0]),
        originalRedeemedAt: row[1] ? String(row[1]) : null,
        originalRedeemedBy: row[2] ? String(row[2]) : null,
        originalAccountEmail: row[3] ? String(row[3]) : null,
        originalChannel: row[4] ? String(row[4]) : null,
        orderType: row[5] ? String(row[5]) : null,
        lastCompletedRecoveryAccountEmail: row[6] ? String(row[6]) : null,
        attempts: Number(row[7] || 0),
        currentAccountEmail: row[8] ? String(row[8]) : '',
        currentAccountId: row[9] != null ? Number(row[9]) : null,
        currentAccountRecordEmail: row[10] ? String(row[10]) : null,
        currentIsBanned: Number(row[11] || 0) === 1,
        creditOrderStatus: row[12] ? String(row[12]) : null,
        creditOrderRefundedAt: row[13] ? String(row[13]) : null
      }))

      const eligibleCandidates = candidates.filter(candidate => !isNoWarrantyOrderType(candidate.orderType))

      if (eligibleCandidates.length === 0) {
        return res.status(403).json({
          error: '无质保订单不支持补号',
          message: '无质保订单不支持补号',
          code: 'NO_WARRANTY_ORDER'
        })
      }

      const refundableCandidates = eligibleCandidates.filter(candidate => {
        if (candidate.creditOrderRefundedAt) return false
        const status = String(candidate.creditOrderStatus || '').trim().toLowerCase()
        return status !== 'refunded'
      })

      if (refundableCandidates.length === 0) {
        const firstCandidate = eligibleCandidates[0]
        const windowEndsAt = buildRecoveryWindowEndsAt(firstCandidate.originalRedeemedAt)
        return res.status(403).json({
          error: 'Credit 订单已退款，无法补录，请联系客服',
          message: 'Credit 订单已退款，无法补录，请联系客服',
          code: 'CREDIT_ORDER_REFUNDED',
          processedOriginalCodeId: firstCandidate.originalCodeId,
          processedOriginalRedeemedAt: firstCandidate.originalRedeemedAt,
          processedReason: 'credit_order_refunded',
          windowEndsAt
        })
      }

      const firstCandidate = refundableCandidates[0]
      let targetCandidate = refundableCandidates.find(candidate => candidate.currentIsBanned) || null
      let processedReason = targetCandidate ? 'banned' : ''

      const accessCache = new Map()
      let unknownSyncError = null

      if (!targetCandidate) {
        for (const candidate of refundableCandidates) {
          const accountId = candidate.currentAccountId
          if (!candidate.currentAccountEmail || !accountId) {
            targetCandidate = candidate
            processedReason = 'missing_account'
            break
          }

          const cached = accessCache.get(accountId)
          if (cached?.status === 'accessible') continue
          if (cached?.status === 'access_failure') {
            targetCandidate = candidate
            processedReason = 'access_failure'
            break
          }
          if (cached?.status === 'unknown') {
            if (!unknownSyncError) {
              unknownSyncError = { error: cached.error, statusCode: cached.statusCode, candidate }
            }
            continue
          }

          try {
            const syncResult = await syncAccountUserCount(accountId, {
              userListParams: { offset: 0, limit: 1, query: '' }
            })
            const userCount = syncResult.account?.userCount ?? syncResult.syncedUserCount ?? null
            accessCache.set(accountId, { status: 'accessible', userCount })
          } catch (error) {
            if (isAccountAccessFailure(error)) {
              accessCache.set(accountId, { status: 'access_failure', error })
              targetCandidate = candidate
              processedReason = 'access_failure'
              break
            }
            const statusCode = Number(error?.status ?? error?.statusCode) || 503
            accessCache.set(accountId, { status: 'unknown', error, statusCode })
            if (!unknownSyncError) {
              unknownSyncError = { error, statusCode, candidate }
            }
          }
        }
      }

      if (!targetCandidate) {
        if (unknownSyncError) {
          const candidate = unknownSyncError.candidate || firstCandidate
          const windowEndsAt = buildRecoveryWindowEndsAt(candidate.originalRedeemedAt)
          const status = Number(unknownSyncError.statusCode) || 503
          const message = unknownSyncError.error?.message || '账号同步失败，请稍后再试'

          recordAccountRecovery(db, {
            email: normalizedEmail,
            originalCodeId: candidate.originalCodeId,
            originalRedeemedAt: candidate.originalRedeemedAt,
            originalAccountEmail: candidate.originalAccountEmail,
            recoveryMode: 'original',
            recoveryAccountEmail: candidate.currentAccountRecordEmail || candidate.currentAccountEmail,
            status: 'failed',
            errorMessage: unknownSyncError.error?.message || '账号同步失败'
          })
          saveDatabase()

          return res.status(status).json({
            error: message,
            message,
            processedOriginalCodeId: candidate.originalCodeId,
            processedOriginalRedeemedAt: candidate.originalRedeemedAt,
            processedReason: 'sync_error',
            windowEndsAt
          })
        }

        const windowEndsAt = buildRecoveryWindowEndsAt(firstCandidate.originalRedeemedAt)
        const accountEmail = firstCandidate.currentAccountRecordEmail || firstCandidate.currentAccountEmail
        const cachedAccess = firstCandidate.currentAccountId ? accessCache.get(firstCandidate.currentAccountId) : null
        const userCount = cachedAccess?.status === 'accessible' ? cachedAccess.userCount ?? null : null

        recordAccountRecovery(db, {
          email: normalizedEmail,
          originalCodeId: firstCandidate.originalCodeId,
          originalRedeemedAt: firstCandidate.originalRedeemedAt,
          originalAccountEmail: firstCandidate.originalAccountEmail,
          recoveryMode: 'not-needed',
          recoveryAccountEmail: accountEmail,
          status: 'skipped',
          errorMessage: 'account_accessible'
        })
        saveDatabase()

        return res.json({
          message: '当前工作空间仍可访问，无需补录',
          data: {
            accountEmail,
            userCount,
            recoveryMode: 'not-needed',
            windowEndsAt,
            processedOriginalCodeId: firstCandidate.originalCodeId,
            processedOriginalRedeemedAt: firstCandidate.originalRedeemedAt,
            processedReason: 'all_accessible'
          }
        })
      }

      const originalCodeId = targetCandidate.originalCodeId
      const redeemedAt = targetCandidate.originalRedeemedAt
      const originalAccountEmail = targetCandidate.originalAccountEmail
      const windowEndsAt = buildRecoveryWindowEndsAt(redeemedAt)

      // 自助补号账号池：
      // 1) 优先：七天内创建的未开放账号（is_open = 0）
      // 2) 兜底：当天创建的开放账号（is_open = 1）
      const recoveryCodeResult = db.exec(
        `
          SELECT rc.id, rc.code, rc.channel, rc.account_email
          FROM redemption_codes rc
          JOIN gpt_accounts ga ON lower(ga.email) = lower(rc.account_email)
          WHERE rc.is_redeemed = 0
            AND rc.account_email IS NOT NULL
            AND COALESCE(ga.user_count, 0) + COALESCE(ga.invite_count, 0) < 5
            AND COALESCE(ga.is_banned, 0) = 0
            AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
            AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
            AND (
              (
                COALESCE(ga.is_open, 0) = 0
                AND DATE(ga.created_at) >= DATE('now', 'localtime', '-7 day')
              )
              OR (
                ga.is_open = 1
                AND DATE(ga.created_at) = DATE('now', 'localtime')
              )
            )
          ORDER BY
            CASE
              WHEN COALESCE(ga.is_open, 0) = 0 AND DATE(ga.created_at) >= DATE('now', 'localtime', '-7 day') THEN 0
              ELSE 1
            END ASC,
            ga.created_at DESC,
            rc.created_at DESC
          LIMIT 1
        `
      )

      if (recoveryCodeResult.length === 0 || recoveryCodeResult[0].values.length === 0) {
        recordAccountRecovery(db, {
          email: normalizedEmail,
          originalCodeId,
          originalRedeemedAt: redeemedAt,
          originalAccountEmail,
          recoveryMode: 'open-account',
          status: 'failed',
          errorMessage: '暂无可用补号账号兑换码'
        })
        saveDatabase()
        return res.status(503).json({
          error: '暂无可用补号账号，请稍后再试或联系客服',
          message: '暂无可用补号账号，请稍后再试或联系客服',
          processedOriginalCodeId: originalCodeId,
          processedOriginalRedeemedAt: redeemedAt,
          processedReason,
          windowEndsAt
        })
      }

      const [recoveryCodeId, recoveryCode, recoveryChannel, recoveryAccountEmail] = recoveryCodeResult[0].values[0]
      const skipCodeFormatValidation = String(recoveryChannel || '').trim().toLowerCase() === 'xhs'

      try {
        const redemptionResult = await redeemCodeInternal({
          code: recoveryCode,
          email: normalizedEmail,
          channel: recoveryChannel || 'common',
          skipCodeFormatValidation
        })

        recordAccountRecovery(db, {
          email: normalizedEmail,
          originalCodeId,
          originalRedeemedAt: redeemedAt,
          originalAccountEmail,
          recoveryMode: 'open-account',
          recoveryCodeId,
          recoveryCode,
          recoveryAccountEmail: redemptionResult.metadata?.accountEmail || recoveryAccountEmail,
          status: 'success'
        })
        saveDatabase()

        return res.json({
          message: '补录成功',
          data: {
            accountEmail: redemptionResult.data.accountEmail,
            userCount: redemptionResult.data.userCount,
            inviteStatus: redemptionResult.data.inviteStatus,
            recoveryMode: 'open-account',
            windowEndsAt,
            processedOriginalCodeId: originalCodeId,
            processedOriginalRedeemedAt: redeemedAt,
            processedReason
          }
        })
      } catch (error) {
        const statusCode = error instanceof RedemptionError ? error.statusCode || 400 : 500
        recordAccountRecovery(db, {
          email: normalizedEmail,
          originalCodeId,
          originalRedeemedAt: redeemedAt,
          originalAccountEmail,
          recoveryMode: 'open-account',
          recoveryCodeId,
          recoveryCode,
          recoveryAccountEmail,
          status: 'failed',
          errorMessage: error?.message || '补录失败'
        })
        saveDatabase()
        return res.status(statusCode).json({
          error: error?.message || '补录失败，请稍后再试',
          message: error?.message || '补录失败，请稍后再试',
          processedOriginalCodeId: originalCodeId,
          processedOriginalRedeemedAt: redeemedAt,
          processedReason,
          windowEndsAt
        })
      }
    })
  } catch (error) {
    console.error('补录处理失败:', error)
    res.status(500).json({ error: '服务器错误，请稍后再试', message: '服务器错误，请稍后再试' })
  }
})

router.post('/xhs/search-order', requireFeatureEnabled('xhs'), async (req, res) => {
  try {
    const { orderNumber } = req.body || {}
    const normalizedOrderNumber = normalizeXhsOrderNumber(orderNumber)

    if (!normalizedOrderNumber) {
      return res.status(400).json({ error: '请输入有效的小红书订单号' })
    }

    const config = await getXhsConfig()
    if (!config?.authorization) {
      return res.status(503).json({ error: '请先在管理后台配置 Authorization（推荐粘贴 curl 命令）' })
    }
    if (!config?.cookies) {
      return res.status(503).json({ error: '请先在管理后台配置 Cookie（推荐粘贴 curl 命令）' })
    }

    const existingOrder = await getXhsOrderByNumber(normalizedOrderNumber)
    if (existingOrder) {
      return res.json({
        message: '订单已同步',
        order: existingOrder,
        synced: false
      })
    }

    if (isXhsSyncing()) {
      return res.status(409).json({ error: '同步任务正在运行，请稍后再试' })
    }

    let syncResult
    setXhsSyncing(true)
    try {
      syncResult = await syncOrdersFromApi({
        authorization: config.authorization,
        cookies: config.cookies,
        extraHeaders: config.extraHeaders || {},
        searchKeyword: normalizedOrderNumber,
        pageSize: 20,
        maxPages: 1,
      })
    } finally {
      setXhsSyncing(false)
    }

    await recordXhsSyncResult({ success: true })

    const syncedOrder = await getXhsOrderByNumber(normalizedOrderNumber)
    if (!syncedOrder) {
      return res.status(404).json({ error: '未找到对应订单，请确认订单号是否正确' })
    }

    return res.json({
      message: '订单同步完成',
      order: syncedOrder,
      synced: true,
      importResult: {
        created: syncResult.created,
        skipped: syncResult.skipped,
        total: syncResult.totalFetched,
      }
    })
  } catch (error) {
    console.error('[XHS Search Sync] 请求处理失败:', error)
    await recordXhsSyncResult({ success: false, error: error?.message || '同步失败' }).catch(() => {})
    res.status(500).json({ error: error?.message || '服务器错误，请稍后再试' })
  }
})

router.post('/xhs/check-order', requireFeatureEnabled('xhs'), async (req, res) => {
  try {
    const { orderNumber } = req.body || {}
    const normalizedOrderNumber = normalizeXhsOrderNumber(orderNumber)

    if (!normalizedOrderNumber) {
      return res.status(400).json({ error: '请输入有效的小红书订单号' })
    }

    const orderRecord = await getXhsOrderByNumber(normalizedOrderNumber)
    res.json({
      order: orderRecord,
      found: Boolean(orderRecord),
    })
  } catch (error) {
    console.error('[XHS Check Order] 请求失败:', error)
    res.status(500).json({ error: '查询订单失败，请稍后再试' })
  }
})

router.post('/xhs/redeem-order', requireFeatureEnabled('xhs'), async (req, res) => {
  try {
    const { email, orderNumber, strictToday } = req.body || {}
    const trimmedEmail = (email || '').trim()
    const normalizedEmail = normalizeEmail(trimmedEmail)

    if (!normalizedEmail) {
      return res.status(400).json({ error: '请输入邮箱地址' })
    }

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' })
    }

    const normalizedOrderNumber = normalizeXhsOrderNumber(orderNumber)
    if (!normalizedOrderNumber) {
      return res.status(400).json({ error: '请输入有效的小红书订单号' })
    }

    await withLocks([`xhs-redeem`, `xhs-order:${normalizedOrderNumber}`], async () => {
	      const orderRecord = await getXhsOrderByNumber(normalizedOrderNumber)
	      if (!orderRecord) {
	        return res.status(404).json({ error: '未找到对应订单，请稍后再试' })
	      }

	      if (orderRecord.isUsed) {
	        return res.status(400).json({ error: '该订单已完成兑换' })
	      }

	      if (String(orderRecord.orderStatus || '').trim() === '已关闭') {
	        return res.status(403).json({ error: '该订单已完成售后退款（已关闭），无法进行核销' })
	      }

	      const db = await getDatabase()
	      const now = new Date()
	      const fallbackToYesterdayEnabled = !Boolean(strictToday) && now.getHours() >= 0 && now.getHours() < 8

		      const availableCodeResult = db.exec(
		        `
		          SELECT rc.id, rc.code, rc.created_at
		          FROM redemption_codes rc
		          WHERE rc.channel = 'xhs'
		            AND rc.is_redeemed = 0
		            AND DATE(rc.created_at) = DATE('now', 'localtime')
                AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
		            AND (
		              rc.account_email IS NULL
		              OR EXISTS (
		                SELECT 1
		                FROM gpt_accounts ga
	                WHERE lower(ga.email) = lower(rc.account_email)
	                  	              )
	            )
	          ORDER BY rc.created_at ASC
	          LIMIT 1
	        `
	      )

      let selectedCodeRow = availableCodeResult?.[0]?.values?.[0] || null

      if (!selectedCodeRow && fallbackToYesterdayEnabled) {
		        const fallbackCodeResult = db.exec(
		          `
		            SELECT rc.id, rc.code, rc.created_at
		            FROM redemption_codes rc
		            WHERE rc.channel = 'xhs'
		              AND rc.is_redeemed = 0
		              AND DATE(rc.created_at) = DATE('now', 'localtime', '-1 day')
                  AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                  AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                  AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
		              AND (
		                rc.account_email IS NULL
		                OR EXISTS (
		                  SELECT 1
	                  FROM gpt_accounts ga
	                  WHERE lower(ga.email) = lower(rc.account_email)
	                    	                )
	              )
	            ORDER BY rc.created_at ASC
	            LIMIT 1
	          `
	        )
	        selectedCodeRow = fallbackCodeResult?.[0]?.values?.[0] || null
	      }

        if (!selectedCodeRow) {
          const commonFallback = await withLocks(['redemption-codes:pool:common'], async () => {
            const commonCodeResult = db.exec(
              `
                SELECT rc.id, rc.code, rc.created_at
                FROM redemption_codes rc
                WHERE rc.channel = 'common'
                  AND rc.is_redeemed = 0
                  AND DATE(rc.created_at) = DATE('now', 'localtime')
                  AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                  AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                  AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                  AND (
                    rc.account_email IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM gpt_accounts ga
                      WHERE lower(ga.email) = lower(rc.account_email)
                                            )
                  )
                ORDER BY rc.created_at ASC
                LIMIT 1
              `
            )
            let commonCodeRow = commonCodeResult?.[0]?.values?.[0] || null

            if (!commonCodeRow && fallbackToYesterdayEnabled) {
              const commonYesterdayResult = db.exec(
                `
                  SELECT rc.id, rc.code, rc.created_at
                  FROM redemption_codes rc
                  WHERE rc.channel = 'common'
                    AND rc.is_redeemed = 0
                    AND DATE(rc.created_at) = DATE('now', 'localtime', '-1 day')
                    AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                    AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                    AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                    AND (
                      rc.account_email IS NULL
                      OR EXISTS (
                        SELECT 1
                        FROM gpt_accounts ga
                        WHERE lower(ga.email) = lower(rc.account_email)
                                                )
                    )
                  ORDER BY rc.created_at ASC
                  LIMIT 1
                `
              )
              commonCodeRow = commonYesterdayResult?.[0]?.values?.[0] || null
            }

            if (!commonCodeRow) return null

            const selectedCodeId = commonCodeRow[0]
            const selectedCode = commonCodeRow[1]

            const redemptionResult = await redeemCodeInternal({
              code: selectedCode,
              email: normalizedEmail,
              channel: 'xhs',
              skipCodeFormatValidation: true,
              allowCommonChannelFallback: true
            })

            await markXhsOrderRedeemed(orderRecord.id, selectedCodeId, selectedCode, normalizedEmail)

            return { selectedCodeId, selectedCode, redemptionResult }
          })

          if (commonFallback) {
            return res.json({
              message: '兑换成功',
              data: commonFallback.redemptionResult.data,
              order: {
                ...orderRecord,
                status: 'redeemed',
                isUsed: true,
                userEmail: normalizedEmail,
                assignedCodeId: commonFallback.selectedCodeId,
                assignedCode: commonFallback.selectedCode,
              }
            })
          }
        }

      if (!selectedCodeRow) {
	        const statsResult = db.exec(
	          `
	            SELECT
	              COUNT(*) as all_total,
	              SUM(CASE WHEN is_redeemed = 0 THEN 1 ELSE 0 END) as all_unused,
	              SUM(CASE WHEN DATE(created_at) = DATE('now', 'localtime') THEN 1 ELSE 0 END) as today_total,
	              SUM(CASE WHEN is_redeemed = 0 AND DATE(created_at) = DATE('now', 'localtime') THEN 1 ELSE 0 END) as today_unused
	            FROM redemption_codes rc
	            WHERE rc.channel = 'xhs'
	              AND (
	                rc.account_email IS NULL
	                OR EXISTS (
	                  SELECT 1
	                  FROM gpt_accounts ga
	                  WHERE lower(ga.email) = lower(rc.account_email)
	                    	                )
	              )
	          `
	        )
        const statsRow = statsResult?.[0]?.values?.[0] || []
        const allTotal = Number(statsRow[0] || 0)
        const todayTotal = Number(statsRow[2] || 0)
        const todayUnused = Number(statsRow[3] || 0)

	        const errorCode = allTotal === 0
	          ? 'xhs_codes_not_configured'
	          : (todayTotal <= 0 ? 'xhs_no_today_codes' : (todayUnused <= 0 ? 'xhs_today_codes_exhausted' : 'xhs_codes_unavailable'))

	        return res.status(503).json({ error: OUT_OF_STOCK_MESSAGE, errorCode })
	      }

      const selectedCodeId = selectedCodeRow[0]
      const selectedCode = selectedCodeRow[1]

      const redemptionResult = await redeemCodeInternal({
        code: selectedCode,
        email: normalizedEmail,
        channel: 'xhs',
        skipCodeFormatValidation: true,
        allowCommonChannelFallback: true
      })

      await markXhsOrderRedeemed(orderRecord.id, selectedCodeId, selectedCode, normalizedEmail)

      return res.json({
        message: '兑换成功',
        data: redemptionResult.data,
        order: {
          ...orderRecord,
          status: 'redeemed',
          isUsed: true,
          userEmail: normalizedEmail,
          assignedCodeId: selectedCodeId,
          assignedCode: selectedCode,
        }
      })
    })
  } catch (error) {
    if (error instanceof RedemptionError) {
      return res.status(error.statusCode || 400).json({
        error: error.message,
        message: error.message,
        ...(error.payload || {})
      })
    }
    console.error('[XHS Redeem] 兑换错误:', error)
    res.status(500).json({ error: '服务器错误，请稍后重试' })
  }
})

router.post('/xianyu/search-order', requireFeatureEnabled('xianyu'), async (req, res) => {
  try {
    const { orderId } = req.body || {}
    const normalizedOrderId = normalizeXianyuOrderId(orderId)

    if (!normalizedOrderId) {
      return res.status(400).json({ error: '请输入有效的闲鱼订单号' })
    }

    const config = await getXianyuConfig()
    if (!config?.cookies) {
      return res.status(503).json({ error: '请先在管理后台配置 Cookie' })
    }

    const existingOrder = await getXianyuOrderById(normalizedOrderId)
    if (existingOrder) {
      return res.json({
        message: '订单已同步',
        order: existingOrder,
        synced: false
      })
    }

    const apiResult = await queryXianyuOrderDetailFromApi({
      orderId: normalizedOrderId,
      cookies: config.cookies,
    })
    if (apiResult.cookiesUpdated) {
      await updateXianyuConfig({ cookies: apiResult.cookies })
    }

    const order = transformXianyuApiOrder(apiResult.raw, normalizedOrderId)
    if (!order?.orderId) {
      return res.status(502).json({ error: '订单详情解析失败，请确认订单号是否正确' })
    }
    const orderForImport = transformXianyuApiOrderForImport(order)
    if (!orderForImport?.orderId) {
      return res.status(502).json({ error: '订单详情解析失败，无法写入数据库' })
    }
    const importResult = await importXianyuOrders(orderForImport ? [orderForImport] : [])

    await recordXianyuSyncResult({ success: true })

    const syncedOrder = await getXianyuOrderById(normalizedOrderId)
    if (!syncedOrder) {
      return res.status(404).json({ error: '未找到对应订单，请确认订单号是否正确' })
    }

    return res.json({
      message: '订单同步完成',
      order: syncedOrder,
      synced: true,
      importResult
    })
  } catch (error) {
    console.error('[Xianyu Search Sync] 请求处理失败:', error)
    await recordXianyuSyncResult({ success: false, error: error?.message || '同步失败' }).catch(() => {})
    res.status(500).json({ error: error?.message || '服务器错误，请稍后再试' })
  }
})

router.post('/xianyu/check-order', requireFeatureEnabled('xianyu'), async (req, res) => {
  try {
    const { orderId } = req.body || {}
    const normalizedOrderId = normalizeXianyuOrderId(orderId)

    if (!normalizedOrderId) {
      return res.status(400).json({ error: '请输入有效的闲鱼订单号' })
    }

    const orderRecord = await getXianyuOrderById(normalizedOrderId)
    res.json({
      order: orderRecord,
      found: Boolean(orderRecord),
    })
  } catch (error) {
    console.error('[Xianyu Check Order] 请求失败:', error)
    res.status(500).json({ error: '查询订单失败，请稍后再试' })
  }
})

router.post('/xianyu/redeem-order', requireFeatureEnabled('xianyu'), async (req, res) => {
  try {
    const { email, orderId, strictToday } = req.body || {}
    const trimmedEmail = (email || '').trim()
    const normalizedEmail = normalizeEmail(trimmedEmail)

    if (!normalizedEmail) {
      return res.status(400).json({ error: '请输入邮箱地址' })
    }

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' })
    }

    const normalizedOrderId = normalizeXianyuOrderId(orderId)
    if (!normalizedOrderId) {
      return res.status(400).json({ error: '请输入有效的闲鱼订单号' })
    }

    await withLocks([`xianyu-redeem`, `xianyu-order:${normalizedOrderId}`], async () => {
      const orderRecord = await getXianyuOrderById(normalizedOrderId)
      if (!orderRecord) {
        return res.status(404).json({ error: '未找到对应订单，请稍后再试' })
      }

      if (orderRecord.isUsed) {
        return res.status(400).json({ error: '该订单已完成兑换' })
      }

      if (String(orderRecord.orderStatus || '').includes('关闭')) {
        return res.status(403).json({ error: '该订单已关闭，无法进行核销' })
      }

      const db = await getDatabase()
      const now = new Date()
      const fallbackToYesterdayEnabled = !Boolean(strictToday) && now.getHours() >= 0 && now.getHours() < 8
      const resolvedOrderType = resolveXianyuOrderTypeFromActualPaid(orderRecord.actualPaid)
      const orderTypeLabel = isNoWarrantyOrderType(resolvedOrderType) ? '无质保' : '质保'

	      const availableCodeResult = db.exec(
	        `
	          SELECT rc.id, rc.code, rc.created_at
	          FROM redemption_codes rc
	          WHERE rc.channel = 'xianyu'
	            AND rc.is_redeemed = 0
	            AND DATE(rc.created_at) = DATE('now', 'localtime')
              AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
              AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
              AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
	            AND (
	              rc.account_email IS NULL
	              OR EXISTS (
	                SELECT 1
                FROM gpt_accounts ga
                WHERE lower(ga.email) = lower(rc.account_email)
                                )
            )
          ORDER BY rc.created_at ASC
          LIMIT 1
        `
      )

      let selectedCodeRow = availableCodeResult?.[0]?.values?.[0] || null

      if (!selectedCodeRow && fallbackToYesterdayEnabled) {
	        const fallbackCodeResult = db.exec(
	          `
	            SELECT rc.id, rc.code, rc.created_at
	            FROM redemption_codes rc
	            WHERE rc.channel = 'xianyu'
	              AND rc.is_redeemed = 0
	              AND DATE(rc.created_at) = DATE('now', 'localtime', '-1 day')
                AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
	              AND (
	                rc.account_email IS NULL
	                OR EXISTS (
	                  SELECT 1
                  FROM gpt_accounts ga
                  WHERE lower(ga.email) = lower(rc.account_email)
                                    )
              )
            ORDER BY rc.created_at ASC
            LIMIT 1
          `
        )
	        selectedCodeRow = fallbackCodeResult?.[0]?.values?.[0] || null
	      }

        if (!selectedCodeRow) {
          const commonFallback = await withLocks(['redemption-codes:pool:common'], async () => {
            const commonCodeResult = db.exec(
              `
                SELECT rc.id, rc.code, rc.created_at
                FROM redemption_codes rc
                WHERE rc.channel = 'common'
                  AND rc.is_redeemed = 0
                  AND DATE(rc.created_at) = DATE('now', 'localtime')
                  AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                  AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                  AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                  AND (
                    rc.account_email IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM gpt_accounts ga
                      WHERE lower(ga.email) = lower(rc.account_email)
                                            )
                  )
                ORDER BY rc.created_at ASC
                LIMIT 1
              `
            )
            let commonCodeRow = commonCodeResult?.[0]?.values?.[0] || null

            if (!commonCodeRow && fallbackToYesterdayEnabled) {
              const commonYesterdayResult = db.exec(
                `
                  SELECT rc.id, rc.code, rc.created_at
                  FROM redemption_codes rc
                  WHERE rc.channel = 'common'
                    AND rc.is_redeemed = 0
                    AND DATE(rc.created_at) = DATE('now', 'localtime', '-1 day')
                    AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
                    AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
                    AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
                    AND (
                      rc.account_email IS NULL
                      OR EXISTS (
                        SELECT 1
                        FROM gpt_accounts ga
                        WHERE lower(ga.email) = lower(rc.account_email)
                                                )
                    )
                  ORDER BY rc.created_at ASC
                  LIMIT 1
                `
              )
              commonCodeRow = commonYesterdayResult?.[0]?.values?.[0] || null
            }

            if (!commonCodeRow) return null

            const selectedCodeId = commonCodeRow[0]
            const selectedCode = commonCodeRow[1]

            const redemptionResult = await redeemCodeInternal({
              code: selectedCode,
              email: normalizedEmail,
              channel: 'xianyu',
              orderType: resolvedOrderType,
              skipCodeFormatValidation: true,
              allowCommonChannelFallback: true
            })

            await markXianyuOrderRedeemed(orderRecord.id, selectedCodeId, selectedCode, normalizedEmail)

            return { selectedCodeId, selectedCode, redemptionResult }
          })

          if (commonFallback) {
            return res.json({
              message: '兑换成功',
              data: commonFallback.redemptionResult.data,
              order: {
                ...orderRecord,
                status: 'redeemed',
                isUsed: true,
                userEmail: normalizedEmail,
                assignedCodeId: commonFallback.selectedCodeId,
                assignedCode: commonFallback.selectedCode,
              }
            })
          }
        }

	      if (!selectedCodeRow) {
	        const statsResult = db.exec(
	          `
	            SELECT
              COUNT(*) as all_total,
              SUM(CASE WHEN is_redeemed = 0 THEN 1 ELSE 0 END) as all_unused,
              SUM(CASE WHEN DATE(created_at) = DATE('now', 'localtime') THEN 1 ELSE 0 END) as today_total,
              SUM(CASE WHEN is_redeemed = 0 AND DATE(created_at) = DATE('now', 'localtime') THEN 1 ELSE 0 END) as today_unused
            FROM redemption_codes rc
            WHERE rc.channel = 'xianyu'
              AND (
                rc.account_email IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM gpt_accounts ga
                  WHERE lower(ga.email) = lower(rc.account_email)
                                    )
              )
          `
        )
        const statsRow = statsResult?.[0]?.values?.[0] || []
        const allTotal = Number(statsRow[0] || 0)
        const todayTotal = Number(statsRow[2] || 0)
        const todayUnused = Number(statsRow[3] || 0)

	        const errorCode = allTotal === 0
	          ? 'xianyu_codes_not_configured'
	          : (todayTotal <= 0 ? 'xianyu_no_today_codes' : (todayUnused <= 0 ? 'xianyu_today_codes_exhausted' : 'xianyu_codes_unavailable'))

	        return res.status(503).json({ error: OUT_OF_STOCK_MESSAGE, errorCode })
	      }

      const selectedCodeId = selectedCodeRow[0]
      const selectedCode = selectedCodeRow[1]

	      const redemptionResult = await redeemCodeInternal({
	        code: selectedCode,
	        email: normalizedEmail,
	        channel: 'xianyu',
	        orderType: resolvedOrderType,
	        skipCodeFormatValidation: true,
          allowCommonChannelFallback: true
	      })

      await markXianyuOrderRedeemed(orderRecord.id, selectedCodeId, selectedCode, normalizedEmail)

      return res.json({
        message: '兑换成功',
        data: redemptionResult.data,
        order: {
          ...orderRecord,
          status: 'redeemed',
          isUsed: true,
          userEmail: normalizedEmail,
          assignedCodeId: selectedCodeId,
          assignedCode: selectedCode,
        }
      })
    })
  } catch (error) {
    if (error instanceof RedemptionError) {
      return res.status(error.statusCode || 400).json({
        error: error.message,
        message: error.message,
        ...(error.payload || {})
      })
    }
    console.error('[Xianyu Redeem] 兑换错误:', error)
    res.status(500).json({ error: '服务器错误，请稍后重试' })
  }
})

// ArtisanFlow 渠道 API：获取当天创建的兑换码
router.get('/artisan-flow/today', apiKeyAuth, async (req, res) => {
  try {
    const db = await getDatabase()

    // 使用 SQLite 的 date() 函数比较日期，'localtime' 确保使用服务器本地时间
    const result = db.exec(`
      SELECT id, code, is_redeemed, redeemed_at, redeemed_by,
             account_email, channel, channel_name, created_at, updated_at
      FROM redemption_codes
      WHERE channel = 'artisan-flow'
        AND date(created_at) = date('now', 'localtime')
      ORDER BY created_at DESC
    `)

    const codes = result.length > 0
      ? result[0].values.map(row => ({
          id: row[0],
          code: row[1],
          isRedeemed: row[2] === 1,
          redeemedAt: row[3],
          redeemedBy: row[4],
          accountEmail: row[5],
          channel: row[6],
          channelName: row[7],
          createdAt: row[8],
          updatedAt: row[9]
        }))
      : []

    // 获取当前本地日期
    const dateResult = db.exec("SELECT date('now', 'localtime')")
    const todayDate = dateResult.length > 0 ? dateResult[0].values[0][0] : new Date().toISOString().split('T')[0]

    res.json({
      success: true,
      date: todayDate,
      total: codes.length,
      codes
    })
  } catch (error) {
    console.error('[ArtisanFlow API] 获取当天兑换码失败:', error)
    res.status(500).json({ error: '服务器错误，请稍后重试' })
  }
})

export default router
