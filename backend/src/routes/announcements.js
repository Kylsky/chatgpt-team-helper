import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { withLocks } from '../utils/locks.js'

const router = express.Router()

router.use(authenticateToken)

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const getPagination = (req) => {
  const limit = Math.min(50, Math.max(1, toInt(req.query?.limit, 20)))
  const offset = Math.max(0, toInt(req.query?.offset, 0))
  return { limit, offset }
}

router.get('/', async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Access denied. No user provided.' })
    }

    const db = await getDatabase()
    const { limit, offset } = getPagination(req)

    const totalResult = db.exec(`SELECT COUNT(*) FROM announcements WHERE COALESCE(is_published, 1) = 1`)
    const total = Number(totalResult?.[0]?.values?.[0]?.[0] || 0)

    const result = db.exec(
      `
        SELECT
          a.id,
          a.title,
          a.content,
          COALESCE(a.pinned, 0) AS pinned,
          a.published_at,
          r.read_at
        FROM announcements a
        LEFT JOIN announcement_reads r
          ON r.announcement_id = a.id AND r.user_id = ?
        WHERE COALESCE(a.is_published, 1) = 1
        ORDER BY COALESCE(a.pinned, 0) DESC, a.published_at DESC, a.id DESC
        LIMIT ? OFFSET ?
      `,
      [userId, limit, offset]
    )

    const items = (result?.[0]?.values || []).map(row => ({
      id: Number(row[0]),
      title: row[1] || '',
      content: row[2] || '',
      pinned: Boolean(row[3]),
      publishedAt: row[4] || null,
      read: Boolean(row[5]),
      readAt: row[5] || null,
    }))

    res.json({
      items,
      page: { limit, offset, total },
    })
  } catch (error) {
    console.error('List announcements error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/unread-count', async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Access denied. No user provided.' })
    }

    const db = await getDatabase()
    const result = db.exec(
      `
        SELECT COUNT(*)
        FROM announcements a
        LEFT JOIN announcement_reads r
          ON r.announcement_id = a.id AND r.user_id = ?
        WHERE COALESCE(a.is_published, 1) = 1
          AND r.announcement_id IS NULL
      `,
      [userId]
    )
    const unread = Number(result?.[0]?.values?.[0]?.[0] || 0)
    res.json({ unread })
  } catch (error) {
    console.error('Get unread announcements count error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/:id/read', async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Access denied. No user provided.' })
    }

    const announcementId = Number(req.params?.id)
    if (!Number.isFinite(announcementId) || announcementId <= 0) {
      return res.status(400).json({ error: 'Invalid announcement id' })
    }

    const db = await getDatabase()
    const exists = db.exec(
      `SELECT 1 FROM announcements WHERE id = ? AND COALESCE(is_published, 1) = 1 LIMIT 1`,
      [announcementId]
    )
    if (!exists?.[0]?.values?.length) {
      return res.status(404).json({ error: 'Announcement not found' })
    }

    await withLocks([`announcement:read:${userId}`], async () => {
      db.run(
        `
          INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at)
          VALUES (?, ?, DATETIME('now', 'localtime'))
        `,
        [announcementId, userId]
      )
      await saveDatabase()
    })

    res.json({ ok: true })
  } catch (error) {
    console.error('Mark announcement read error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/read-all', async (req, res) => {
  try {
    const userId = Number(req.user?.id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Access denied. No user provided.' })
    }

    const db = await getDatabase()

    const unreadResult = db.exec(
      `
        SELECT COUNT(*)
        FROM announcements a
        LEFT JOIN announcement_reads r
          ON r.announcement_id = a.id AND r.user_id = ?
        WHERE COALESCE(a.is_published, 1) = 1
          AND r.announcement_id IS NULL
      `,
      [userId]
    )
    const unreadBefore = Number(unreadResult?.[0]?.values?.[0]?.[0] || 0)

    await withLocks([`announcement:read:${userId}`], async () => {
      db.run(
        `
          INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at)
          SELECT a.id, ?, DATETIME('now', 'localtime')
          FROM announcements a
          WHERE COALESCE(a.is_published, 1) = 1
        `,
        [userId]
      )
      await saveDatabase()
    })

    res.json({ ok: true, marked: unreadBefore })
  } catch (error) {
    console.error('Mark all announcements read error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

