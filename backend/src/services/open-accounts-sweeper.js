import { getDatabase, saveDatabase } from '../database/init.js'
import { withLocks } from '../utils/locks.js'
import { formatProxyForLog, loadProxyList, pickProxyByHash } from '../utils/proxy.js'
import { AccountSyncError, deleteAccountUser, fetchAccountUsersList, syncAccountInviteCount, syncAccountUserCount } from './account-sync.js'
import { sendOpenAccountsSweeperReportEmail } from './email-service.js'
import { getFeatureFlags, isFeatureEnabled } from '../utils/feature-flags.js'
import { SPACE_MEMBER_LIMIT } from '../utils/space-capacity.js'
import { enqueueAccountExceptionParseFailure, upsertAccountExceptionHistory } from './account-exception-history.js'

const DEFAULT_INTERVAL_HOURS = 1
const DEFAULT_MAX_JOINED = SPACE_MEMBER_LIMIT
const DEFAULT_CREATED_WITHIN_DAYS = 30

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const isEnabled = () => {
  const raw = String(process.env.OPEN_ACCOUNTS_SWEEPER_ENABLED ?? 'true').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

const isEnabledFlag = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') return Boolean(defaultValue)
  const raw = String(value).trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

const runOnStartup = () => isEnabledFlag(process.env.OPEN_ACCOUNTS_SWEEPER_RUN_ON_STARTUP, true)

// 间隔小时数，默认1小时
const intervalHours = () => Math.max(1, toInt(process.env.OPEN_ACCOUNTS_SWEEPER_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS))
const maxJoined = () => Math.max(0, toInt(process.env.OPEN_ACCOUNTS_MAX_JOINED, DEFAULT_MAX_JOINED))
const concurrency = () => Math.max(1, toInt(process.env.OPEN_ACCOUNTS_SWEEPER_CONCURRENCY, 3))
const createdWithinDays = () => Math.max(0, toInt(process.env.OPEN_ACCOUNTS_SWEEPER_CREATED_WITHIN_DAYS, DEFAULT_CREATED_WITHIN_DAYS))

const OPEN_ACCOUNTS_SWEEPER_SOURCE = 'open_accounts_sweeper'
const OPEN_ACCOUNTS_SWEEPER_EXCEPTION_TYPE = 'open_account_sweeper_failure'
const OPEN_ACCOUNTS_OVERCAPACITY_EXCEPTION_TYPE = 'open_account_overcapacity'
const OVERCAPACITY_STAGE = {
  DETECTED: 'detected',
  RESOLVED: 'resolved',
  ACTIVE: 'active',
}

export const mapOpenAccountsSweeperExceptionCode = ({ status, stage } = {}) => {
  const numericStatus = Number.parseInt(String(status ?? ''), 10)
  if (Number.isFinite(numericStatus) && numericStatus > 0) {
    return `http_${numericStatus}`
  }
  const normalizedStage = String(stage || '').trim().toLowerCase()
  if (normalizedStage) {
    return `stage_${normalizedStage.replace(/[^a-z0-9_]+/g, '_')}`
  }
  return 'unknown'
}

export const upsertOpenAccountsSweeperException = async (
  { accountId, accountName, exceptionCode, exceptionMessage, rawPayload } = {},
  options = {}
) => {
  const normalizedAccountId = Number.parseInt(String(accountId ?? ''), 10)
  if (!Number.isFinite(normalizedAccountId) || normalizedAccountId <= 0) {
    await enqueueAccountExceptionParseFailure({
      source: OPEN_ACCOUNTS_SWEEPER_SOURCE,
      reason: 'missing_account_id',
      rawPayload: rawPayload || {
        accountId,
        accountName,
        exceptionCode,
        exceptionMessage,
      },
    }, options)
    return { ok: false, reason: 'missing_account_id' }
  }

  return upsertAccountExceptionHistory({
    accountId: normalizedAccountId,
    accountName: String(accountName || '').trim() || null,
    exceptionType: OPEN_ACCOUNTS_SWEEPER_EXCEPTION_TYPE,
    exceptionCode: String(exceptionCode || 'unknown').trim() || 'unknown',
    exceptionMessage: String(exceptionMessage || '').trim() || 'Open 账号扫描失败',
    source: OPEN_ACCOUNTS_SWEEPER_SOURCE,
    status: 'active',
  }, options)
}

export const upsertOvercapacityHistory = async ({
  accountId,
  accountName,
  stage,
  beforeJoined,
  joined,
  maxJoinedCount,
  reason,
  failedUsers,
} = {}, options = {}) => {
  const normalizedStage = String(stage || '').trim().toLowerCase()
  let status = 'active'
  let message = `检测到超员：${beforeJoined}/${maxJoinedCount}`

  if (normalizedStage === OVERCAPACITY_STAGE.RESOLVED) {
    status = 'resolved'
    message = `超员已处理：${beforeJoined}/${maxJoinedCount} -> ${joined}/${maxJoinedCount}`
  } else if (normalizedStage === OVERCAPACITY_STAGE.ACTIVE) {
    status = 'active'
    if (reason === 'no_standard_users') {
      message = `超员未处理：无可踢用户（${joined}/${maxJoinedCount}）`
    } else if ((failedUsers || []).length > 0) {
      const firstFailed = failedUsers[0] || {}
      const failedMessage = String(firstFailed.message || '').trim()
      message = `超员未处理：${failedMessage || '踢人失败'}（${joined}/${maxJoinedCount}）`
    } else {
      message = `超员未处理：仍超上限（${joined}/${maxJoinedCount}）`
    }
  }

  return upsertAccountExceptionHistory({
    accountId,
    accountName,
    exceptionType: OPEN_ACCOUNTS_OVERCAPACITY_EXCEPTION_TYPE,
    exceptionCode: `overcapacity_${normalizedStage || OVERCAPACITY_STAGE.DETECTED}`,
    exceptionMessage: message,
    source: OPEN_ACCOUNTS_SWEEPER_SOURCE,
    status,
  }, options)
}

const parseTime = (value) => {
  const time = Date.parse(String(value || ''))
  return Number.isFinite(time) ? time : 0
}

const fetchAllStandardUsers = async (accountId, { proxy } = {}) => {
  const limit = 100
  let offset = 0
  let total = null
  const items = []

  while (total === null || items.length < total) {
    const page = await fetchAccountUsersList(accountId, { userListParams: { offset, limit, query: '' }, proxy })
    total = typeof page.total === 'number' ? page.total : items.length
    items.push(...(page.items || []))
    if (!page.items || page.items.length === 0) break
    offset += page.items.length
    if (offset > 2000) break
  }

  return {
    total: typeof total === 'number' ? total : items.length,
    items: (items || []).filter(item => String(item.role || '').toLowerCase() === 'standard-user')
  }
}


const listProtectedSeatEmails = async () => {
  const db = await getDatabase()
  const result = db.exec(
    `
      SELECT target_email
      FROM open_account_seat_protections
      WHERE target_email IS NOT NULL
        AND TRIM(target_email) <> ''
        AND (expires_at IS NULL OR expires_at = '' OR expires_at > DATETIME('now', 'localtime'))
    `
  )

  const values = result[0]?.values || []
  return new Set(
    values
      .map(row => String(row[0] || '').trim().toLowerCase())
      .filter(Boolean)
  )
}

export const sortUsersByJoinTimeDesc = (users) => {
  return [...(users || [])].sort((a, b) => {
    const diff = parseTime(b.created_time) - parseTime(a.created_time)
    if (diff !== 0) return diff
    return String(b.id || '').localeCompare(String(a.id || ''))
  })
}

export const selectUsersToKick = ({ users, currentJoined, maxJoinedCount, protectedEmailSet } = {}) => {
  const overflow = Math.max(0, Number(currentJoined || 0) - Number(maxJoinedCount || 0))
  if (overflow <= 0) return []

  const protectedEmails = protectedEmailSet instanceof Set ? protectedEmailSet : new Set()
  const protectedUsers = []
  const normalUsers = []

  for (const user of (users || [])) {
    const email = String(user?.email || '').trim().toLowerCase()
    if (email && protectedEmails.has(email)) {
      protectedUsers.push(user)
      continue
    }
    normalUsers.push(user)
  }

  const sortedNormalUsers = sortUsersByJoinTimeDesc(normalUsers)
  const sortedProtectedUsers = sortUsersByJoinTimeDesc(protectedUsers)
  const sorted = [...sortedNormalUsers, ...sortedProtectedUsers]
  return sorted.slice(0, overflow)
}

const enforceAccountCapacity = async (accountId, { maxJoinedCount, proxy } = {}) => {
  // Sync joined count first; the API's total is authoritative.
  const { account } = await syncAccountUserCount(accountId, { userListParams: { offset: 0, limit: 1, query: '' }, proxy })
  let joined = Number(account?.userCount || 0)
  const beforeJoined = joined

  if (joined <= maxJoinedCount) {
    // Still refresh invite count so card page stays reasonably up to date.
    await syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' }, proxy })
    return { kicked: 0, joined, beforeJoined, kickedUsers: [], skippedUsers: [], failedUsers: [] }
  }

  let kicked = 0
  const kickedUsers = []
  const skippedUsers = []
  const failedUsers = []

  let attempt = 0
  while (joined > maxJoinedCount && attempt < 3) {
    const { items: candidates } = await fetchAllStandardUsers(accountId, { proxy })
    if (candidates.length === 0) {
      await syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' }, proxy })
      return { kicked, joined, beforeJoined, reason: 'no_standard_users', kickedUsers, skippedUsers, failedUsers }
    }

    const protectedEmailSet = await listProtectedSeatEmails()
    const toKick = selectUsersToKick({ users: candidates, currentJoined: joined, maxJoinedCount, protectedEmailSet })
    if (toKick.length === 0) break

    for (const user of toKick) {
      if (joined <= maxJoinedCount) break
      try {
        const deleteResult = await deleteAccountUser(accountId, user.id, { userListParams: { offset: 0, limit: 1, query: '' }, proxy })
        const email = String(user.email || '').trim().toLowerCase()
        if (email) {
          const db = await getDatabase()
          db.run(
            `
              UPDATE linuxdo_users
              SET current_open_account_id = NULL,
                  current_open_account_email = NULL,
                  updated_at = DATETIME('now', 'localtime')
              WHERE current_open_account_id = ?
                AND (lower(email) = ? OR lower(current_open_account_email) = ?)
            `,
            [accountId, email, email]
          )
          saveDatabase()
        }
        kicked += 1
        joined = Number(deleteResult?.syncedUserCount || deleteResult?.account?.userCount || Math.max(0, joined - 1))
        kickedUsers.push({
          id: user.id,
          email: user.email,
          joinedAt: user.created_time || null
        })
      } catch (error) {
        const status = error instanceof AccountSyncError ? error.status : undefined
        if (status === 404) {
          skippedUsers.push({
            id: user.id,
            email: user.email,
            joinedAt: user.created_time || null,
            reason: 'not_found'
          })
          continue
        }
        failedUsers.push({
          id: user.id,
          email: user.email,
          joinedAt: user.created_time || null,
          status,
          message: error?.message || String(error)
        })
        console.warn('[OpenAccountsSweeper] kick failed', { accountId, userId: user?.id, status, message: error?.message || String(error) })
        break
      }
    }

    const refreshed = await syncAccountUserCount(accountId, { userListParams: { offset: 0, limit: 1, query: '' }, proxy })
    joined = Number(refreshed?.account?.userCount || joined)
    attempt += 1
  }

  if (joined <= maxJoinedCount) {
    await syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' }, proxy })
    return { kicked, joined, beforeJoined, kickedUsers, skippedUsers, failedUsers }
  }

  const candidates = await fetchAllStandardUsers(accountId, { proxy })
  if ((candidates?.items || []).length === 0) {
    await syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' }, proxy })
    return { kicked, joined, beforeJoined, reason: 'no_standard_users', kickedUsers, skippedUsers, failedUsers }
  }

  // Refresh counts for card page after kicking.
  const { account: updatedAccount } = await syncAccountUserCount(accountId, { userListParams: { offset: 0, limit: 1, query: '' }, proxy })
  await syncAccountInviteCount(accountId, { inviteListParams: { offset: 0, limit: 1, query: '' }, proxy })

  return { kicked, joined: Number(updatedAccount?.userCount || 0), beforeJoined, kickedUsers, skippedUsers, failedUsers }
}

export const startOpenAccountsOvercapacitySweeper = () => {
  if (!isEnabled()) {
    console.log('[OpenAccountsSweeper] disabled', {
      enabled: String(process.env.OPEN_ACCOUNTS_SWEEPER_ENABLED ?? 'true')
    })
    return () => {}
  }

  let running = false
  const runOnce = async () => {
    if (running) return
    running = true
    const startedAt = new Date()
    try {
      const features = await getFeatureFlags()
      if (!isFeatureEnabled(features, 'openAccounts')) {
        console.log('[OpenAccountsSweeper] skipped (feature disabled)', {
          feature_open_accounts_enabled: features?.openAccounts
        })
        return
      }

      const db = await getDatabase()
	      const windowDays = createdWithinDays()
	      const result = windowDays > 0
	        ? db.exec(
	            `SELECT id, email FROM gpt_accounts WHERE is_open = 1 AND COALESCE(is_banned, 0) = 0 AND created_at >= DATETIME('now', 'localtime', ?)`,
	            [`-${windowDays} days`]
	          )
	        : db.exec('SELECT id, email FROM gpt_accounts WHERE is_open = 1 AND COALESCE(is_banned, 0) = 0')
      const max = maxJoined()
      const accountRows = (result[0]?.values || [])
        .map(row => {
          const id = Number(row[0])
          const email = String(row[1] || '')
          const emailPrefix = email.split('@')[0] || ''
          return Number.isFinite(id) ? { id, emailPrefix } : null
        })
        .filter(Boolean)
      if (accountRows.length === 0) {
        console.log('[OpenAccountsSweeper] no open accounts to scan', {
          scanCreatedWithinDays: windowDays
        })
        await sendOpenAccountsSweeperReportEmail({
          startedAt,
          finishedAt: new Date(),
          maxJoined: max,
          scanCreatedWithinDays: windowDays,
          scannedCount: 0,
          totalKicked: 0,
          results: [],
          failures: []
        })
        return
      }

      const workerCount = Math.min(concurrency(), accountRows.length)
      const queue = [...accountRows]
      const proxies = loadProxyList()
      let proxyCursor = 0
      const pickProxy = () => (proxies.length ? proxies[(proxyCursor++) % proxies.length] : null)
      const results = []
      const failures = []
      let totalKicked = 0

      const worker = async () => {
        while (queue.length > 0) {
	          const item = queue.shift()
	          if (!item) return
	          const { id, emailPrefix } = item
	          const proxyEntry = pickProxyByHash(proxies, id)
	          const proxy = proxyEntry?.url || null
	          const proxyLabel = proxyEntry ? formatProxyForLog(proxyEntry.url) : null
          await withLocks([`acct:${id}`], async () => {
            try {
              const outcome = await enforceAccountCapacity(id, { maxJoinedCount: max, proxy })
              const kicked = Number(outcome?.kicked || 0)
              const joined = Number(outcome?.joined || 0)
              const beforeJoined = Number(outcome?.beforeJoined || joined)
              const didKick = kicked > 0
              totalKicked += kicked
              results.push({
                accountId: id,
                emailPrefix,
                beforeJoined,
                joined,
                didKick,
                kicked,
                kickedUsers: outcome?.kickedUsers || [],
                skippedUsers: outcome?.skippedUsers || [],
                failedUsers: outcome?.failedUsers || [],
                note: outcome?.reason === 'no_standard_users' ? '无可踢用户' : (kicked ? '超员已处理' : '')
              })
              if (kicked || (outcome?.failedUsers || []).length > 0) {
                console.log('[OpenAccountsSweeper] kicked', {
                  accountId: id,
                  beforeJoined,
                  afterJoined: joined,
                  maxJoined: max,
                  kicked,
                  kickedUsers: outcome?.kickedUsers || [],
                  failedUsers: outcome?.failedUsers || []
                })
              }

              if (beforeJoined > max) {
                await upsertOvercapacityHistory({
                  accountId: id,
                  accountName: emailPrefix,
                  stage: OVERCAPACITY_STAGE.DETECTED,
                  beforeJoined,
                  joined,
                  maxJoinedCount: max,
                  reason: outcome?.reason,
                  failedUsers: outcome?.failedUsers || [],
                })

                if (joined <= max) {
                  await upsertOvercapacityHistory({
                    accountId: id,
                    accountName: emailPrefix,
                    stage: OVERCAPACITY_STAGE.RESOLVED,
                    beforeJoined,
                    joined,
                    maxJoinedCount: max,
                    reason: outcome?.reason,
                    failedUsers: outcome?.failedUsers || [],
                  })
                } else {
                  await upsertOvercapacityHistory({
                    accountId: id,
                    accountName: emailPrefix,
                    stage: OVERCAPACITY_STAGE.ACTIVE,
                    beforeJoined,
                    joined,
                    maxJoinedCount: max,
                    reason: outcome?.reason,
                    failedUsers: outcome?.failedUsers || [],
                  })
                }
              }

              if ((outcome?.failedUsers || []).length > 0) {
                const firstFailedUser = outcome.failedUsers[0] || {}
                const failedStatus = Number.parseInt(String(firstFailedUser.status ?? ''), 10)
                const failedMessage = String(firstFailedUser.message || '').trim() || '账号容量治理时踢人失败'
                await upsertOpenAccountsSweeperException({
                  accountId: id,
                  accountName: emailPrefix,
                  exceptionCode: mapOpenAccountsSweeperExceptionCode({ status: failedStatus, stage: 'enforce_account_capacity' }),
                  exceptionMessage: failedMessage,
                  rawPayload: {
                    accountId: id,
                    emailPrefix,
                    stage: 'enforce_account_capacity',
                    failedUsers: outcome.failedUsers,
                  },
                })
              }
            } catch (error) {
              const status = error instanceof AccountSyncError ? error.status : error?.status
              const code = mapOpenAccountsSweeperExceptionCode({ status, stage: 'worker' })
              const message = error?.message || String(error)
              console.error('[OpenAccountsSweeper] sweep error', {
                accountId: id,
                proxy: proxyLabel,
                message
              })
              failures.push({ accountId: id, emailPrefix, error: message })
              await upsertOpenAccountsSweeperException({
                accountId: id,
                accountName: emailPrefix,
                exceptionCode: code,
                exceptionMessage: message,
                rawPayload: {
                  accountId: id,
                  emailPrefix,
                  stage: 'worker',
                  status,
                  message,
                },
              })
            }
          })
        }
      }

      await Promise.all(Array.from({ length: workerCount }, worker))

      const finishedAt = new Date()

      // 按邮箱名称排序
      results.sort((a, b) => (a.emailPrefix || '').localeCompare(b.emailPrefix || ''))
      failures.sort((a, b) => (a.emailPrefix || '').localeCompare(b.emailPrefix || ''))

      try {
        await sendOpenAccountsSweeperReportEmail({
          startedAt,
          finishedAt,
          maxJoined: max,
          scanCreatedWithinDays: windowDays,
          scannedCount: accountRows.length,
          totalKicked,
          results,
          failures
        })
      } catch (error) {
        console.warn('[OpenAccountsSweeper] send email failed', error?.message || error)
      }
    } finally {
      running = false
    }
  }

  // 计算下一个整点执行时间
  const getNextScheduledTime = () => {
    const now = new Date()
    const hours = intervalHours()
    // 计算下一个整点（基于间隔小时数）
    const currentHour = now.getHours()
    // 找到下一个符合间隔的整点小时
    const nextHour = Math.ceil((currentHour + 1) / hours) * hours
    const next = new Date(now)
    next.setHours(nextHour % 24, 0, 0, 0)
    // 如果计算出的时间已经过了，加一天
    if (next <= now) {
      next.setDate(next.getDate() + 1)
      next.setHours(0, 0, 0, 0)
    }
    return next
  }

  // 调度下一次执行
  let scheduledTimer = null
  const scheduleNext = () => {
    const nextTime = getNextScheduledTime()
    const delay = nextTime.getTime() - Date.now()
    console.log('[OpenAccountsSweeper] next run scheduled at', nextTime.toISOString(), `(in ${Math.round(delay / 1000 / 60)} minutes)`)
    scheduledTimer = setTimeout(async () => {
      await runOnce()
      scheduleNext()
    }, delay)
  }

  // 直接开始整点调度，不在启动时执行
  scheduleNext()

  if (runOnStartup()) {
    runOnce().catch(error => {
      console.warn('[OpenAccountsSweeper] startup run failed', error?.message || error)
    })
  }

  console.log('[OpenAccountsSweeper] started', {
    intervalHours: intervalHours(),
    maxJoined: maxJoined(),
    concurrency: concurrency(),
    runOnStartup: runOnStartup(),
    createdWithinDays: createdWithinDays()
  })

  return () => {
    if (scheduledTimer) clearTimeout(scheduledTimer)
  }
}
