import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireMenu } from '../middleware/rbac.js'
import {
  HISTORY_EXCEPTION_STATUS,
  HISTORY_EXCEPTION_STATUS_SET,
  buildHistoryExceptionPagination,
  normalizeHistoryExceptionStatus,
} from '../services/account-exception-history.js'

const router = express.Router()

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const normalizeDate = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  return Number.isFinite(Date.parse(raw)) ? raw : null
}

const parseFilters = (query = {}) => {
  const page = toPositiveInt(query.page, 1)
  const pageSize = Math.min(100, toPositiveInt(query.pageSize, 20))
  const keyword = String(query.keyword ?? query.accountKeyword ?? '').trim()
  const exceptionType = String(query.exceptionType ?? '').trim()
  const statusRaw = String(query.status ?? '').trim().toLowerCase()
  const status = statusRaw && HISTORY_EXCEPTION_STATUS_SET.has(statusRaw) ? statusRaw : ''
  const startTime = normalizeDate(query.startTime)
  const endTime = normalizeDate(query.endTime)

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    keyword,
    exceptionType,
    status,
    startTime,
    endTime,
  }
}

const buildWhere = (filters) => {
  const clauses = []
  const params = []

  if (filters.keyword) {
    clauses.push('(CAST(account_id AS TEXT) LIKE ? OR account_name LIKE ?)')
    params.push(`%${filters.keyword}%`, `%${filters.keyword}%`)
  }
  if (filters.exceptionType) {
    clauses.push('exception_type = ?')
    params.push(filters.exceptionType)
  }
  if (filters.status) {
    clauses.push('status = ?')
    params.push(filters.status)
  }
  if (filters.startTime) {
    clauses.push('last_seen_at >= DATETIME(?)')
    params.push(filters.startTime)
  }
  if (filters.endTime) {
    clauses.push('last_seen_at <= DATETIME(?)')
    params.push(filters.endTime)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return { where, params }
}

router.get('/history-exceptions', authenticateToken, requireMenu('history_exception:view'), async (req, res) => {
  try {
    const db = await getDatabase()
    const filters = parseFilters(req.query)
    const { where, params } = buildWhere(filters)

    const listResult = db.exec(
      `
        SELECT account_id, account_name, exception_type, exception_code, exception_message,
               source, first_seen_at, last_seen_at, status, created_at, updated_at
        FROM account_exception_history
        ${where}
        ORDER BY DATETIME(last_seen_at) DESC, account_id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, filters.pageSize, filters.offset]
    )
    const rows = listResult[0]?.values || []

    const countResult = db.exec(
      `
        SELECT COUNT(*)
        FROM account_exception_history
        ${where}
      `,
      params
    )
    const total = Number(countResult[0]?.values?.[0]?.[0] || 0)

    res.json({
      items: rows.map((row) => ({
        accountId: Number(row[0]),
        accountName: row[1] || '',
        exceptionType: row[2] || 'unknown',
        exceptionCode: row[3] || '',
        exceptionMessage: row[4] || '',
        source: row[5] || '',
        firstSeenAt: row[6] || null,
        lastSeenAt: row[7] || null,
        status: normalizeHistoryExceptionStatus(row[8]),
        createdAt: row[9] || null,
        updatedAt: row[10] || null,
      })),
      pagination: buildHistoryExceptionPagination({
        page: filters.page,
        pageSize: filters.pageSize,
        total,
      }),
    })
  } catch (error) {
    console.error('[HistoryException] list error:', error)
    res.status(500).json({ error: '查询历史异常失败' })
  }
})

router.put('/history-exceptions/:accountId/status', authenticateToken, requireMenu('history_exception:update'), async (req, res) => {
  try {
    const accountId = Number.parseInt(String(req.params.accountId || '').trim(), 10)
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return res.status(400).json({ error: '无效的 accountId' })
    }

    const nextStatus = String(req.body?.status || '').trim().toLowerCase()
    if (!HISTORY_EXCEPTION_STATUS_SET.has(nextStatus)) {
      return res.status(400).json({
        error: '无效的状态',
        allowed: [HISTORY_EXCEPTION_STATUS.ACTIVE, HISTORY_EXCEPTION_STATUS.RESOLVED, HISTORY_EXCEPTION_STATUS.IGNORED],
      })
    }

    const db = await getDatabase()
    const exists = db.exec('SELECT 1 FROM account_exception_history WHERE account_id = ? LIMIT 1', [accountId])
    if (!exists[0]?.values?.length) {
      return res.status(404).json({ error: '记录不存在' })
    }

    db.run(
      `
        UPDATE account_exception_history
        SET status = ?,
            updated_at = DATETIME('now', 'localtime')
        WHERE account_id = ?
      `,
      [nextStatus, accountId]
    )

    await saveDatabase()

    res.json({
      accountId,
      status: nextStatus,
    })
  } catch (error) {
    console.error('[HistoryException] update status error:', error)
    res.status(500).json({ error: '更新状态失败' })
  }
})

router.delete('/history-exceptions/:accountId', authenticateToken, requireMenu('history_exception:delete'), async (req, res) => {
  try {
    const accountId = Number.parseInt(String(req.params.accountId || '').trim(), 10)
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return res.status(400).json({ error: '无效的 accountId' })
    }

    const db = await getDatabase()
    const exists = db.exec('SELECT 1 FROM account_exception_history WHERE account_id = ? LIMIT 1', [accountId])
    if (!exists[0]?.values?.length) {
      return res.status(404).json({ error: '记录不存在' })
    }

    db.run('DELETE FROM account_exception_history WHERE account_id = ?', [accountId])
    await saveDatabase()

    res.json({ accountId, deleted: true })
  } catch (error) {
    console.error('[HistoryException] delete error:', error)
    res.status(500).json({ error: '删除历史异常失败' })
  }
})

export default router
