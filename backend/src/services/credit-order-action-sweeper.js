import { getDatabase, saveDatabase } from '../database/init.js'
import { withLocks } from '../utils/locks.js'
import {
  AccountSyncError,
  fetchAccountInvites,
  fetchAccountUsersList,
  syncAccountInviteCount,
  syncAccountUserCount
} from './account-sync.js'
import { redeemOpenAccountsOrderCode } from './open-accounts-redemption.js'
import { sendAdminAlertEmail } from './email-service.js'
import { upsertAccountExceptionHistory } from './account-exception-history.js'
import { getFeatureFlags, isFeatureEnabled } from '../utils/feature-flags.js'

const LABEL = '[CreditOrderActionSweeper]'

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const isEnabled = () => {
  const raw = String(process.env.CREDIT_ORDER_ACTION_SWEEPER_ENABLED ?? 'true').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

const intervalSeconds = () => Math.max(10, toInt(process.env.CREDIT_ORDER_ACTION_SWEEPER_INTERVAL_SECONDS, 60))
const initialDelayMs = () => Math.max(1000, toInt(process.env.CREDIT_ORDER_ACTION_SWEEPER_INITIAL_DELAY_MS, 30_000))
const maxRetries = () => Math.max(0, toInt(process.env.CREDIT_ORDER_ACTION_MAX_RETRIES, 8))
const baseDelaySeconds = () => Math.max(5, toInt(process.env.CREDIT_ORDER_ACTION_RETRY_BASE_SECONDS, 60))
const maxDelaySeconds = () => Math.max(30, toInt(process.env.CREDIT_ORDER_ACTION_RETRY_MAX_SECONDS, 3600))
const concurrency = () => Math.max(1, toInt(process.env.CREDIT_ORDER_ACTION_SWEEPER_CONCURRENCY, 2))
const healthCheckAlertEnabled = () => {
  const raw = String(process.env.CREDIT_ORDER_ACTION_SWEEPER_HEALTHCHECK_ALERT ?? '').trim().toLowerCase()
  return raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'off'
}

let healthCheckAlertSent = false

const safeJsonParse = (raw) => {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    return null
  }
}

const nowIso = () => new Date().toISOString()


const recordHistoryExceptionFromOrder = async ({
  accountId,
  accountName,
  exceptionType,
  exceptionCode,
  exceptionMessage,
  status = 'active',
  source = 'credit_order_action_sweeper',
}) => {
  const result = await upsertAccountExceptionHistory({
    accountId,
    accountName,
    exceptionType,
    exceptionCode,
    exceptionMessage,
    status,
    source,
  })
  if (!result?.ok) {
    console.warn(`${LABEL} history exception upsert skipped`, {
      accountId,
      reason: result?.reason || 'unknown',
      exceptionType,
      exceptionCode,
    })
  }
}

const computeNextRetryAt = (attempt) => {
  const safeAttempt = Math.max(1, Number(attempt) || 1)
  const seconds = Math.min(maxDelaySeconds(), baseDelaySeconds() * Math.pow(2, safeAttempt - 1))
  return new Date(Date.now() + seconds * 1000).toISOString()
}

const shouldRetryError = (error) => {
  const status = error instanceof AccountSyncError ? Number(error.status || 0) : Number(error?.status || 0)
  if (status === 429) return true
  if (status === 403) return true
  if (status >= 500 && status <= 599) return true
  if (status === 503) return true
  return false
}

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const normalizeUid = (value) => String(value ?? '').trim()

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

const ORDER_TYPE_WARRANTY = 'warranty'
const ORDER_TYPE_NO_WARRANTY = 'no_warranty'
const ORDER_TYPE_SET = new Set([ORDER_TYPE_WARRANTY, ORDER_TYPE_NO_WARRANTY])

const normalizeOrderType = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  return ORDER_TYPE_SET.has(normalized) ? normalized : ORDER_TYPE_WARRANTY
}

const loadLinuxDoUserEmail = (db, uid) => {
  if (!db || !uid) return ''
  const result = db.exec('SELECT email FROM linuxdo_users WHERE uid = ? LIMIT 1', [uid])
  const row = result[0]?.values?.[0]
  return row?.[0] ? normalizeEmail(row[0]) : ''
}

const resolveOpenAccountsOrderEmail = (db, { orderNo, uid, rowOrderEmail }) => {
  const reserved = loadReservedOrderEmail(db, orderNo)
  if (reserved) {
    ensureCreditOrderEmail(db, orderNo, reserved)
    return reserved
  }

  const stored = normalizeEmail(rowOrderEmail)
  if (stored) {
    ensureCreditOrderEmail(db, orderNo, stored)
    return stored
  }

  const fallback = loadLinuxDoUserEmail(db, uid)
  if (fallback) {
    ensureCreditOrderEmail(db, orderNo, fallback)
  }
  return fallback
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

const persistActionState = (db, orderNo, { status, message, payload, result }) => {
  if (!db || !orderNo) return
  db.run(
    `
      UPDATE credit_orders
      SET action_status = ?,
          action_message = ?,
          action_payload = ?,
          action_result = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [
      status || null,
      message || null,
      payload ? JSON.stringify(payload) : null,
      result ? JSON.stringify(result) : null,
      orderNo
    ]
  )
}

const markFulfilled = (db, orderNo, { message, body, payload }) => {
  persistActionState(db, orderNo, {
    status: 'fulfilled',
    message: message || '已完成',
    payload,
    result: body
  })
}

const markRetrying = (db, orderNo, { message, payload }) => {
  persistActionState(db, orderNo, {
    status: 'retrying',
    message: message || '执行失败，等待重试',
    payload,
    result: null
  })
}

const markFailed = (db, orderNo, { message, payload }) => {
  persistActionState(db, orderNo, {
    status: 'failed',
    message: message || '执行失败',
    payload,
    result: null
  })
}

const updateLinuxDoUserCurrentAccount = (db, uid, accountId, openAccountEmail) => {
  if (!db || !uid) return
  const normalizedOpenAccountEmail = normalizeEmail(openAccountEmail)
  const storedOpenAccountEmail = accountId ? (normalizedOpenAccountEmail || null) : null
  db.run(
    `
      UPDATE linuxdo_users
      SET current_open_account_id = ?,
          current_open_account_email = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE uid = ?
    `,
    [accountId, storedOpenAccountEmail, uid]
  )
}

const fulfillOpenAccountsBoardOrder = async (db, row) => {
  const orderNo = String(row.orderNo || '').trim()
  const uid = normalizeUid(row.uid)
  const username = String(row.username || '').trim()
  const targetAccountId = Number(row.targetAccountId)
  const paidAt = row.paidAt ? String(row.paidAt) : null

  const existingPayload = safeJsonParse(row.actionPayload) || {}
  const orderType = normalizeOrderType(existingPayload.orderType || existingPayload.order_type)
  const attempts = Math.max(0, toInt(existingPayload.attempts, 0))
  const stopRetry = Boolean(existingPayload.stopRetry)
  const nextRetryAt = String(existingPayload.nextRetryAt || '').trim()
  const alertSentAt = String(existingPayload.alertSentAt || '').trim()

  if (!orderNo || !uid || !Number.isFinite(targetAccountId) || targetAccountId <= 0) return { ok: true, skipped: true }
  if (stopRetry) return { ok: true, skipped: true }

  if (nextRetryAt) {
    const nextTime = Date.parse(nextRetryAt)
    if (Number.isFinite(nextTime) && Date.now() < nextTime) {
      return { ok: true, skipped: true }
    }
  }

  const email = resolveOpenAccountsOrderEmail(db, { orderNo, uid, rowOrderEmail: row.orderEmail })
  if (!email) {
    const message = '缺少用户邮箱，无法执行邀请'
    const payload = { ...existingPayload, attempts, stopRetry: true, lastAttemptAt: nowIso(), lastError: message }
    markFailed(db, orderNo, { message, payload })
    await saveDatabase()
    const alertResult = await sendAdminAlertEmail({
      subject: 'Credit 订单执行失败：缺少邮箱',
      text: `${message}\norderNo=${orderNo}\nuid=${uid}\nusername=${username || ''}\naccountId=${targetAccountId}\npaidAt=${paidAt || ''}`,
    })
    if (!alertResult.ok) {
      console.warn(`${LABEL} admin alert skipped`, { orderNo, uid, targetAccountId, reason: alertResult.error || 'unknown' })
    }
    await recordHistoryExceptionFromOrder({
      accountId: targetAccountId,
      exceptionType: 'missing_order_email',
      exceptionCode: 'ORDER_EMAIL_MISSING',
      exceptionMessage: message,
    })
    return { ok: false, error: message, retryable: false }
  }

  if (!ensureOpenAccount(db, targetAccountId)) {
    const message = '开放账号不存在或已隐藏，无法执行邀请'
    const payload = { ...existingPayload, attempts, stopRetry: true, lastAttemptAt: nowIso(), lastError: message }
    markFailed(db, orderNo, { message, payload })
    await saveDatabase()
    const alertResult = await sendAdminAlertEmail({
      subject: 'Credit 订单执行失败：开放账号不可用',
      text: `${message}\norderNo=${orderNo}\nuid=${uid}\nusername=${username || ''}\nemail=${email}\naccountId=${targetAccountId}\npaidAt=${paidAt || ''}`,
    })
    if (!alertResult.ok) {
      console.warn(`${LABEL} admin alert skipped`, { orderNo, uid, targetAccountId, reason: alertResult.error || 'unknown' })
    }
    await recordHistoryExceptionFromOrder({
      accountId: targetAccountId,
      exceptionType: 'open_account_not_found',
      exceptionCode: 'ACCOUNT_NOT_FOUND',
      exceptionMessage: message,
    })
    return { ok: false, error: message, retryable: false }
  }

  const accountEmailRow = db.exec(
    `SELECT email FROM gpt_accounts WHERE id = ? LIMIT 1`,
    [targetAccountId]
  )[0]?.values?.[0]
  const accountEmail = accountEmailRow?.[0] ? String(accountEmailRow[0]) : ''
  if (!accountEmail) {
    const message = '开放账号缺少邮箱配置，无法执行邀请'
    const payload = { ...existingPayload, attempts, stopRetry: true, lastAttemptAt: nowIso(), lastError: message }
    markFailed(db, orderNo, { message, payload })
    await saveDatabase()
    const alertResult = await sendAdminAlertEmail({
      subject: 'Credit 订单执行失败：开放账号缺少邮箱',
      text: `${message}\norderNo=${orderNo}\nuid=${uid}\nusername=${username || ''}\nemail=${email}\naccountId=${targetAccountId}\npaidAt=${paidAt || ''}`,
    })
    if (!alertResult.ok) {
      console.warn(`${LABEL} admin alert skipped`, { orderNo, uid, targetAccountId, reason: alertResult.error || 'unknown' })
    }
    await recordHistoryExceptionFromOrder({
      accountId: targetAccountId,
      exceptionType: 'invalid_target_account',
      exceptionCode: 'ACCOUNT_EMAIL_MISSING',
      exceptionMessage: message,
    })
    return { ok: false, error: message, retryable: false }
  }

  const effectiveOrderType = (existingPayload.orderType || existingPayload.order_type) ? orderType : ORDER_TYPE_WARRANTY

  const nextAttempt = attempts + 1
  const startedAt = Date.now()
  const attemptPayload = {
    ...existingPayload,
    attempts: nextAttempt,
    lastAttemptAt: nowIso(),
    uid,
    username: username || existingPayload.username || null,
    email,
    accountId: targetAccountId,
    orderType: effectiveOrderType,
    orderNo
  }

  persistActionState(db, orderNo, { status: 'processing', message: '处理中', payload: attemptPayload, result: null })
  await saveDatabase()

  try {
    const accountAfterUsers = await syncAccountUserCount(targetAccountId, { userListParams: { offset: 0, limit: 1, query: '' } })
    const accountAfterInvites = await syncAccountInviteCount(targetAccountId, {
      accountRecord: accountAfterUsers.account,
      inviteListParams: { offset: 0, limit: 1, query: '' }
    })

    const userCount = Number(accountAfterInvites.account?.userCount || 0)
    const inviteCount = Number(accountAfterInvites.account?.inviteCount || 0)

    const users = await fetchAccountUsersList(targetAccountId, { userListParams: { offset: 0, limit: 25, query: email } })
    const isMember = (users.items || []).some(item => normalizeEmail(item.email) === email)

    const invites = await fetchAccountInvites(targetAccountId, { inviteListParams: { offset: 0, limit: 25, query: email } })
    const isInvited = (invites.items || []).some(item => normalizeEmail(item.email_address) === email)

    const baseCapacity = 5
    const redeemCapacity = isMember || isInvited ? 6 : baseCapacity
    const redeemOutcome = await redeemOpenAccountsOrderCode(db, {
      orderNo,
      uid,
      email,
      accountEmail,
      capacityLimit: redeemCapacity,
      orderType: effectiveOrderType
    })

    if (!redeemOutcome.ok) {
      const message = redeemOutcome.error === 'no_code'
        ? '当前账号暂无可用兑换码，请稍后再试'
        : redeemOutcome.error || '兑换失败'
      const statusCode = redeemOutcome.statusCode || (redeemOutcome.error === 'no_code' ? 409 : 500)
      throw new AccountSyncError(message, statusCode)
    }

    updateLinuxDoUserCurrentAccount(db, uid, targetAccountId, email)
    const redeemedData = redeemOutcome.redemption?.data || {}
    const resolvedInviteCount = typeof redeemedData.inviteCount === 'number'
      ? redeemedData.inviteCount
      : inviteCount
    const body = {
      message: redeemedData.inviteStatus === '邀请已发送'
        ? '上车成功，邀请已发送'
        : '上车成功，邀请未发送（需要手动添加）',
      currentOpenAccountId: targetAccountId,
      account: {
        id: targetAccountId,
        userCount: redeemedData.userCount ?? userCount,
        inviteCount: resolvedInviteCount
      }
    }
    markFulfilled(db, orderNo, { message: body.message, body, payload: attemptPayload })
    await saveDatabase()
    console.info(LABEL, 'fulfilled', { orderNo, uid, targetAccountId, durationMs: Date.now() - startedAt })
    return { ok: true, fulfilled: true }
  } catch (error) {
    const message = error instanceof AccountSyncError ? error.message : (error?.message || String(error))
    const retryable = shouldRetryError(error)
    const limit = maxRetries()

    if (retryable && limit > 0 && nextAttempt < limit) {
      const payload = { ...attemptPayload, lastError: message, nextRetryAt: computeNextRetryAt(nextAttempt) }
      markRetrying(db, orderNo, { message, payload })
      await saveDatabase()
      console.warn(LABEL, 'action retry scheduled', { orderNo, uid, targetAccountId, attempt: nextAttempt, nextRetryAt: payload.nextRetryAt, message })
      return { ok: false, error: message, retryable: true }
    }

    const shouldAlert = !alertSentAt
    const payload = { ...attemptPayload, stopRetry: true, lastError: message, alertSentAt: shouldAlert ? nowIso() : alertSentAt || null }
    markFailed(db, orderNo, { message: `${message}${limit > 0 ? `（已达最大重试次数 ${limit}）` : ''}`, payload })
    await saveDatabase()

    if (shouldAlert) {
      const alertResult = await sendAdminAlertEmail({
        subject: 'Credit 订单执行失败：开放账号邀请未完成',
        text: [
          'Credit 订单已支付，但开放账号邀请执行失败。',
          `orderNo=${orderNo}`,
          `uid=${uid}`,
          `username=${username || ''}`,
          `email=${email}`,
          `accountId=${targetAccountId}`,
          `paidAt=${paidAt || ''}`,
          `attempts=${nextAttempt}`,
          `retryable=${retryable ? 'yes' : 'no'}`,
          `error=${message}`
        ].join('\n')
      })
      if (!alertResult.ok) {
        console.warn(`${LABEL} admin alert skipped`, { orderNo, uid, targetAccountId, reason: alertResult.error || 'unknown' })
      }
      await recordHistoryExceptionFromOrder({
        accountId: targetAccountId,
        exceptionType: retryable ? 'invite_retry_exhausted' : 'invite_failed',
        exceptionCode: retryable ? 'RETRY_EXHAUSTED' : 'INVITE_FAILED',
        exceptionMessage: message,
      })
    }

    console.error(LABEL, 'action failed', { orderNo, uid, targetAccountId, attempt: nextAttempt, retryable, message })
    return { ok: false, error: message, retryable: false }
  }
}

const fetchPendingPaidOrders = (db, limit) => {
  if (!db) return []
  const result = db.exec(
    `
      SELECT order_no, uid, username, target_account_id, status, paid_at, refunded_at,
             action_status, action_message, action_payload, order_email
      FROM credit_orders
      WHERE scene = 'open_accounts_board'
        AND status = 'paid'
        AND refunded_at IS NULL
        AND (action_status IS NULL OR action_status = '' OR action_status != 'fulfilled')
      ORDER BY paid_at DESC, created_at DESC
      LIMIT ?
    `,
    [Math.max(1, Number(limit) || 20)]
  )

  const rows = result[0]?.values || []
  return rows.map(row => ({
    orderNo: row[0],
    uid: row[1],
    username: row[2],
    targetAccountId: row[3],
    status: row[4],
    paidAt: row[5],
    refundedAt: row[6],
    actionStatus: row[7],
    actionMessage: row[8],
    actionPayload: row[9],
    orderEmail: row[10] || null
  }))
}

export const startCreditOrderActionSweeper = () => {
  if (!isEnabled()) {
    console.log(`${LABEL} disabled`)
    return () => {}
  }

  let running = false
  const runOnce = async () => {
    if (running) return
    running = true
    try {
      if (healthCheckAlertEnabled() && !healthCheckAlertSent) {
        healthCheckAlertSent = true
        const alertResult = await sendAdminAlertEmail({
          subject: 'Credit 订单执行链路健康检查',
          text: `healthcheck=credit-order-action-sweeper\nsentAt=${nowIso()}`
        })
        if (alertResult.ok) {
          console.info(`${LABEL} healthcheck alert sent`, { traceId: alertResult.traceId })
        } else {
          console.warn(`${LABEL} healthcheck alert skipped`, { reason: alertResult.error || 'unknown' })
        }
      }

      const features = await getFeatureFlags()
      if (!isFeatureEnabled(features, 'openAccounts')) return

      const db = await getDatabase()
      const pending = fetchPendingPaidOrders(db, 50)
      if (!pending.length) return

      const workerCount = Math.min(concurrency(), pending.length)
      const queue = [...pending]

      const worker = async () => {
        while (queue.length > 0) {
          const item = queue.shift()
          if (!item) return
          const orderNo = String(item.orderNo || '').trim()
          const uid = normalizeUid(item.uid)
          const targetAccountId = Number(item.targetAccountId)
          if (!orderNo || !uid || !Number.isFinite(targetAccountId) || targetAccountId <= 0) continue

          const lockKeys = [`credit:${orderNo}`, `uid:${uid}`, `acct:${targetAccountId}`]
          await withLocks(lockKeys, async () => {
            await fulfillOpenAccountsBoardOrder(db, item)
          })
        }
      }

      await Promise.all(Array.from({ length: workerCount }, worker))
    } catch (error) {
      console.error(`${LABEL} run failed`, { message: error?.message || String(error) })
    } finally {
      running = false
    }
  }

  const delay = initialDelayMs()
  const interval = intervalSeconds()

  const initialTimer = setTimeout(() => {
    void runOnce()
  }, delay)

  const intervalTimer = setInterval(() => {
    void runOnce()
  }, interval * 1000)

  console.log(`${LABEL} started`, {
    intervalSeconds: interval,
    initialDelayMs: delay,
    concurrency: concurrency(),
    maxRetries: maxRetries(),
    retryBaseSeconds: baseDelaySeconds(),
    retryMaxSeconds: maxDelaySeconds()
  })

  return () => {
    clearTimeout(initialTimer)
    clearInterval(intervalTimer)
  }
}
