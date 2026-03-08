import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { apiKeyAuth } from '../middleware/api-key-auth.js'
import { requireMenu } from '../middleware/rbac.js'
import { syncAccountUserCount, syncAccountInviteCount, fetchOpenAiAccountInfo, AccountSyncError, deleteAccountUser, inviteAccountUser, deleteAccountInvite, isWorkspaceExpiredSyncError, refreshAccountAccessToken } from '../services/account-sync.js'
import { SPACE_MEMBER_LIMIT, calcRedeemableSlots, normalizeMemberCount } from '../utils/space-capacity.js'
import { getWorkspaceExpiredReason, isTokenInvalidSyncError, markAccountSpaceStatus, resolveSpaceStatus } from '../services/account-space-status.js'
import { SPACE_TYPE_CHILD, normalizeSpaceType, shouldAutoGenerateCodes } from '../utils/space-type.js'
import { withLocks } from '../utils/locks.js'

const router = express.Router()
const SYNC_ALL_TASK_TTL_MS = 30 * 60 * 1000
const syncAllTaskStore = new Map()

const generateSyncAllTaskId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const cleanupExpiredSyncAllTasks = () => {
  const now = Date.now()
  for (const [taskId, task] of syncAllTaskStore.entries()) {
    const finishedAt = task?.finishedAt ? Date.parse(task.finishedAt) : null
    if (finishedAt && Number.isFinite(finishedAt) && now - finishedAt > SYNC_ALL_TASK_TTL_MS) {
      syncAllTaskStore.delete(taskId)
    }
  }
}

const createSyncAllTaskSnapshot = (task) => ({
  taskId: task.taskId,
  status: task.status,
  total: task.total,
  completed: task.completed,
  successCount: task.successCount,
  failedCount: task.failedCount,
  results: task.results,
  startedAt: task.startedAt,
  finishedAt: task.finishedAt
})

const startSyncAllTask = async ({ ids, db }) => {
  const taskId = generateSyncAllTaskId()
  const task = {
    taskId,
    status: 'running',
    total: ids.length,
    completed: 0,
    successCount: 0,
    failedCount: 0,
    results: [],
    startedAt: new Date().toISOString(),
    finishedAt: null
  }
  syncAllTaskStore.set(taskId, task)

  ;(async () => {
    try {
      for (const accountId of ids) {
        try {
          const userSync = await syncAccountUserCount(accountId)
          const inviteSync = await syncAccountInviteCount(accountId, {
            accountRecord: userSync.account,
            inviteListParams: { offset: 0, limit: 1, query: '' }
          })
          await markAccountSpaceStatus(accountId, { code: 'normal', reason: '正常' }, { db })
          task.successCount += 1
          task.results.push({
            id: accountId,
            ok: true,
            account: {
              ...inviteSync.account,
              spaceStatusCode: 'normal',
              spaceStatusReason: '正常',
              spaceStatus: resolveSpaceStatus({ ...inviteSync.account, spaceStatusCode: 'normal', spaceStatusReason: '正常' })
            },
            syncedUserCount: userSync.syncedUserCount,
            inviteCount: inviteSync.inviteCount
          })
        } catch (error) {
          if (isTokenInvalidSyncError(error)) {
            await markAccountSpaceStatus(accountId, { code: 'abnormal', reason: 'Token 已过期或无效，请更新账号 token' }, { db })
          }
          if (isWorkspaceExpiredSyncError(error)) {
            await markAccountSpaceStatus(accountId, { code: 'abnormal', reason: getWorkspaceExpiredReason() }, { db })
          }
          task.failedCount += 1
          task.results.push({ id: accountId, ok: false, error: error?.message || '同步失败', code: error?.code || null })
        } finally {
          task.completed += 1
        }
      }
      task.status = 'completed'
      task.finishedAt = new Date().toISOString()
    } catch (error) {
      task.status = 'failed'
      task.finishedAt = new Date().toISOString()
      task.results.push({
        id: null,
        ok: false,
        error: error?.message || '批量同步执行失败',
        code: error?.code || null
      })
      task.failedCount += 1
      console.error('批量同步后台任务失败:', error)
    }
  })()

  return task
}

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()


const getProtectedSeatEmailSet = async (database) => {
  if (!database) return new Set()
  const result = database.exec(
    `
      SELECT target_email
      FROM open_account_seat_protections
      WHERE target_email IS NOT NULL
        AND TRIM(target_email) <> ''
        AND (expires_at IS NULL OR expires_at = '' OR expires_at > DATETIME('now', 'localtime'))
    `
  )

  const rows = result[0]?.values || []
  return new Set(
    rows
      .map(row => normalizeEmail(row[0]))
      .filter(Boolean)
  )
}


const upsertSystemInviteProtection = async (database, email) => {
  if (!database) return
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) return

  const existing = database.exec(
    `
      SELECT id
      FROM open_account_seat_protections
      WHERE lower(target_email) = ?
        AND source_channel = 'system_invite'
      LIMIT 1
    `,
    [normalizedEmail]
  )

  if (existing[0]?.values?.length) {
    const protectionId = Number(existing[0].values[0][0])
    database.run(
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

  database.run(
    `
      INSERT INTO open_account_seat_protections (
        target_email,
        source_channel,
        created_at,
        updated_at
      )
      VALUES (?, 'system_invite', DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
    `,
    [normalizedEmail]
  )
}

const appendProtectedMemberSuffix = (usersResponse, protectedEmailSet) => {
  if (!usersResponse || !Array.isArray(usersResponse.items)) return usersResponse

  return {
    ...usersResponse,
    items: usersResponse.items.map(user => {
      const rawEmail = String(user?.email || '').trim()
      const email = normalizeEmail(rawEmail)
      const isProtected = Boolean(email && protectedEmailSet.has(email))
      return {
        ...user,
        isProtected,
        emailDisplay: isProtected && rawEmail ? `${rawEmail} [保护]` : rawEmail
      }
    })
  }
}


const appendProtectedInviteSuffix = (invitesResponse, protectedEmailSet) => {
  if (!invitesResponse || !Array.isArray(invitesResponse.items)) return invitesResponse

  return {
    ...invitesResponse,
    items: invitesResponse.items.map(invite => {
      const rawEmail = String(invite?.email_address || '').trim()
      const email = normalizeEmail(rawEmail)
      const isProtected = Boolean(email && protectedEmailSet.has(email))
      return {
        ...invite,
        isProtected,
        emailDisplay: isProtected && rawEmail ? `${rawEmail} [保护]` : rawEmail
      }
    })
  }
}


const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  if (['1', 'true', 'yes'].includes(raw)) return true
  if (['0', 'false', 'no'].includes(raw)) return false
  return null
}

const EXPIRE_AT_REGEX = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/

const formatExpireAt = (date) => {
  const pad = (value) => String(value).padStart(2, '0')
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date)
    const get = (type) => parts.find(p => p.type === type)?.value || ''
    return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
  } catch {
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }
}

const normalizeExpireAt = (value) => {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (EXPIRE_AT_REGEX.test(raw)) return raw

  // 支持 YYYY-MM-DD HH:mm:ss 或 YYYY/MM/DDTHH:mm:ss 格式
  const match = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (match) {
    const seconds = match[6] || '00'
    return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}:${seconds}`
  }

  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && asNumber > 0) {
    const date = new Date(asNumber)
    if (!Number.isNaN(date.getTime())) {
      return formatExpireAt(date)
    }
  }

  return null
}

const normalizeShanghaiDateTime = (value) => {
  const normalized = normalizeExpireAt(value)
  if (normalized) return normalized
  return null
}

const normalizeSpaceTypeInput = (value, fallback = null) => normalizeSpaceType(value, fallback)

const hasDuplicateSortOrder = (db) => {
  try {
    const result = db.exec(`
      SELECT sort_order, COUNT(*) AS count
      FROM gpt_accounts
      WHERE sort_order IS NOT NULL
      GROUP BY sort_order
      HAVING COUNT(*) > 1
      LIMIT 1
    `)
    return Boolean(result[0]?.values?.length)
  } catch {
    return false
  }
}

const rebuildSortOrderByCreatedDesc = (db) => {
  const rows = db.exec(`
    SELECT id
    FROM gpt_accounts
    ORDER BY created_at DESC, id DESC
  `)
  const ids = (rows[0]?.values || []).map((row) => Number(row[0])).filter(Number.isFinite)
  ids.forEach((id, index) => {
    db.run(
      `UPDATE gpt_accounts SET sort_order = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
      [index + 1, id]
    )
  })
  if (ids.length) saveDatabase()
}

const getAccountById = (db, accountId) => {
  let result
  let hasStatusColumns = true

  try {
    result = db.exec(
      `
        SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
               COALESCE(is_demoted, 0) AS is_demoted,
               COALESCE(is_banned, 0) AS is_banned,
               COALESCE(sort_order, id) AS sort_order,
               COALESCE(space_type, '${SPACE_TYPE_CHILD}') AS space_type,
               COALESCE(space_status_code, 'unknown') AS space_status_code,
               space_status_reason,
               COALESCE(space_name, '') AS space_name,
               created_at, updated_at
        FROM gpt_accounts
        WHERE id = ?
      `,
      [accountId]
    )
  } catch (error) {
    hasStatusColumns = false
    console.warn('[GptAccounts] fallback account query (legacy schema):', error?.message || error)
    result = db.exec(
      `
        SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
               COALESCE(is_demoted, 0) AS is_demoted,
               COALESCE(is_banned, 0) AS is_banned,
               COALESCE(sort_order, id) AS sort_order,
               COALESCE(space_type, '${SPACE_TYPE_CHILD}') AS space_type,
               COALESCE(space_name, '') AS space_name,
               created_at, updated_at
        FROM gpt_accounts
        WHERE id = ?
      `,
      [accountId]
    )
  }

  if (!result[0]?.values?.length) return null
  const row = result[0].values[0]
  const spaceStatusCode = hasStatusColumns ? (row[14] || 'unknown') : 'unknown'
  const spaceStatusReason = hasStatusColumns ? (row[15] || '') : ''
  const spaceName = hasStatusColumns ? (row[16] || '') : (row[14] || '')
  const createdAt = hasStatusColumns ? row[17] : row[15]
  const updatedAt = hasStatusColumns ? row[18] : row[16]

  return {
    id: row[0],
    email: row[1],
    token: row[2],
    refreshToken: row[3],
    userCount: row[4],
    inviteCount: row[5],
    chatgptAccountId: row[6],
    oaiDeviceId: row[7],
    expireAt: row[8] || null,
    isOpen: Boolean(row[9]),
    isBanned: Boolean(row[11]),
    sortOrder: Number(row[12] || 0),
    spaceType: row[13] || SPACE_TYPE_CHILD,
    spaceStatusCode,
    spaceStatusReason,
    spaceName,
    createdAt,
    updatedAt,
    spaceStatus: resolveSpaceStatus({
      isBanned: Boolean(row[11]),
      token: row[2],
      spaceStatusCode,
      spaceStatusReason
    })
  }
}

const collectEmails = (payload) => {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.emails)) return payload.emails
  if (typeof payload.emails === 'string') return [payload.emails]
  if (typeof payload.email === 'string') return [payload.email]
  return []
}

// 使用系统设置中的 API 密钥（x-api-key）标记账号为“封号”
router.post('/ban', apiKeyAuth, async (req, res) => {
  try {
    const rawEmails = collectEmails(req.body)
    const emails = [...new Set(rawEmails.map(normalizeEmail).filter(Boolean))]

    if (emails.length === 0) {
      return res.status(400).json({ error: 'emails is required' })
    }
    if (emails.length > 500) {
      return res.status(400).json({ error: 'emails is too large (max 500)' })
    }

    const db = await getDatabase()
    const placeholders = emails.map(() => '?').join(',')

    const existing = db.exec(
      `
        SELECT id, email
        FROM gpt_accounts
        WHERE LOWER(email) IN (${placeholders})
      `,
      emails
    )

    const matched = (existing[0]?.values || [])
      .map(row => ({
        id: Number(row[0]),
        email: String(row[1] || '')
      }))
      .filter(item => Number.isFinite(item.id) && item.email)

    const matchedSet = new Set(matched.map(item => normalizeEmail(item.email)))
    const notFound = emails.filter(email => !matchedSet.has(email))

    if (matched.length > 0) {
      db.run(
        `
          UPDATE gpt_accounts
          SET is_open = 0,
              is_banned = 1,
              updated_at = DATETIME('now', 'localtime')
          WHERE LOWER(email) IN (${placeholders})
        `,
        emails
      )
      saveDatabase()
    }

    return res.json({
      message: 'ok',
      updated: matched.length,
      matched,
      notFound
    })
  } catch (error) {
    console.error('Ban GPT accounts by email error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.use(authenticateToken, requireMenu('accounts'))

// 校验 access token，并返回可用的 Team 账号列表（用于新建账号时选择 chatgptAccountId）
router.post('/check-token', async (req, res) => {
  try {
    const { token, proxy } = req.body || {}
    const normalizedToken = String(token ?? '').trim()
    if (!normalizedToken) {
      return res.status(400).json({ error: 'token is required' })
    }

    const accounts = await fetchOpenAiAccountInfo(normalizedToken, proxy ?? null)
    return res.json({ accounts })
  } catch (error) {
    console.error('Check GPT token error:', error)

    if (error instanceof AccountSyncError || error?.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    return res.status(500).json({ error: '内部服务器错误' })
  }
})

// 获取账号列表（支持分页、搜索、筛选）
router.get('/', async (req, res) => {
  try {
    const db = await getDatabase()
    // 历史版本曾写入重复 sort_order，会导致列表“看起来乱序”。
    // 读取列表前自动修复一次，避免用户持续看到错乱结果。
    if (hasDuplicateSortOrder(db)) {
      rebuildSortOrderByCreatedDesc(db)
    }

    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10))
    const search = (req.query.search || '').trim().toLowerCase()
    const memberSearch = (req.query.memberSearch || req.query.member_search || '').trim().toLowerCase()
    const openStatus = req.query.openStatus // 'open' | 'closed' | undefined
    const rawSpaceStatus = req.query.spaceStatus ?? req.query.space_status
    const hasSpaceStatus = rawSpaceStatus != null && String(rawSpaceStatus).trim() !== ''
    const normalizedSpaceStatus = hasSpaceStatus ? String(rawSpaceStatus).trim().toLowerCase() : null
    if (hasSpaceStatus && !['normal', 'abnormal', 'unknown'].includes(normalizedSpaceStatus)) {
      return res.status(400).json({ error: 'Invalid spaceStatus' })
    }
    const rawSpaceType = req.query.spaceType ?? req.query.space_type
    const hasSpaceType = rawSpaceType != null && String(rawSpaceType).trim() !== ''
    const normalizedSpaceType = hasSpaceType ? normalizeSpaceTypeInput(rawSpaceType, null) : null
    if (hasSpaceType && !normalizedSpaceType) {
      return res.status(400).json({ error: 'Invalid spaceType' })
    }

    // 构建 WHERE 条件
    const conditions = []
    const params = []

    if (search) {
      conditions.push(`(LOWER(email) LIKE ? OR LOWER(token) LIKE ? OR LOWER(refresh_token) LIKE ? OR LOWER(chatgpt_account_id) LIKE ?)`)
      const searchPattern = `%${search}%`
      params.push(searchPattern, searchPattern, searchPattern, searchPattern)
    }

    if (memberSearch) {
      conditions.push(`EXISTS (
        SELECT 1
        FROM gpt_account_members gm
        WHERE gm.account_id = gpt_accounts.id
          AND (
            LOWER(COALESCE(gm.email, '')) LIKE ?
            OR LOWER(COALESCE(gm.name, '')) LIKE ?
            OR LOWER(COALESCE(gm.member_id, '')) LIKE ?
          )
      )`)
      const memberSearchPattern = `%${memberSearch}%`
      params.push(memberSearchPattern, memberSearchPattern, memberSearchPattern)
    }

    if (openStatus === 'open') {
      conditions.push('is_open = 1')
    } else if (openStatus === 'closed') {
      conditions.push('(is_open = 0 OR is_open IS NULL)')
    }

    if (normalizedSpaceStatus === 'normal') {
      conditions.push("COALESCE(space_status_code, 'unknown') = 'normal'")
    } else if (normalizedSpaceStatus === 'abnormal') {
      conditions.push("COALESCE(space_status_code, 'unknown') != 'normal'")
    } else if (normalizedSpaceStatus === 'unknown') {
      conditions.push("COALESCE(space_status_code, 'unknown') = 'unknown'")
    }

    if (normalizedSpaceType) {
      conditions.push(`COALESCE(space_type, '${SPACE_TYPE_CHILD}') = ?`)
      params.push(normalizedSpaceType)
    }

    const hasMemberSearch = Boolean(memberSearch)
    const memberSearchPattern = `%${memberSearch}%`
    const matchedMemberSelectClause = hasMemberSearch
      ? `
               (
                 SELECT COALESCE(NULLIF(gm.name, ''), NULLIF(gm.email, ''), NULLIF(gm.member_id, ''), '')
                 FROM gpt_account_members gm
                 WHERE gm.account_id = gpt_accounts.id
                   AND (
                     LOWER(COALESCE(gm.email, '')) LIKE ?
                     OR LOWER(COALESCE(gm.name, '')) LIKE ?
                     OR LOWER(COALESCE(gm.member_id, '')) LIKE ?
                   )
                 ORDER BY COALESCE(gm.updated_at, gm.synced_at) DESC, gm.id DESC
                 LIMIT 1
               ) AS matched_member_label,
               (
                 SELECT COUNT(*)
                 FROM gpt_account_members gm
                 WHERE gm.account_id = gpt_accounts.id
                   AND (
                     LOWER(COALESCE(gm.email, '')) LIKE ?
                     OR LOWER(COALESCE(gm.name, '')) LIKE ?
                     OR LOWER(COALESCE(gm.member_id, '')) LIKE ?
                   )
               ) AS matched_member_count`
      : `'' AS matched_member_label,
               0 AS matched_member_count`

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // 查询总数
    const countResult = db.exec(`SELECT COUNT(*) FROM gpt_accounts ${whereClause}`, params)
    const total = countResult[0]?.values?.[0]?.[0] || 0

	    // 查询分页数据
	    const offset = (page - 1) * pageSize
    let dataResult
    try {
      dataResult = db.exec(`
        SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
               COALESCE(is_demoted, 0) AS is_demoted,
               COALESCE(is_banned, 0) AS is_banned,
               COALESCE(sort_order, id) AS sort_order,
               COALESCE(space_type, '${SPACE_TYPE_CHILD}') AS space_type,
               COALESCE(space_status_code, 'unknown') AS space_status_code,
               space_status_reason,
               COALESCE(space_name, '') AS space_name,
               created_at, updated_at,
               ${matchedMemberSelectClause}
        FROM gpt_accounts
        ${whereClause}
        ORDER BY COALESCE(sort_order, id) ASC, created_at DESC, id ASC
        LIMIT ? OFFSET ?
      `, [
        ...params,
        ...(hasMemberSearch ? [
          memberSearchPattern,
          memberSearchPattern,
          memberSearchPattern,
          memberSearchPattern,
          memberSearchPattern,
          memberSearchPattern,
        ] : []),
        pageSize,
        offset
      ])
    } catch (error) {
      console.warn('[GptAccounts] fallback list query (legacy schema):', error?.message || error)
      dataResult = db.exec(`
        SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
               COALESCE(is_demoted, 0) AS is_demoted,
               COALESCE(is_banned, 0) AS is_banned,
               COALESCE(sort_order, id) AS sort_order,
               COALESCE(space_name, '') AS space_name,
               created_at, updated_at,
               ${matchedMemberSelectClause}
        FROM gpt_accounts
        ${whereClause}
        ORDER BY COALESCE(sort_order, id) ASC, created_at DESC, id ASC
        LIMIT ? OFFSET ?
      `, [
        ...params,
        ...(hasMemberSearch ? [
          memberSearchPattern,
          memberSearchPattern,
          memberSearchPattern,
          memberSearchPattern,
          memberSearchPattern,
          memberSearchPattern,
        ] : []),
        pageSize,
        offset
      ])
    }

    const accounts = (dataResult[0]?.values || []).map(row => {
      const hasStatusColumns = row.length >= 21
      const spaceType = hasStatusColumns ? (row[13] || SPACE_TYPE_CHILD) : SPACE_TYPE_CHILD
      const spaceStatusCode = hasStatusColumns ? (row[14] || 'normal') : 'normal'
      const spaceStatusReason = hasStatusColumns ? (row[15] || '') : ''
      const spaceName = hasStatusColumns ? (row[16] || '') : (row[13] || '')
      const createdAt = hasStatusColumns ? row[17] : row[14]
      const updatedAt = hasStatusColumns ? row[18] : row[15]
      const matchedMemberLabel = String(row[row.length - 2] || '').trim()
      const matchedMemberCount = Number(row[row.length - 1] || 0)

      return {
        id: row[0],
        email: row[1],
        token: row[2],
        refreshToken: row[3],
        userCount: row[4],
        inviteCount: row[5],
        chatgptAccountId: row[6],
        oaiDeviceId: row[7],
        expireAt: row[8] || null,
        isOpen: Boolean(row[9]),
        isBanned: Boolean(row[11]),
        sortOrder: Number(row[12] || 0),
        spaceType,
        spaceStatusCode,
        spaceStatusReason,
        spaceName,
        matchedMemberLabel,
        matchedMemberCount,
        createdAt,
        updatedAt,
        spaceStatus: resolveSpaceStatus({
          isBanned: Boolean(row[11]),
          token: row[2],
          spaceStatusCode,
          spaceStatusReason
        })
      }
    })

    res.json({
      accounts,
      pagination: { page, pageSize, total }
    })
  } catch (error) {
    console.error('Get GPT accounts error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get a single GPT account
router.get('/:id', async (req, res) => {
  try {
	    const db = await getDatabase()
	    const result = db.exec(`
	      SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
	             COALESCE(is_demoted, 0) AS is_demoted,
	             COALESCE(is_banned, 0) AS is_banned,
	             COALESCE(space_type, '${SPACE_TYPE_CHILD}') AS space_type,
	             created_at, updated_at
	      FROM gpt_accounts
	      WHERE id = ?
	    `, [req.params.id])

    if (result.length === 0 || result[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const row = result[0].values[0]
	    const account = {
	      id: row[0],
	      email: row[1],
	      token: row[2],
	      refreshToken: row[3],
	      userCount: row[4],
		      inviteCount: row[5],
		      chatgptAccountId: row[6],
		      oaiDeviceId: row[7],
		      expireAt: row[8] || null,
		      isOpen: Boolean(row[9]),
		      isBanned: Boolean(row[11]),
          spaceType: row[12] || SPACE_TYPE_CHILD,
		      createdAt: row[13],
		      updatedAt: row[14]
	    }

    res.json(account)
  } catch (error) {
    console.error('Get GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Create a new GPT account
router.post('/', async (req, res) => {
  try {
    const body = req.body || {}
    const { email, token, refreshToken, userCount, chatgptAccountId, oaiDeviceId, expireAt } = body

    const hasIsBanned = Object.prototype.hasOwnProperty.call(body, 'isBanned') || Object.prototype.hasOwnProperty.call(body, 'is_banned')
    const isBannedInput = Object.prototype.hasOwnProperty.call(body, 'isBanned') ? body.isBanned : body.is_banned
    const normalizedIsBanned = hasIsBanned ? normalizeBoolean(isBannedInput) : null
    if (hasIsBanned && normalizedIsBanned === null) {
      return res.status(400).json({ error: 'Invalid isBanned format' })
    }
    const isBannedValue = normalizedIsBanned ? 1 : 0

    const normalizedChatgptAccountId = String(chatgptAccountId ?? '').trim()
    const normalizedOaiDeviceId = String(oaiDeviceId ?? '').trim()
    const normalizedExpireAt = normalizeShanghaiDateTime(expireAt)

    const hasSpaceType = Object.prototype.hasOwnProperty.call(body, 'spaceType') || Object.prototype.hasOwnProperty.call(body, 'space_type')
    const spaceTypeInput = Object.prototype.hasOwnProperty.call(body, 'spaceType') ? body.spaceType : body.space_type
    const normalizedSpaceType = hasSpaceType ? normalizeSpaceTypeInput(spaceTypeInput, null) : null
    if (hasSpaceType && !normalizedSpaceType) {
      return res.status(400).json({ error: 'Invalid spaceType' })
    }
    const spaceTypeValue = normalizedSpaceType || SPACE_TYPE_CHILD

    if (!email || !token || !normalizedChatgptAccountId) {
      return res.status(400).json({ error: 'Email, token and ChatGPT ID are required' })
    }

    if (expireAt != null && String(expireAt).trim() && !normalizedExpireAt) {
      return res.status(400).json({
        error: 'Invalid expireAt format',
        message: 'expireAt 格式错误，请使用 YYYY/MM/DD HH:mm'
      })
    }

    const normalizedEmail = normalizeEmail(email)

    const db = await getDatabase()

    // 账号初始人数默认 1；空间固定上限 5 人
    const finalUserCount = normalizeMemberCount(userCount !== undefined ? userCount : 1)
    if (finalUserCount > SPACE_MEMBER_LIMIT) {
      return res.status(400).json({ error: `空间人数不能超过 ${SPACE_MEMBER_LIMIT} 人` })
    }

    db.run(
      `INSERT INTO gpt_accounts (email, token, refresh_token, user_count, chatgpt_account_id, oai_device_id, expire_at, is_demoted, is_banned, space_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
      [normalizedEmail, token, refreshToken || null, finalUserCount, normalizedChatgptAccountId, normalizedOaiDeviceId || null, normalizedExpireAt, 0, isBannedValue, spaceTypeValue]
    )

		    // 获取新创建账号的ID
		    const accountResult = db.exec(`
		      SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
		             COALESCE(is_demoted, 0) AS is_demoted,
		             COALESCE(is_banned, 0) AS is_banned,
		             COALESCE(space_type, '${SPACE_TYPE_CHILD}') AS space_type,
		             created_at, updated_at
		      FROM gpt_accounts
		      WHERE id = last_insert_rowid()
		    `)
    const row = accountResult[0].values[0]
	    const account = {
	      id: row[0],
	      email: row[1],
	      token: row[2],
	      refreshToken: row[3],
	      userCount: row[4],
		      inviteCount: row[5],
		      chatgptAccountId: row[6],
		      oaiDeviceId: row[7],
		      expireAt: row[8] || null,
		      isOpen: Boolean(row[9]),
		      isBanned: Boolean(row[11]),
          spaceType: row[12] || SPACE_TYPE_CHILD,
		      createdAt: row[13],
		      updatedAt: row[14]
		    }

    // 生成随机兑换码的辅助函数
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

    // 自动生成兑换码并绑定到该账号。
    // 策略：人数已满(>=5)时不生成兑换码，与现有“满员不可继续上车/不可继续发码”的逻辑保持一致。
    const shouldGenerateCodes = shouldAutoGenerateCodes(spaceTypeValue)
    if (!shouldGenerateCodes) {
      console.info('[GptAccounts] skip auto redemption codes for mother space', {
        email: normalizedEmail,
        spaceType: spaceTypeValue
      })
    }

    const syncResult = await syncAccountUserCount(account.id, {
      accountRecord: {
        ...account,
        chatgptAccountId: normalizedChatgptAccountId,
        token,
        oaiDeviceId: normalizedOaiDeviceId || null
      },
      userListParams: { offset: 0, limit: 1, query: '' }
    })
    const joinedCount = Number(syncResult?.syncedUserCount ?? finalUserCount)
    const codesToGenerate = shouldGenerateCodes ? calcRedeemableSlots(joinedCount, SPACE_MEMBER_LIMIT) : 0

    const generatedCodes = []
    await withLocks([`redeem:${account.id}`], async () => {
      for (let i = 0; i < codesToGenerate; i++) {
        let code = generateRedemptionCode()
        let attempts = 0
        let success = false

        // 尝试生成唯一的兑换码（最多重试5次）
        while (attempts < 5 && !success) {
          try {
            db.run(
              `INSERT INTO redemption_codes (code, account_email, created_at, updated_at) VALUES (?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
              [code, normalizedEmail]
            )
            generatedCodes.push(code)
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
      }
    })

    console.info('[GptAccounts] auto redemption summary', {
      accountId: account.id,
      joinedCount,
      capacity: SPACE_MEMBER_LIMIT,
      need: codesToGenerate,
      generated: generatedCodes.length
    })

    saveDatabase()

    // 获取生成的兑换码信息
    const codesResult = db.exec(
      `
        SELECT code FROM redemption_codes
        WHERE account_email = ?
        ORDER BY created_at DESC
      `,
      [normalizedEmail]
    )

    const codes = codesResult[0]?.values.map(row => row[0]) || []
    const autoGenerateMessage = shouldGenerateCodes
      ? `账号创建成功，已自动生成${generatedCodes.length}个兑换码`
      : '账号创建成功，母号空间已跳过自动生成兑换码'

    res.status(201).json({
      account,
      generatedCodes: codes,
      message: autoGenerateMessage
    })
  } catch (error) {
    console.error('Create GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Update a GPT account
router.put('/:id', async (req, res) => {
  try {
    const body = req.body || {}
    const { email, token, refreshToken, userCount, chatgptAccountId, oaiDeviceId, expireAt } = body

    const normalizedChatgptAccountId = String(chatgptAccountId ?? '').trim()
    const normalizedOaiDeviceId = String(oaiDeviceId ?? '').trim()
    const hasExpireAt = Object.prototype.hasOwnProperty.call(body, 'expireAt')
    const normalizedExpireAt = hasExpireAt ? normalizeExpireAt(expireAt) : null

    const hasSpaceType = Object.prototype.hasOwnProperty.call(body, 'spaceType') || Object.prototype.hasOwnProperty.call(body, 'space_type')
    const spaceTypeInput = Object.prototype.hasOwnProperty.call(body, 'spaceType') ? body.spaceType : body.space_type
    const normalizedSpaceType = hasSpaceType ? normalizeSpaceTypeInput(spaceTypeInput, null) : null
    if (hasSpaceType && !normalizedSpaceType) {
      return res.status(400).json({ error: 'Invalid spaceType' })
    }

    const hasIsBanned = Object.prototype.hasOwnProperty.call(body, 'isBanned') || Object.prototype.hasOwnProperty.call(body, 'is_banned')
    const isBannedInput = Object.prototype.hasOwnProperty.call(body, 'isBanned') ? body.isBanned : body.is_banned
    const normalizedIsBanned = hasIsBanned ? normalizeBoolean(isBannedInput) : null
    if (hasIsBanned && normalizedIsBanned === null) {
      return res.status(400).json({ error: 'Invalid isBanned format' })
    }
    const shouldUpdateIsBanned = hasIsBanned
    const isBannedValue = normalizedIsBanned ? 1 : 0
    const shouldApplyBanSideEffects = shouldUpdateIsBanned && isBannedValue === 1

    if (!email || !token || !normalizedChatgptAccountId) {
      return res.status(400).json({ error: 'Email, token and ChatGPT ID are required' })
    }

    if (hasExpireAt && expireAt != null && String(expireAt).trim() && !normalizedExpireAt) {
      return res.status(400).json({
        error: 'Invalid expireAt format',
        message: 'expireAt 格式错误，请使用 YYYY/MM/DD HH:mm'
      })
    }

    const db = await getDatabase()

    // Check if account exists
    const checkResult = db.exec('SELECT id, email FROM gpt_accounts WHERE id = ?', [req.params.id])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const existingEmail = checkResult[0].values[0][1]

    const normalizedUserCount = normalizeMemberCount(userCount)
    if (normalizedUserCount > SPACE_MEMBER_LIMIT) {
      return res.status(400).json({ error: `空间人数不能超过 ${SPACE_MEMBER_LIMIT} 人` })
    }

    db.run(
      `UPDATE gpt_accounts
       SET email = ?,
           token = ?,
           refresh_token = ?,
           user_count = ?,
           chatgpt_account_id = ?,
           oai_device_id = ?,
           expire_at = CASE WHEN ? = 1 THEN ? ELSE expire_at END,
           space_type = CASE WHEN ? = 1 THEN ? ELSE space_type END,
           is_demoted = 0,
           is_banned = CASE WHEN ? = 1 THEN ? ELSE is_banned END,
           is_open = CASE WHEN ? = 1 THEN 0 ELSE is_open END,
           ban_processed = CASE WHEN ? = 1 THEN 0 ELSE ban_processed END,
           updated_at = DATETIME('now', 'localtime')
       WHERE id = ?`,
      [
        email,
        token,
        refreshToken || null,
        normalizedUserCount,
        normalizedChatgptAccountId,
        normalizedOaiDeviceId || null,
        hasExpireAt ? 1 : 0,
        normalizedExpireAt,
        hasSpaceType ? 1 : 0,
        normalizedSpaceType || SPACE_TYPE_CHILD,
        shouldUpdateIsBanned ? 1 : 0,
        isBannedValue,
        shouldApplyBanSideEffects ? 1 : 0,
        shouldApplyBanSideEffects ? 1 : 0,
        req.params.id
      ]
    )

    if (existingEmail && existingEmail !== email) {
      db.run(
        `UPDATE redemption_codes SET account_email = ?, updated_at = DATETIME('now', 'localtime') WHERE account_email = ?`,
        [email, existingEmail]
      )
    }
    saveDatabase()

		    // Get the updated account
		    const result = db.exec(`
		      SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
		             COALESCE(is_demoted, 0) AS is_demoted,
		             COALESCE(is_banned, 0) AS is_banned,
		             COALESCE(space_type, '${SPACE_TYPE_CHILD}') AS space_type,
		             created_at, updated_at
		      FROM gpt_accounts
		      WHERE id = ?
		    `, [req.params.id])
    const row = result[0].values[0]
	    const account = {
	      id: row[0],
	      email: row[1],
	      token: row[2],
	      refreshToken: row[3],
	      userCount: row[4],
		      inviteCount: row[5],
		      chatgptAccountId: row[6],
		      oaiDeviceId: row[7],
		      expireAt: row[8] || null,
		      isOpen: Boolean(row[9]),
		      isBanned: Boolean(row[11]),
          spaceType: row[12] || SPACE_TYPE_CHILD,
		      createdAt: row[13],
		      updatedAt: row[14]
		    }

    res.json(account)
  } catch (error) {
    console.error('Update GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 设置账号是否开放展示
router.patch('/:id/open', async (req, res) => {
  try {
    const { isOpen } = req.body || {}
    if (typeof isOpen !== 'boolean') {
      return res.status(400).json({ error: 'isOpen must be a boolean' })
    }

	    const db = await getDatabase()

	    const checkResult = db.exec('SELECT id, COALESCE(is_banned, 0) AS is_banned FROM gpt_accounts WHERE id = ?', [req.params.id])
	    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
	      return res.status(404).json({ error: 'Account not found' })
	    }

	    const isBanned = Boolean(checkResult[0].values[0][1])
	    if (isOpen && isBanned) {
	      return res.status(400).json({ error: '账号已封号，不能设置为开放账号' })
	    }

	    db.run(
	      `UPDATE gpt_accounts SET is_open = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
	      [isOpen ? 1 : 0, req.params.id]
	    )
	    saveDatabase()

		    const result = db.exec(
		      `
		        SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
		               COALESCE(is_demoted, 0) AS is_demoted,
		               COALESCE(is_banned, 0) AS is_banned,
		               COALESCE(space_type, '${SPACE_TYPE_CHILD}') AS space_type,
		               created_at, updated_at
		        FROM gpt_accounts
		        WHERE id = ?
		      `,
		      [req.params.id]
		    )
	    const row = result[0].values[0]
	    const account = {
	      id: row[0],
	      email: row[1],
	      token: row[2],
	      refreshToken: row[3],
	      userCount: row[4],
		      inviteCount: row[5],
		      chatgptAccountId: row[6],
		      oaiDeviceId: row[7],
		      expireAt: row[8] || null,
		      isOpen: Boolean(row[9]),
		      isBanned: Boolean(row[11]),
          spaceType: row[12] || SPACE_TYPE_CHILD,
		      createdAt: row[13],
		      updatedAt: row[14]
		    }

    res.json(account)
  } catch (error) {
    console.error('Update GPT account open status error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 标记账号为封号（后台手动操作）
router.patch('/:id/ban', async (req, res) => {
  try {
    const accountId = Number(req.params.id)
    if (!Number.isFinite(accountId)) {
      return res.status(400).json({ error: 'Invalid account id' })
    }

    const db = await getDatabase()
    const checkResult = db.exec('SELECT id FROM gpt_accounts WHERE id = ?', [accountId])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    db.run(
      `
        UPDATE gpt_accounts
        SET is_open = 0,
            is_banned = 1,
            ban_processed = 0,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
      `,
      [accountId]
    )
    saveDatabase()

    const result = db.exec(
      `
        SELECT id, email, token, refresh_token, user_count, invite_count, chatgpt_account_id, oai_device_id, expire_at, is_open,
               COALESCE(is_demoted, 0) AS is_demoted,
               COALESCE(is_banned, 0) AS is_banned,
               COALESCE(sort_order, id) AS sort_order,
               COALESCE(space_type, '${SPACE_TYPE_CHILD}') AS space_type,
               COALESCE(space_status_code, 'unknown') AS space_status_code,
               space_status_reason,
               COALESCE(space_name, '') AS space_name,
               created_at, updated_at
        FROM gpt_accounts
        WHERE id = ?
      `,
      [accountId]
    )
    const row = result[0].values[0]
    const account = {
      id: row[0],
      email: row[1],
      token: row[2],
      refreshToken: row[3],
      userCount: row[4],
      inviteCount: row[5],
      chatgptAccountId: row[6],
      oaiDeviceId: row[7],
      expireAt: row[8] || null,
      isOpen: Boolean(row[9]),
      isBanned: Boolean(row[11]),
      sortOrder: Number(row[12] || 0),
      spaceType: row[13] || SPACE_TYPE_CHILD,
      spaceStatusCode: row[14] || 'unknown',
      spaceStatusReason: row[15] || '',
      createdAt: row[16],
      updatedAt: row[17],
      spaceStatus: resolveSpaceStatus({ isBanned: Boolean(row[11]), token: row[2], spaceStatusCode: row[14], spaceStatusReason: row[15] })
    }

    res.json(account)
  } catch (error) {
    console.error('Ban GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.patch('/:id/space-status', async (req, res) => {
  try {
    const accountId = Number(req.params.id)
    if (!Number.isFinite(accountId)) {
      return res.status(400).json({ error: 'Invalid account id' })
    }

    const rawCode = String(req.body?.code ?? req.body?.spaceStatusCode ?? '').trim().toLowerCase()
    const code = ['normal', 'abnormal', 'unknown'].includes(rawCode) ? rawCode : null
    if (!code) {
      return res.status(400).json({ error: 'Invalid space status code' })
    }

    const reason = String(req.body?.reason ?? req.body?.spaceStatusReason ?? '').trim()
    const db = await getDatabase()
    const existing = db.exec('SELECT id FROM gpt_accounts WHERE id = ?', [accountId])
    if (!existing[0]?.values?.length) {
      return res.status(404).json({ error: 'Account not found' })
    }

    await markAccountSpaceStatus(accountId, { code, reason }, { db })
    const account = getAccountById(db, accountId)
    return res.json({
      message: '空间状态更新成功',
      account
    })
  } catch (error) {
    console.error('Update GPT account space status error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})


// 更新账号排序
router.patch('/reorder', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(v => Number(v)).filter(Number.isFinite) : []
    if (!ids.length) return res.status(400).json({ error: 'ids is required' })

    const db = await getDatabase()
    if (hasDuplicateSortOrder(db)) {
      rebuildSortOrderByCreatedDesc(db)
    }

    const placeholders = ids.map(() => '?').join(',')
    const existing = db.exec(`SELECT id FROM gpt_accounts WHERE id IN (${placeholders})`, ids)
    const existingSet = new Set((existing[0]?.values || []).map(row => Number(row[0])))
    for (const id of ids) {
      if (!existingSet.has(id)) return res.status(400).json({ error: `账号不存在: ${id}` })
    }

    // 说明：前端当前仅提交“当前页可见账号”的顺序。
    // 如果直接写入 1..N，会导致全表 sort_order 冲突，列表出现跨页乱序。
    // 这里改为：基于全量顺序，仅替换本次提交 ID 所在位置的相对顺序，再统一重排为唯一 sort_order。
    const allRows = db.exec(`
      SELECT id
      FROM gpt_accounts
      ORDER BY COALESCE(sort_order, id) ASC, created_at DESC, id ASC
    `)
    const orderedIds = (allRows[0]?.values || []).map(row => Number(row[0])).filter(Number.isFinite)
    if (!orderedIds.length) {
      return res.status(400).json({ error: '暂无可排序账号' })
    }

    const idToPosition = new Map(orderedIds.map((id, index) => [id, index]))
    const targetPositions = ids.map((id) => idToPosition.get(id)).filter(Number.isFinite).sort((a, b) => a - b)

    if (targetPositions.length !== ids.length) {
      return res.status(400).json({ error: '排序目标不完整，请刷新后重试' })
    }

    ids.forEach((id, index) => {
      const position = targetPositions[index]
      orderedIds[position] = id
    })

    orderedIds.forEach((id, index) => {
      db.run(
        `UPDATE gpt_accounts SET sort_order = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
        [index + 1, id]
      )
    })
    saveDatabase()
    return res.json({ message: '排序更新成功' })
  } catch (error) {
    console.error('更新账号排序失败:', error)
    return res.status(500).json({ error: '内部服务器错误' })
  }
})


// 一键重建排序（管理端手动兜底）
router.post('/rebuild-sort-order', async (req, res) => {
  try {
    const db = await getDatabase()
    rebuildSortOrderByCreatedDesc(db)
    return res.json({ message: '排序已按创建时间重建' })
  } catch (error) {
    console.error('重建账号排序失败:', error)
    return res.status(500).json({ error: '内部服务器错误' })
  }
})

// 一键同步全部空间信息
router.post('/sync-all', async (req, res) => {
  try {
    cleanupExpiredSyncAllTasks()
    const db = await getDatabase()
    const rows = db.exec(`SELECT id FROM gpt_accounts ORDER BY COALESCE(sort_order, id) ASC, created_at DESC, id ASC`)
    const ids = (rows[0]?.values || []).map(row => Number(row[0])).filter(Number.isFinite)
    const task = await startSyncAllTask({ ids, db })
    return res.status(202).json({
      message: '批量同步任务已启动',
      ...createSyncAllTaskSnapshot(task)
    })
  } catch (error) {
    console.error('批量同步失败:', error)
    return res.status(500).json({ error: '内部服务器错误' })
  }
})

router.get('/sync-all/:taskId', async (req, res) => {
  cleanupExpiredSyncAllTasks()
  const taskId = String(req.params.taskId || '').trim()
  if (!taskId) {
    return res.status(400).json({ error: '任务ID不能为空' })
  }
  const task = syncAllTaskStore.get(taskId)
  if (!task) {
    return res.status(404).json({ error: '任务不存在或已过期' })
  }
  return res.json({
    message: task.status === 'completed' ? '批量同步完成' : '批量同步进行中',
    ...createSyncAllTaskSnapshot(task)
  })
})

// Delete a GPT account
router.delete('/:id', async (req, res) => {
  try {
    const db = await getDatabase()

    // Check if account exists
    const checkResult = db.exec('SELECT id FROM gpt_accounts WHERE id = ?', [req.params.id])
    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    db.run('DELETE FROM gpt_accounts WHERE id = ?', [req.params.id])
    saveDatabase()

    res.json({ message: 'Account deleted successfully' })
  } catch (error) {
    console.error('Delete GPT account error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 同步账号用户数量
router.post('/:id/sync-user-count', async (req, res) => {
  try {
    const accountId = Number(req.params.id)
    const userSync = await syncAccountUserCount(accountId)
    const inviteSync = await syncAccountInviteCount(accountId, {
      accountRecord: userSync.account,
      inviteListParams: { offset: 0, limit: 1, query: '' }
    })
    const db = await getDatabase()
    await markAccountSpaceStatus(accountId, { code: 'normal', reason: '正常' }, { db })
    const protectedEmailSet = await getProtectedSeatEmailSet(db)
    const usersWithProtectionTag = appendProtectedMemberSuffix(userSync.users, protectedEmailSet)
    res.json({
      message: '账号同步成功',
      account: {
        ...inviteSync.account,
        spaceStatusCode: 'normal',
        spaceStatusReason: '正常',
        spaceStatus: resolveSpaceStatus({ ...inviteSync.account, spaceStatusCode: 'normal', spaceStatusReason: '正常' })
      },
      syncedUserCount: userSync.syncedUserCount,
      inviteCount: inviteSync.inviteCount,
      users: usersWithProtectionTag
    })
  } catch (error) {
    console.error('同步账号人数错误:', error)

    if (error instanceof AccountSyncError || error.status) {
      if (isTokenInvalidSyncError(error)) {
        const db = await getDatabase()
        await markAccountSpaceStatus(Number(req.params.id), { code: 'abnormal', reason: 'Token 已过期或无效，请更新账号 token' }, { db })
      }
      if (isWorkspaceExpiredSyncError(error)) {
        const db = await getDatabase()
        await markAccountSpaceStatus(Number(req.params.id), { code: 'abnormal', reason: getWorkspaceExpiredReason() }, { db })
      }
      return res.status(error.status || 500).json({ error: error.message, code: error?.code || null })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 读取成员缓存（不触发远程同步）
router.get('/:id/members', async (req, res) => {
  try {
    const accountId = Number(req.params.id)
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return res.status(400).json({ error: '账号ID无效' })
    }

    const offset = Math.max(0, Number(req.query.offset) || 0)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100))
    const query = String(req.query.query || '').trim().toLowerCase()

    const db = await getDatabase()
    const accountResult = db.exec('SELECT id FROM gpt_accounts WHERE id = ? LIMIT 1', [accountId])
    if (!accountResult[0]?.values?.length) {
      return res.status(404).json({ error: '账号不存在' })
    }

    const conditions = ['account_id = ?']
    const params = [accountId]
    if (query) {
      const likeValue = `%${query}%`
      conditions.push('(LOWER(email) LIKE ? OR LOWER(name) LIKE ? OR LOWER(member_id) LIKE ?)')
      params.push(likeValue, likeValue, likeValue)
    }
    const whereClause = `WHERE ${conditions.join(' AND ')}`

    const totalResult = db.exec(
      `SELECT COUNT(*) FROM gpt_account_members ${whereClause}`,
      params
    )
    const total = Number(totalResult[0]?.values?.[0]?.[0] || 0)

    const rowsResult = db.exec(
      `
        SELECT member_id, email, role, name, created_time, is_scim_managed
        FROM gpt_account_members
        ${whereClause}
        ORDER BY created_time DESC, member_id ASC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    )

    const items = (rowsResult[0]?.values || []).map(row => ({
      id: String(row[0] || ''),
      account_user_id: String(row[0] || ''),
      email: row[1] ? String(row[1]) : '',
      role: row[2] ? String(row[2]) : '',
      name: row[3] ? String(row[3]) : '',
      created_time: row[4] ? String(row[4]) : '',
      is_scim_managed: Number(row[5] || 0) > 0,
    }))

    const protectedEmailSet = await getProtectedSeatEmailSet(db)
    const usersWithProtectionTag = appendProtectedMemberSuffix({ items, total, limit, offset }, protectedEmailSet)
    return res.json(usersWithProtectionTag)
  } catch (error) {
    console.error('读取成员缓存失败:', error)
    return res.status(500).json({ error: '内部服务器错误' })
  }
})

router.delete('/:id/users/:userId', async (req, res) => {
  try {
    const { account, syncedUserCount, users } = await deleteAccountUser(Number(req.params.id), req.params.userId)
    const db = await getDatabase()
    const protectedEmailSet = await getProtectedSeatEmailSet(db)
    const usersWithProtectionTag = appendProtectedMemberSuffix(users, protectedEmailSet)
    res.json({
      message: '成员删除成功',
      account,
      syncedUserCount,
      users: usersWithProtectionTag
    })
  } catch (error) {
    console.error('删除成员失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

router.post('/:id/invite-user', async (req, res) => {
  try {
    const { email } = req.body || {}
    if (!email) {
      return res.status(400).json({ error: '请提供邀请邮箱地址' })
    }
    const normalizedInviteEmail = normalizeEmail(email)
    const result = await inviteAccountUser(Number(req.params.id), normalizedInviteEmail)

    const db = await getDatabase()
    await upsertSystemInviteProtection(db, normalizedInviteEmail)
    saveDatabase()

    let inviteCount = null
    try {
      const synced = await syncAccountInviteCount(Number(req.params.id), {
        inviteListParams: { offset: 0, limit: 1, query: '' }
      })
      inviteCount = synced.inviteCount
    } catch (syncError) {
      console.warn('邀请发送成功，但同步邀请数失败:', syncError?.message || syncError)
    }

    res.json({
      ...result,
      inviteCount
    })
  } catch (error) {
    console.error('邀请成员失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 查询已邀请列表（用于统计待加入人数）
router.get('/:id/invites', async (req, res) => {
  try {
    const { invites } = await syncAccountInviteCount(Number(req.params.id), {
      inviteListParams: req.query || {}
    })
    const db = await getDatabase()
    const protectedEmailSet = await getProtectedSeatEmailSet(db)
    const invitesWithProtectionTag = appendProtectedInviteSuffix(invites, protectedEmailSet)
    res.json(invitesWithProtectionTag)
  } catch (error) {
    console.error('获取邀请列表失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 撤回邀请
router.delete('/:id/invites', async (req, res) => {
  try {
    const emailAddress = req.body?.email_address || req.body?.emailAddress || req.body?.email
    if (!emailAddress) {
      return res.status(400).json({ error: '请提供邀请邮箱地址' })
    }

    const result = await deleteAccountInvite(Number(req.params.id), emailAddress)
    res.json(result)
  } catch (error) {
    console.error('撤回邀请失败:', error)

    if (error instanceof AccountSyncError || error.status) {
      return res.status(error.status || 500).json({ error: error.message })
    }

    res.status(500).json({ error: '内部服务器错误' })
  }
})

// 刷新账号的 access token
router.post('/:id/refresh-token', async (req, res) => {
  try {
    const result = await refreshAccountAccessToken(Number(req.params.id), { trigger: 'manual_refresh' })
    res.json({
      message: 'Token 刷新成功',
      account: result.account,
      accessToken: result.accessToken,
      idToken: result.idToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn
    })
  } catch (error) {
    console.error('刷新 token 错误:', error)

    if (error instanceof AccountSyncError || error?.status) {
      const payload = { error: error.message }
      if (error?.upstreamStatus) {
        payload.upstream_status = error.upstreamStatus
      }
      return res.status(error.status || 500).json(payload)
    }

    res.status(500).json({ error: '刷新 token 时发生内部错误' })
  }
})

export default router
