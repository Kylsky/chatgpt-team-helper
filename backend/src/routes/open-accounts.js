import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateLinuxDoSession } from '../middleware/linuxdo-session.js'
import { AccountSyncError, fetchAccountInvites, fetchAccountUsersList, syncAccountInviteCount, syncAccountUserCount } from '../services/account-sync.js'
import { buildCreditSign, createCreditTransferService, formatCreditMoney, getCreditGatewayConfig } from '../services/credit-gateway.js'
import {
  reserveOpenAccountsCode,
  ensureOpenAccountsOrderCode,
  redeemOpenAccountsOrderCode
} from '../services/open-accounts-redemption.js'
import { withLocks } from '../utils/locks.js'
import { requireFeatureEnabled } from '../middleware/feature-flags.js'

const router = express.Router()

router.use(requireFeatureEnabled('openAccounts'))

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const normalizeUid = (value) => String(value ?? '').trim()
const normalizeUsername = (value) => String(value ?? '').trim()
const normalizeOrderNo = (value) => String(value ?? '').trim()

const loadCreditOrderEmail = (db, orderNo) => {
  if (!db || !orderNo) return ''
  const result = db.exec(`SELECT order_email FROM credit_orders WHERE order_no = ? LIMIT 1`, [orderNo])
  const row = result[0]?.values?.[0]
  return row?.[0] ? normalizeEmail(row[0]) : ''
}

const loadReservedOrderEmail = (db, orderNo) => {
  if (!db || !orderNo) return ''
  const result = db.exec(
    `
      SELECT reserved_for_order_email
      FROM redemption_codes
      WHERE reserved_for_order_no = ?
      ORDER BY reserved_at DESC, updated_at DESC
      LIMIT 1
    `,
    [orderNo]
  )
  const row = result[0]?.values?.[0]
  return row?.[0] ? normalizeEmail(row[0]) : ''
}

const ensureCreditOrderEmail = (db, orderNo, email) => {
  if (!db || !orderNo) return
  const normalized = normalizeEmail(email)
  if (!normalized) return
  db.run(
    `
      UPDATE credit_orders
      SET order_email = COALESCE(NULLIF(order_email, ''), ?),
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [normalized, orderNo]
  )
}

const resolveCreditOrderEmail = (db, orderNo, fallbackEmail) => {
  const reserved = loadReservedOrderEmail(db, orderNo)
  if (reserved) {
    ensureCreditOrderEmail(db, orderNo, reserved)
    return reserved
  }
  const stored = loadCreditOrderEmail(db, orderNo)
  if (stored) return stored
  return normalizeEmail(fallbackEmail)
}

const calculateDiscountedCredit = (baseCredit, expireAtStr) => {
  if (!expireAtStr) return baseCredit

  const expireDate = new Date(expireAtStr)
  if (isNaN(expireDate.getTime())) return baseCredit

  const now = new Date()
  const diffTime = expireDate.getTime() - now.getTime()
  const diffDays = diffTime / (1000 * 60 * 60 * 24)

  let discount = 1.0
  if (diffDays < 0) {
     return baseCredit
  } else if (diffDays < 7) {
    discount = 0.2
  } else if (diffDays < 14) {
    discount = 0.4
  } else if (diffDays < 20) {
    discount = 0.6
  } else if (diffDays < 25) {
    discount = 0.8
  }

  const baseAmount = Number(baseCredit)
  if (isNaN(baseAmount)) return baseCredit

  return (baseAmount * discount).toFixed(2)
}

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const isEnabledFlag = (value, defaultValue = true) => {
  if (value === undefined || value === null || value === '') return Boolean(defaultValue)
  const raw = String(value).trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

const shortRetryEnabled = () => isEnabledFlag(process.env.OPEN_ACCOUNTS_BOARD_SHORT_RETRY_ENABLED, true)
const shortRetryMaxAttempts = () => Math.min(5, Math.max(1, toInt(process.env.OPEN_ACCOUNTS_BOARD_SHORT_RETRY_MAX_ATTEMPTS, 3)))
const shortRetryBaseDelayMs = () => Math.min(5000, Math.max(0, toInt(process.env.OPEN_ACCOUNTS_BOARD_SHORT_RETRY_BASE_DELAY_MS, 800)))

const creditGatewayServerSubmitEnabled = () => isEnabledFlag(process.env.CREDIT_GATEWAY_SERVER_SUBMIT_ENABLED, false)

const isOpenAccountsEnabled = () => isEnabledFlag(process.env.OPEN_ACCOUNTS_ENABLED, true)

const parseUidList = (value) =>
  String(value || '')
    .split(',')
    .map(item => String(item || '').trim())
    .filter(Boolean)

const openAccountsMaintenanceBypassUidSet = () =>
  new Set(parseUidList(process.env.OPEN_ACCOUNTS_MAINTENANCE_ADMIN_UIDS || process.env.OPEN_ACCOUNTS_MAINTENANCE_BYPASS_UIDS || ''))

const isOpenAccountsMaintenanceBypass = (uid) => {
  const normalized = normalizeUid(uid)
  if (!normalized) return false
  return openAccountsMaintenanceBypassUidSet().has(normalized)
}

const getOpenAccountsMaintenanceMessage = () => {
  const message = String(process.env.OPEN_ACCOUNTS_MAINTENANCE_MESSAGE || '平台维护中').trim()
  return message || '平台维护中'
}

const isShortRetryableError = (error) => {
  const status = error instanceof AccountSyncError ? Number(error.status || 0) : Number(error?.status || 0)
  if (status === 429) return true
  if (status === 403) return true
  if (status === 503) return true
  if (status >= 500 && status <= 599) return true
  return false
}

const withShortRetry = async ({ enabled, label, uid, accountId, creditOrderNo }, task) => {
  const attempts = enabled ? shortRetryMaxAttempts() : 1
  const baseDelayMs = shortRetryBaseDelayMs()

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      const retryable = enabled && attempt < attempts && isShortRetryableError(error)
      if (!retryable) throw error

      const status = error instanceof AccountSyncError ? error.status : (error?.status || null)
      const message = error instanceof AccountSyncError ? error.message : (error?.message || String(error))
      const delayMs = Math.min(5000, baseDelayMs * Math.pow(2, attempt - 1))
      console.warn('[OpenAccounts] short retry', {
        label: label || 'unknown',
        uid,
        targetAccountId: accountId,
        creditOrderNo: creditOrderNo || null,
        attempt,
        attempts,
        status,
        delayMs,
        message
      })
      await sleep(delayMs)
    }
  }
}

const getPublicBaseUrl = (req) => {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim()
  if (configured) return configured.replace(/\/+$/, '')
  const protoHeader = req.headers['x-forwarded-proto']
  const protocol = typeof protoHeader === 'string' && protoHeader.trim() ? protoHeader.split(',')[0].trim() : req.protocol
  const host = req.get('host')
  return `https://${host}`
}

const extractPayingOrderNo = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return String(url.searchParams.get('order_no') || '').trim()
  } catch {
    return ''
  }
}

const buildCreditPayingUrl = (creditBaseUrl, payingOrderNo) => {
  const raw = String(payingOrderNo || '').trim()
  if (!raw) return ''
  try {
    const origin = new URL(String(creditBaseUrl || '')).origin
    return `${origin}/paying?order_no=${encodeURIComponent(raw)}`
  } catch {
    return ''
  }
}

const generateCreditOrderNo = () => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0')
  return `C${stamp}${rand}`
}

const loadOrCreateLinuxDoUser = async (db, { uid, username }) => {
  const result = db.exec(
    'SELECT uid, username, email, current_open_account_id, current_open_account_email FROM linuxdo_users WHERE uid = ? LIMIT 1',
    [uid]
  )
  if (result.length > 0 && result[0].values.length > 0) {
    const row = result[0].values[0]
    return {
      uid: row[0],
      username: row[1],
      email: row[2] || '',
      currentOpenAccountId: row[3] ?? null,
      currentOpenAccountEmail: row[4] || ''
    }
  }

  db.run(
    `INSERT INTO linuxdo_users (uid, username, email, current_open_account_id, current_open_account_email, created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
    [uid, username]
  )
  saveDatabase()
  return {
    uid,
    username,
    email: '',
    currentOpenAccountId: null,
    currentOpenAccountEmail: ''
  }
}

const updateLinuxDoUserCurrentAccount = (db, uid, username, accountId, openAccountEmail) => {
  const normalizedOpenAccountEmail = normalizeEmail(openAccountEmail)
  const storedOpenAccountEmail = accountId ? (normalizedOpenAccountEmail || null) : null
  db.run(
    `UPDATE linuxdo_users SET current_open_account_id = ?, current_open_account_email = ?, username = COALESCE(?, username), updated_at = DATETIME('now', 'localtime') WHERE uid = ?`,
    [accountId, storedOpenAccountEmail, username || null, uid]
  )
}

const ensureOpenAccount = (db, accountId) => {
  const result = db.exec(
    `
      SELECT id
	      FROM gpt_accounts
	      WHERE id = ?
	        AND is_open = 1
	        AND COALESCE(is_banned, 0) = 0
	      LIMIT 1
	    `,
	    [accountId]
	  )
  return result.length > 0 && result[0].values.length > 0
}

const syncAccountState = async (accountId) => {
  await syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' } })
  const { account } = await syncAccountUserCount(accountId)
  return account
}

const syncCardCounts = async (accountId) => {
  await syncAccountUserCount(accountId, { userListParams: { offset: 0, limit: 1, query: '' } })
  const synced = await syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' } })
  return synced.account
}

const detectEmailInAccountQueues = async (accountId, email) => {
  const normalized = normalizeEmail(email)
  if (!normalized) return { isMember: false, isInvited: false }

  const [users, invites] = await Promise.all([
    fetchAccountUsersList(accountId, { userListParams: { offset: 0, limit: 25, query: normalized } }),
    fetchAccountInvites(accountId, { inviteListParams: { offset: 0, limit: 25, query: normalized } })
  ])

  const isMember = (users.items || []).some(item => normalizeEmail(item.email) === normalized)
  const isInvited = (invites.items || []).some(item => normalizeEmail(item.email_address) === normalized)

  return { isMember, isInvited }
}

// 获取每日上车限制配置
const getDailyBoardLimit = () => {
  const limit = toInt(process.env.OPEN_ACCOUNTS_DAILY_BOARD_LIMIT, 0)
  return limit > 0 ? limit : 0 // 0 表示不限制
}

// 获取用户每日上车次数限制配置（全局 env）
const isUserDailyBoardLimitEnabled = () => isEnabledFlag(process.env.OPEN_ACCOUNTS_USER_DAILY_BOARD_LIMIT_ENABLED, false)
const getUserDailyBoardLimit = () => {
  const limit = toInt(process.env.OPEN_ACCOUNTS_USER_DAILY_BOARD_LIMIT, 0)
  return limit > 0 ? limit : 0 // 0 表示不限制
}

const getOpenAccountsVisibleCreatedWithinDays = () => {
  const days = toInt(process.env.OPEN_ACCOUNTS_VISIBLE_CREATED_WITHIN_DAYS, 30)
  return days > 0 ? days : 0 // 0 表示不限制
}

const OPEN_ACCOUNTS_REDEEM_BLOCK_START_HOUR = 0
const OPEN_ACCOUNTS_REDEEM_BLOCK_END_HOUR = 8
const ORDER_TYPE_WARRANTY = 'warranty'
const ORDER_TYPE_NO_WARRANTY = 'no_warranty'
const ORDER_TYPE_SET = new Set([ORDER_TYPE_WARRANTY, ORDER_TYPE_NO_WARRANTY])
const normalizeOrderType = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  return ORDER_TYPE_SET.has(normalized) ? normalized : ORDER_TYPE_WARRANTY
}

const getOpenAccountsRedeemBlockedHours = () => ({
  start: OPEN_ACCOUNTS_REDEEM_BLOCK_START_HOUR,
  end: OPEN_ACCOUNTS_REDEEM_BLOCK_END_HOUR
})

const isOpenAccountsRedeemBlockedNow = (date = new Date()) => {
  const hour = date.getHours()
  return hour >= OPEN_ACCOUNTS_REDEEM_BLOCK_START_HOUR && hour < OPEN_ACCOUNTS_REDEEM_BLOCK_END_HOUR
}

const buildOpenAccountsRedeemBlockedMessage = () => '开放账号每日 00:00-08:00 暂停兑换，请在 08:00 后再试'

// 查询今日已占用名额（包含已上车 + 未过期的未完成订单 + 已支付未上车）
const getTodayBoardCount = (db) => {
  const expireMinutes = Math.max(5, toInt(process.env.CREDIT_ORDER_EXPIRE_MINUTES, 15))
  const threshold = `-${expireMinutes} minutes`
  const result = db.exec(
    `
      SELECT COUNT(DISTINCT uid)
      FROM credit_orders
      WHERE scene = 'open_accounts_board'
        AND (
          (
            action_status = 'fulfilled'
            AND DATE(updated_at) = DATE('now', 'localtime')
          )
          OR (
            DATE(created_at) = DATE('now', 'localtime')
            AND status IN ('created', 'pending_payment', 'paid')
            AND (
              status = 'paid'
              OR paid_at IS NOT NULL
              OR created_at >= DATETIME('now', 'localtime', ?)
            )
          )
        )
    `,
    [threshold]
  )
  return Number(result[0]?.values?.[0]?.[0] || 0)
}

// 查询用户今日已上车/占用次数（包含已上车 + 未过期的未完成订单 + 已支付未上车）
const getUserTodayBoardOrderCount = (db, uid) => {
  if (!db || !uid) return 0
  const expireMinutes = Math.max(5, toInt(process.env.CREDIT_ORDER_EXPIRE_MINUTES, 15))
  const threshold = `-${expireMinutes} minutes`
  const result = db.exec(
    `
      SELECT COUNT(1)
      FROM credit_orders
      WHERE uid = ?
        AND scene = 'open_accounts_board'
        AND (
          (
            action_status = 'fulfilled'
            AND DATE(updated_at) = DATE('now', 'localtime')
          )
          OR (
            DATE(created_at) = DATE('now', 'localtime')
            AND status IN ('created', 'pending_payment', 'paid')
            AND (
              status = 'paid'
              OR paid_at IS NOT NULL
              OR created_at >= DATETIME('now', 'localtime', ?)
            )
          )
        )
    `,
    [uid, threshold]
  )
  return Number(result[0]?.values?.[0]?.[0] || 0)
}

// 获取已开放账号（卡片页展示用）
router.get('/', authenticateLinuxDoSession, async (req, res) => {
  const uid = normalizeUid(req.linuxdo?.uid)
  const username = normalizeUsername(req.linuxdo?.username)
  const bypass = isOpenAccountsMaintenanceBypass(uid)
  if (!isOpenAccountsEnabled() && !bypass) {
    return res.status(503).json({ error: getOpenAccountsMaintenanceMessage(), code: 'OPEN_ACCOUNTS_MAINTENANCE' })
  }
  try {
    const db = await getDatabase()
    const user = uid ? await loadOrCreateLinuxDoUser(db, { uid, username: username || uid }) : null
    const currentAccountId = user?.currentOpenAccountId ? Number(user.currentOpenAccountId) : null

    // 获取规则配置
    const dailyLimit = getDailyBoardLimit()
    const creditCost = formatCreditMoney(process.env.OPEN_ACCOUNTS_CREDIT_COST || process.env.LINUXDO_OPEN_ACCOUNTS_CREDIT_COST || '10')
    const userDailyLimitEnabled = isUserDailyBoardLimitEnabled() && getUserDailyBoardLimit() > 0
    const userDailyLimit = userDailyLimitEnabled ? getUserDailyBoardLimit() : 0

    // 获取今日已上车人数
    const todayBoardCount = getTodayBoardCount(db)

    const userTodayBoardCount = uid ? getUserTodayBoardOrderCount(db, uid) : 0
    const userDailyLimitRemaining =
      userDailyLimitEnabled && userDailyLimit > 0 ? Math.max(0, userDailyLimit - userTodayBoardCount) : null
    const redeemBlockedHours = getOpenAccountsRedeemBlockedHours()

    const visibleWithinDays = getOpenAccountsVisibleCreatedWithinDays()
    const threshold = visibleWithinDays > 0 ? `-${visibleWithinDays} days` : null

    const result = db.exec(
      `
	        SELECT ga.id,
	               ga.email,
	               COALESCE(ga.user_count, 0) AS user_count,
	               COALESCE(ga.invite_count, 0) AS invite_count,
	               ga.expire_at,
	               code_stats.remaining_codes
	        FROM gpt_accounts ga
	        JOIN (
	          SELECT lower(trim(account_email)) AS account_email_lower,
	                 COUNT(*) AS remaining_codes
	          FROM redemption_codes
	          WHERE is_redeemed = 0
	            AND channel = 'linux-do'
            AND account_email IS NOT NULL
            AND (reserved_for_order_no IS NULL OR reserved_for_order_no = '')
            AND (reserved_for_entry_id IS NULL OR reserved_for_entry_id = 0)
            AND (reserved_for_uid IS NULL OR reserved_for_uid = '')
	          GROUP BY lower(trim(account_email))
	        ) code_stats ON lower(trim(ga.email)) = code_stats.account_email_lower
		        WHERE ga.is_open = 1
		          AND COALESCE(ga.is_banned, 0) = 0
		          AND (COALESCE(ga.user_count, 0) + COALESCE(ga.invite_count, 0)) < 5
	          ${threshold ? "AND ga.created_at >= DATETIME('now', 'localtime', ?)" : ''}
	        ORDER BY ga.created_at DESC
	      `,
      threshold ? [threshold] : []
    )

	    const rows = result[0]?.values || []
	    const items = rows.map(row => {
	      const email = row[1]
	      const emailPrefix = String(email || '').split('@')[0] || ''
	      const expireAt = row[4] ? String(row[4]) : null
	      const remainingCodes = Number(row[5] || 0)
	      const orderType = ORDER_TYPE_WARRANTY
	      const discounted = formatCreditMoney(calculateDiscountedCredit(creditCost, expireAt))
	      return {
	        id: row[0],
	        emailPrefix,
	        joinedCount: Number(row[2]) || 0,
	        pendingCount: Number(row[3]) || 0,
	        expireAt,
	        remainingCodes,
	        orderType,
	        creditCost: discounted || creditCost || null
	      }
	    })

    if (currentAccountId && !items.some(item => Number(item.id) === currentAccountId)) {
	      const currentRow = db.exec(
	        `
	          SELECT id,
	                 email,
	                 COALESCE(user_count, 0) AS user_count,
	                 COALESCE(invite_count, 0) AS invite_count,
	                 expire_at
	          FROM gpt_accounts
	          WHERE id = ?
	          LIMIT 1
	        `,
        [currentAccountId]
      )[0]?.values?.[0]

	      if (currentRow) {
	        const email = currentRow[1]
	        const emailPrefix = String(email || '').split('@')[0] || ''
	        const expireAt = currentRow[4] ? String(currentRow[4]) : null
	        const remainingResult = db.exec(
	          `
	            SELECT COUNT(*)
	            FROM redemption_codes
	            WHERE is_redeemed = 0
	              AND channel = 'linux-do'
	              AND account_email IS NOT NULL
	              AND lower(trim(account_email)) = ?
	              AND (reserved_for_order_no IS NULL OR reserved_for_order_no = '')
	              AND (reserved_for_entry_id IS NULL OR reserved_for_entry_id = 0)
	              AND (reserved_for_uid IS NULL OR reserved_for_uid = '')
	          `,
          [String(email || '').trim().toLowerCase()]
	        )
	        const remainingCodes = Number(remainingResult[0]?.values?.[0]?.[0] || 0)
	        const orderType = ORDER_TYPE_WARRANTY
	        const discounted = formatCreditMoney(calculateDiscountedCredit(creditCost, expireAt))

	        items.unshift({
	          id: currentRow[0],
	          emailPrefix,
	          joinedCount: Number(currentRow[2]) || 0,
	          pendingCount: Number(currentRow[3]) || 0,
	          expireAt,
	          remainingCodes,
	          orderType,
	          creditCost: discounted || creditCost || null
	        })
	      }
	    }

    res.json({
      items,
      total: items.length,
      rules: {
        creditCost,
        dailyLimit: dailyLimit || null,
        todayBoardCount,
        userDailyLimitEnabled,
        userDailyLimit: userDailyLimitEnabled && userDailyLimit > 0 ? userDailyLimit : null,
        userTodayBoardCount,
        userDailyLimitRemaining,
        redeemBlockedHours,
        redeemBlockedNow: isOpenAccountsRedeemBlockedNow(),
        redeemBlockedMessage: buildOpenAccountsRedeemBlockedMessage()
      }
    })
  } catch (error) {
    console.error('Get open accounts error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 上车
router.post('/:accountId/board', authenticateLinuxDoSession, async (req, res) => {
  const uid = normalizeUid(req.linuxdo?.uid)
  const bypass = isOpenAccountsMaintenanceBypass(uid)
  if (!isOpenAccountsEnabled() && !bypass) {
    return res.status(503).json({ error: getOpenAccountsMaintenanceMessage(), code: 'OPEN_ACCOUNTS_MAINTENANCE' })
  }
  const username = normalizeUsername(req.linuxdo?.username)
  const accountId = Number.parseInt(String(req.params.accountId), 10)
  const creditOrderNo = normalizeOrderNo(req.body?.creditOrderNo)

  if (!uid) {
    return res.status(400).json({ error: '缺少 uid' })
  }
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return res.status(400).json({ error: 'accountId 无效' })
  }

  try {
    if (isOpenAccountsRedeemBlockedNow()) {
      return res.status(403).json({ error: buildOpenAccountsRedeemBlockedMessage() })
    }

    const db = await getDatabase()
    const user = await loadOrCreateLinuxDoUser(db, { uid, username: username || uid })
    const profileEmail = normalizeEmail(user.email)

    const { pid: creditPid, key: creditKey, baseUrl: creditBaseUrl } = await getCreditGatewayConfig()
    const creditCost = formatCreditMoney(process.env.OPEN_ACCOUNTS_CREDIT_COST || process.env.LINUXDO_OPEN_ACCOUNTS_CREDIT_COST || '10')
    const baseTitle = String(process.env.OPEN_ACCOUNTS_CREDIT_TITLE || '开放账号上车').trim() || '开放账号上车'
    const creditTitle = `${baseTitle} ${accountId}`

    const oldAccountId = user.currentOpenAccountId ? Number(user.currentOpenAccountId) : null
    const lockKeys = [`uid:${uid}`, `acct:${accountId}`]
    if (oldAccountId && oldAccountId !== accountId) lockKeys.push(`acct:${oldAccountId}`)

    const decision = await withLocks(lockKeys, async () => {
      const freshUser = await loadOrCreateLinuxDoUser(db, { uid, username: username || uid })
      const currentId = freshUser.currentOpenAccountId ? Number(freshUser.currentOpenAccountId) : null
      const onboardedEmailForExitCheck = normalizeEmail(freshUser.currentOpenAccountEmail || freshUser.email || profileEmail)

	      const accountRow = db.exec(
	        `
	          SELECT id, email, expire_at
	          FROM gpt_accounts
	          WHERE id = ?
	            AND is_open = 1
	            AND COALESCE(is_banned, 0) = 0
          LIMIT 1
        `,
        [accountId]
      )[0]?.values?.[0]
      if (!accountRow) {
        return { type: 'error', status: 404, error: '开放账号不存在或已隐藏' }
	      }
	      const accountEmail = accountRow[1] ? String(accountRow[1]) : ''
	      const accountExpireAt = accountRow[2] ? String(accountRow[2]) : null
	      const discounted = formatCreditMoney(calculateDiscountedCredit(creditCost, accountExpireAt))
	      const actualCreditCost = discounted || creditCost || null
	      const requestedOrderType = ORDER_TYPE_WARRANTY
	      if (!accountEmail) {
	        return { type: 'error', status: 500, error: '开放账号缺少邮箱配置' }
	      }

      let verifiedCreditOrderNo = null
      let verifiedOrderType = requestedOrderType
      let orderEmail = normalizeEmail(freshUser.email || profileEmail)
      if (creditOrderNo) {
        const creditRow = db.exec(
          `
            SELECT order_no, uid, scene, status, amount, target_account_id, action_status, action_result, action_payload, order_email
            FROM credit_orders
            WHERE order_no = ?
            LIMIT 1
          `,
          [creditOrderNo]
        )[0]?.values?.[0]

        if (!creditRow) return { type: 'error', status: 404, error: 'Credit 订单不存在' }
        const [orderNo, orderUid, scene, status, amount, targetAccountId, actionStatus, actionResult, actionPayload, orderEmailRaw] = creditRow
        if (String(orderUid) !== uid) return { type: 'error', status: 403, error: 'Credit 订单信息不匹配' }
        if (String(scene) !== 'open_accounts_board') return { type: 'error', status: 400, error: 'Credit 订单场景不匹配' }
        if (String(status) !== 'paid') return { type: 'error', status: 400, error: 'Credit 订单未完成授权' }
        if (Number(targetAccountId) !== accountId) return { type: 'error', status: 400, error: 'Credit 订单账号不匹配' }

	        verifiedCreditOrderNo = creditOrderNo
	        orderEmail = resolveCreditOrderEmail(db, creditOrderNo, orderEmailRaw || freshUser.email || profileEmail)

	        if (actionStatus && String(actionStatus) === 'fulfilled' && actionResult) {
	          try {
	            const parsed = JSON.parse(String(actionResult))
            if (parsed && typeof parsed === 'object') {
              return { type: 'success', body: parsed }
            }
          } catch {
          }
        }

        db.run(
          `
            UPDATE credit_orders
            SET action_status = 'processing',
                updated_at = DATETIME('now', 'localtime')
            WHERE order_no = ?
              AND (action_status IS NULL OR action_status = '' OR action_status != 'fulfilled')
          `,
          [String(orderNo)]
        )
        saveDatabase()
      }

      try {
        const shortRetryContext = Boolean(verifiedCreditOrderNo) && shortRetryEnabled()
        if (!orderEmail) {
          return { type: 'error', status: 400, error: '请先配置邮箱再上车' }
        }
        if (currentId && currentId === accountId) {
          const account = await withShortRetry(
            { enabled: shortRetryContext, label: 'syncCardCounts', uid, accountId, creditOrderNo: verifiedCreditOrderNo },
            () => syncCardCounts(accountId)
          )
          if (verifiedCreditOrderNo) {
            const redeemOutcome = await redeemOpenAccountsOrderCode(db, {
              orderNo: verifiedCreditOrderNo,
              uid,
              email: orderEmail,
              accountEmail,
              capacityLimit: 6,
              orderType: verifiedOrderType
            })
            if (!redeemOutcome.ok) {
              const codeMessage = redeemOutcome.error === 'no_code'
                ? '当前账号暂无可用兑换码，请稍后再试'
                : redeemOutcome.error || '兑换失败'
              const statusCode = redeemOutcome.statusCode || (redeemOutcome.error === 'no_code' ? 409 : 500)
              throw new AccountSyncError(codeMessage, statusCode)
            }
          }
          const body = {
            message: '已在该账号上车',
            currentOpenAccountId: accountId,
            account: {
              id: accountId,
              userCount: account.userCount,
              inviteCount: account.inviteCount
            }
          }

          if (verifiedCreditOrderNo) {
            db.run(
              `
                UPDATE credit_orders
                SET action_status = 'fulfilled',
                    action_message = ?,
                    action_result = ?,
                    updated_at = DATETIME('now', 'localtime')
                WHERE order_no = ?
              `,
              [body.message, JSON.stringify(body), verifiedCreditOrderNo]
            )
            saveDatabase()
          }

          return { type: 'success', body }
        }

        const account = await withShortRetry(
          { enabled: shortRetryContext, label: 'syncCardCounts', uid, accountId, creditOrderNo: verifiedCreditOrderNo },
          () => syncCardCounts(accountId)
        )

        const members = await withShortRetry(
          { enabled: shortRetryContext, label: 'fetchAccountUsersList', uid, accountId, creditOrderNo: verifiedCreditOrderNo },
          () => fetchAccountUsersList(accountId, { userListParams: { offset: 0, limit: 25, query: orderEmail } })
        )
        const isMember = (members.items || []).some(item => normalizeEmail(item.email) === orderEmail)

        const invites = await withShortRetry(
          { enabled: shortRetryContext, label: 'fetchAccountInvites', uid, accountId, creditOrderNo: verifiedCreditOrderNo },
          () => fetchAccountInvites(accountId, { inviteListParams: { offset: 0, limit: 25, query: orderEmail } })
        )
        const isInvited = (invites.items || []).some(item => normalizeEmail(item.email_address) === orderEmail)

        // 上车必须先消耗 Credit：首次点击上车先创建/复用 Credit 订单，授权成功后再携带 creditOrderNo 继续上车。
        if (!creditOrderNo) {
          if (!creditPid || !creditKey) {
            return { type: 'error', status: 500, error: '未配置 Linux DO Credit 凭据' }
          }
	          if (!actualCreditCost) {
	            return { type: 'error', status: 500, error: '未配置上车所需积分' }
	          }

	          const baseCapacity = 5
	          // 若用户尚未在目标账号的成员/邀请列表中，且账号已满员，则不创建订单，避免授权后无法上车。
	          if (!isMember && !isInvited) {
	            const seatsUsed = Number(account.userCount || 0) + Number(account.inviteCount || 0)
	            if (seatsUsed >= baseCapacity) {
              return { type: 'error', status: 409, error: '该账号已满员，无法上车' }
            }
          }

          const expireMinutes = Math.max(5, toInt(process.env.CREDIT_ORDER_EXPIRE_MINUTES, 15))
          const threshold = `-${expireMinutes} minutes`
          const existingCandidates = db.exec(
            `
              SELECT order_no, amount, pay_url, status, order_email
              FROM credit_orders
              WHERE uid = ?
                AND scene = 'open_accounts_board'
                AND target_account_id = ?
                AND status IN ('created', 'pending_payment')
                AND created_at >= DATETIME('now', 'localtime', ?)
              ORDER BY created_at DESC
              LIMIT 5
            `,
            [uid, accountId, threshold]
          )[0]?.values || []

          const resolvedExisting = (() => {
            for (const candidate of existingCandidates) {
              const orderNo = normalizeOrderNo(candidate?.[0])
              if (!orderNo) continue
              const candidateEmail = resolveCreditOrderEmail(db, orderNo, candidate?.[4])
              if (!candidateEmail) continue
              if (candidateEmail === orderEmail) return candidate
            }
            return null
          })()

          if (resolvedExisting) {
            const existingOrderNo = String(resolvedExisting[0])
            ensureCreditOrderEmail(db, existingOrderNo, orderEmail)
            const reservedCode = ensureOpenAccountsOrderCode(db, {
              orderNo: existingOrderNo,
              accountEmail,
              email: orderEmail
            })
            if (!reservedCode) {
              return { type: 'error', status: 409, error: '当前账号暂无可用兑换码，请稍后再试' }
            }
            saveDatabase()
            console.info('[OpenAccounts] reuse credit order', {
              uid,
              targetAccountId: accountId,
              creditOrderNo: existingOrderNo,
              amount: String(resolvedExisting[1] || actualCreditCost),
              status: String(resolvedExisting[3] || 'created'),
              expireMinutes
            })
            return {
              type: 'credit_required',
              creditOrder: {
                orderNo: existingOrderNo,
                amount: String(resolvedExisting[1] || actualCreditCost),
                payUrl: resolvedExisting[2] ? String(resolvedExisting[2]) : null,
                status: String(resolvedExisting[3] || 'created')
              }
            }
          }

          // 检查用户每日上车次数限制（包含未完成订单，避免高并发时超额）
          const userDailyLimitEnabled = isUserDailyBoardLimitEnabled()
          const userDailyLimit = userDailyLimitEnabled ? getUserDailyBoardLimit() : 0
          if (userDailyLimitEnabled && userDailyLimit > 0) {
            const userTodayCount = getUserTodayBoardOrderCount(db, uid)
            if (userTodayCount >= userDailyLimit) {
              return { type: 'error', status: 429, error: `今日购买次数已达上限（${userDailyLimit}次），请明天再试` }
            }
          }

          // 检查今日全局上车人数限制（包含未完成订单，避免高并发时超额）
          const dailyLimit = getDailyBoardLimit()
          if (dailyLimit > 0) {
            const todayCount = getTodayBoardCount(db)
            if (todayCount >= dailyLimit) {
              return { type: 'error', status: 429, error: `今日上车名额已满（${dailyLimit}人），请明天再试` }
            }
          }

          const newOrderNo = generateCreditOrderNo()
          const reservedCode = reserveOpenAccountsCode(db, {
            orderNo: newOrderNo,
            accountEmail,
            email: orderEmail
          })
          if (!reservedCode) {
            return { type: 'error', status: 409, error: '当前账号暂无可用兑换码，请稍后再试' }
          }
          db.run(
            `
              INSERT INTO credit_orders (
                order_no, uid, username, order_email, scene, title, amount, status, target_account_id,
                code_id, code, code_account_email,
                action_payload, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'open_accounts_board', ?, ?, 'created', ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
            `,
            [
              newOrderNo,
              uid,
              username || null,
              orderEmail,
              creditTitle,
              actualCreditCost,
              accountId,
              reservedCode.id,
              reservedCode.code,
              reservedCode.accountEmail || null,
              JSON.stringify({ accountId, orderType: requestedOrderType, orderEmail })
            ]
          )
          saveDatabase()

          console.info('[OpenAccounts] created credit order', {
            uid,
            targetAccountId: accountId,
            creditOrderNo: newOrderNo,
            title: creditTitle,
            amount: actualCreditCost,
            expireMinutes
          })

          return {
            type: 'credit_required',
            creditOrder: { orderNo: newOrderNo, amount: actualCreditCost, payUrl: null, status: 'created' }
          }
        }

	        const baseCapacity = 5
	        const redeemCapacity = isMember || isInvited ? 6 : baseCapacity
	        const redeemOutcome = await redeemOpenAccountsOrderCode(db, {
	          orderNo: verifiedCreditOrderNo,
	          uid,
	          email: orderEmail,
          accountEmail,
          capacityLimit: redeemCapacity,
          orderType: verifiedOrderType
        })

        if (!redeemOutcome.ok) {
          const codeMessage = redeemOutcome.error === 'no_code'
            ? '当前账号暂无可用兑换码，请稍后再试'
            : redeemOutcome.error || '兑换失败'
          const statusCode = redeemOutcome.statusCode || (redeemOutcome.error === 'no_code' ? 409 : 500)
          throw new AccountSyncError(codeMessage, statusCode)
        }

        updateLinuxDoUserCurrentAccount(db, uid, username, accountId, orderEmail)
        saveDatabase()

        const redeemedData = redeemOutcome.redemption?.data || {}
        const resolvedInviteCount = typeof redeemedData.inviteCount === 'number'
          ? redeemedData.inviteCount
          : account.inviteCount
        const body = {
          message: redeemedData.inviteStatus === '邀请已发送'
            ? '上车成功，邀请已发送'
            : '上车成功，邀请未发送（需要手动添加）',
          currentOpenAccountId: accountId,
          account: {
            id: accountId,
            userCount: redeemedData.userCount ?? account.userCount,
            inviteCount: resolvedInviteCount
          }
        }

        if (verifiedCreditOrderNo) {
          db.run(
            `
              UPDATE credit_orders
              SET action_status = 'fulfilled',
                  action_message = ?,
                  action_result = ?,
                  updated_at = DATETIME('now', 'localtime')
              WHERE order_no = ?
            `,
            [body.message, JSON.stringify(body), verifiedCreditOrderNo]
          )
          saveDatabase()
        }

        return { type: 'success', body }
      } catch (error) {
        if (verifiedCreditOrderNo) {
          const message = error instanceof AccountSyncError
            ? error.message
            : error?.message || String(error)
          try {
            db.run(
              `
                UPDATE credit_orders
                SET action_status = 'failed',
                    action_message = ?,
                    updated_at = DATETIME('now', 'localtime')
                WHERE order_no = ?
              `,
              [message, verifiedCreditOrderNo]
            )
            saveDatabase()
          } catch {
          }
        }
        throw error
      }
    })

    if (!decision || decision.type === 'error') {
      const payload = { error: decision?.error || '内部服务器错误' }
      if (decision?.code) {
        payload.code = decision.code
      }
      return res.status(decision?.status || 500).json(payload)
    }

    if (decision.type === 'credit_required') {
      const normalizedOrderNo = normalizeOrderNo(decision.creditOrder?.orderNo)
      if (!normalizedOrderNo) {
        return res.status(500).json({ error: '创建 Credit 订单失败' })
      }

      const notifyUrl = `${getPublicBaseUrl(req)}/credit/notify`

      if (!creditPid || !creditKey || !creditBaseUrl) {
        return res.status(500).json({ error: '未配置 Linux DO Credit 凭据' })
      }

      const creditRow = db.exec(
        `SELECT title, amount, status, pay_url, trade_no FROM credit_orders WHERE order_no = ? LIMIT 1`,
        [normalizedOrderNo]
      )[0]?.values?.[0]
      const orderTitle = creditRow?.[0] ? String(creditRow[0]) : creditTitle
      const orderAmountRaw = creditRow?.[1] != null ? String(creditRow[1]) : String(decision.creditOrder?.amount || actualCreditCost || '')
      const orderStatus = creditRow?.[2] ? String(creditRow[2]) : ''
      const storedPayUrl = creditRow?.[3] ? String(creditRow[3]) : ''
      const storedTradeNo = creditRow?.[4] ? String(creditRow[4]).trim() : ''
      const orderAmount = formatCreditMoney(orderAmountRaw) || actualCreditCost
      let payUrl = storedPayUrl || (decision.creditOrder?.payUrl ? String(decision.creditOrder.payUrl) : '')

      if (!orderAmount) {
        return res.status(500).json({ error: '未配置上车所需积分' })
      }

      const canonicalPayUrl = storedTradeNo ? buildCreditPayingUrl(creditBaseUrl, storedTradeNo) : ''
      if (canonicalPayUrl) {
        if (!payUrl || payUrl !== canonicalPayUrl) {
          payUrl = canonicalPayUrl
          try {
            db.run(
              `UPDATE credit_orders SET pay_url = ?, updated_at = DATETIME('now', 'localtime') WHERE order_no = ?`,
              [canonicalPayUrl, normalizedOrderNo]
            )
            saveDatabase()
          } catch (error) {
            console.warn('[OpenAccounts] persist credit pay_url failed', { orderNo: normalizedOrderNo, message: error?.message || String(error) })
          }
        }
      } else if (payUrl) {
        const payUrlOrderNo = extractPayingOrderNo(payUrl)
        if (payUrlOrderNo && payUrlOrderNo === normalizedOrderNo) {
          console.warn('[OpenAccounts] discard suspicious credit pay_url', { orderNo: normalizedOrderNo, payUrl })
          payUrl = ''
          try {
            db.run(`UPDATE credit_orders SET pay_url = NULL, updated_at = DATETIME('now', 'localtime') WHERE order_no = ?`, [normalizedOrderNo])
            saveDatabase()
          } catch (error) {
            console.warn('[OpenAccounts] clear credit pay_url failed', { orderNo: normalizedOrderNo, message: error?.message || String(error) })
          }
        }
      }

      console.info('[OpenAccounts] credit payment request prepared', {
        uid,
        targetAccountId: accountId,
        creditOrderNo: normalizedOrderNo,
        title: orderTitle,
        amount: orderAmount,
        payUrl: payUrl || null,
        notifyUrl
      })

      try {
        db.run(
          `UPDATE credit_orders SET status = 'pending_payment', updated_at = DATETIME('now', 'localtime') WHERE order_no = ? AND status = 'created'`,
          [normalizedOrderNo]
        )
        saveDatabase()
      } catch (error) {
        console.warn('[OpenAccounts] update credit order status failed', { orderNo: normalizedOrderNo, message: error?.message || String(error) })
      }

      // Cloudflare 会拦截服务端直连 /pay/submit.php，改为返回签名参数，让浏览器通过 form POST 打开支付页。
      const submitUrl = `${String(creditBaseUrl).replace(/\/+$/, '')}/pay/submit.php`
      const payParams = {
        pid: creditPid,
        type: 'epay',
        out_trade_no: normalizedOrderNo,
        name: orderTitle,
        money: orderAmount,
        notify_url: notifyUrl,
        device: uid
      }
      const sign = buildCreditSign(payParams, creditKey)

      // 可选：尝试服务端直连创建积分流转服务（成功可拿到 Location=/paying?order_no=...）。
      // 注意：Credit 平台可能开启 Cloudflare challenge，导致服务端请求 403；默认关闭，建议由前端浏览器 form POST 完成。
      if (creditGatewayServerSubmitEnabled() && !payUrl && orderStatus === 'created') {
        try {
          const submitResult = await createCreditTransferService({
            outTradeNo: normalizedOrderNo,
            title: orderTitle,
            money: orderAmount,
            notifyUrl,
            device: uid,
            timeoutMs: 4500
          })

          if (submitResult?.ok && submitResult.payUrl) {
            payUrl = String(submitResult.payUrl)
            const payingOrderNo = submitResult.payingOrderNo ? String(submitResult.payingOrderNo) : ''
            try {
              db.run(
                `
                  UPDATE credit_orders
                  SET pay_url = ?,
                      trade_no = CASE
                        WHEN ? IS NOT NULL AND (trade_no IS NULL OR TRIM(trade_no) = '' OR trade_no = order_no) THEN ?
                        ELSE trade_no
                      END,
                      updated_at = DATETIME('now', 'localtime')
                  WHERE order_no = ?
                `,
                [payUrl, payingOrderNo || null, payingOrderNo || null, normalizedOrderNo]
              )
              saveDatabase()
            } catch (error) {
              console.warn('[OpenAccounts] persist credit pay_url failed', { orderNo: normalizedOrderNo, message: error?.message || String(error) })
            }
          } else if (submitResult) {
            console.warn('[OpenAccounts] credit submit failed', {
              orderNo: normalizedOrderNo,
              error: submitResult.error || 'create_failed',
              status: submitResult.status || null,
              message: submitResult.message || null,
              bodySnippet: submitResult.bodySnippet || null
            })
          }
        } catch (error) {
          console.warn('[OpenAccounts] credit submit exception', { orderNo: normalizedOrderNo, message: error?.message || String(error) })
        }
      }

      console.info('[OpenAccounts] credit pay submit form prepared', {
        uid,
        targetAccountId: accountId,
        submitUrl,
        payParams,
        signType: 'MD5',
        signPrefix: sign ? String(sign).slice(0, 8) : null,
        signLength: sign ? String(sign).length : 0
      })

      return res.json({
        requiresCredit: true,
        message: `上车需消耗 ${orderAmount} Credit，请在新窗口完成授权后继续上车`,
        creditOrder: {
          orderNo: normalizedOrderNo,
          amount: orderAmount,
          payUrl: payUrl || null,
          payRequest: {
            method: 'POST',
            url: submitUrl,
            fields: {
              ...payParams,
              sign,
              sign_type: 'MD5'
            }
          }
        }
      })
    }

    return res.json(decision.body)
  } catch (error) {
    console.error('Board error:', error)
    if (error instanceof AccountSyncError || error.status) {
      const payload = { error: error.message }
      if (error.code && String(error.code).startsWith('NO_WARRANTY')) {
        payload.code = error.code
      }
      return res.status(error.status || 500).json(payload)
    }
    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 下车（已移除）
router.post('/unboard', authenticateLinuxDoSession, async (req, res) => {
  res.status(410).json({ error: '下车功能已移除' })
})

export default router
