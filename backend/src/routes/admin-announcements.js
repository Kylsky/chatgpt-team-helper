import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/rbac.js'
import { withLocks } from '../utils/locks.js'

const router = express.Router()

router.use(authenticateToken, requireSuperAdmin)

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const getPagination = (req) => {
  const limit = Math.min(50, Math.max(1, toInt(req.query?.limit, 20)))
  const offset = Math.max(0, toInt(req.query?.offset, 0))
  return { limit, offset }
}

const normalizeTitle = (value) => String(value ?? '').trim()
const normalizeContent = (value) => String(value ?? '').trim()

router.get('/', async (req, res) => {
  try {
    const db = await getDatabase()
    const { limit, offset } = getPagination(req)

    const totalResult = db.exec(`SELECT COUNT(*) FROM announcements`)
    const total = Number(totalResult?.[0]?.values?.[0]?.[0] || 0)

    const result = db.exec(
      `
        SELECT
          id,
          title,
          content,
          COALESCE(is_published, 1) AS is_published,
          COALESCE(pinned, 0) AS pinned,
          published_at,
          created_at,
          updated_at
        FROM announcements
        ORDER BY COALESCE(pinned, 0) DESC, COALESCE(published_at, created_at) DESC, id DESC
        LIMIT ? OFFSET ?
      `,
      [limit, offset]
    )

    const items = (result?.[0]?.values || []).map(row => ({
      id: Number(row[0]),
      title: row[1] || '',
      content: row[2] || '',
      isPublished: Number(row[3] ?? 1) !== 0,
      pinned: Boolean(row[4]),
      publishedAt: row[5] || null,
      createdAt: row[6] || null,
      updatedAt: row[7] || null,
    }))

    res.json({ items, page: { limit, offset, total } })
  } catch (error) {
    console.error('Admin list announcements error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/', async (req, res) => {
  try {
    const title = normalizeTitle(req.body?.title)
    const content = normalizeContent(req.body?.content)
    const pinned = Boolean(req.body?.pinned)
    const isPublished = req.body?.isPublished === undefined ? true : Boolean(req.body?.isPublished)

    if (!title) {
      return res.status(400).json({ error: 'Title is required' })
    }
    if (title.length > 120) {
      return res.status(400).json({ error: 'Title is too long' })
    }
    if (!content) {
      return res.status(400).json({ error: 'Content is required' })
    }

    const db = await getDatabase()

    await withLocks(['announcements:admin'], async () => {
      db.run(
        `
          INSERT INTO announcements (title, content, is_published, pinned, created_at, updated_at, published_at)
          VALUES (?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
        `,
        [title, content, isPublished ? 1 : 0, pinned ? 1 : 0]
      )
      await saveDatabase()
    })

    const rowIdResult = db.exec('SELECT last_insert_rowid()')
    const id = Number(rowIdResult?.[0]?.values?.[0]?.[0] || 0)
    res.json({ ok: true, id })
  } catch (error) {
    console.error('Admin create announcement error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const announcementId = Number(req.params?.id)
    if (!Number.isFinite(announcementId) || announcementId <= 0) {
      return res.status(400).json({ error: 'Invalid announcement id' })
    }

    const title = normalizeTitle(req.body?.title)
    const content = normalizeContent(req.body?.content)
    const pinned = Boolean(req.body?.pinned)
    const isPublished = req.body?.isPublished === undefined ? true : Boolean(req.body?.isPublished)

    if (!title) {
      return res.status(400).json({ error: 'Title is required' })
    }
    if (title.length > 120) {
      return res.status(400).json({ error: 'Title is too long' })
    }
    if (!content) {
      return res.status(400).json({ error: 'Content is required' })
    }

    const db = await getDatabase()
    const existing = db.exec(
      `SELECT COALESCE(is_published, 1) FROM announcements WHERE id = ? LIMIT 1`,
      [announcementId]
    )
    if (!existing?.[0]?.values?.length) {
      return res.status(404).json({ error: 'Announcement not found' })
    }

    const wasPublished = Number(existing[0].values[0][0] ?? 1) !== 0
    const publishingNow = !wasPublished && isPublished

    await withLocks(['announcements:admin'], async () => {
      db.run(
        `
          UPDATE announcements
          SET title = ?,
              content = ?,
              is_published = ?,
              pinned = ?,
              updated_at = DATETIME('now', 'localtime')
              ${publishingNow ? ", published_at = DATETIME('now', 'localtime')" : ''}
          WHERE id = ?
        `,
        [title, content, isPublished ? 1 : 0, pinned ? 1 : 0, announcementId]
      )
      await saveDatabase()
    })

    res.json({ ok: true })
  } catch (error) {
    console.error('Admin update announcement error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const announcementId = Number(req.params?.id)
    if (!Number.isFinite(announcementId) || announcementId <= 0) {
      return res.status(400).json({ error: 'Invalid announcement id' })
    }

    const db = await getDatabase()
    const existing = db.exec(`SELECT 1 FROM announcements WHERE id = ? LIMIT 1`, [announcementId])
    if (!existing?.[0]?.values?.length) {
      return res.status(404).json({ error: 'Announcement not found' })
    }

    await withLocks(['announcements:admin'], async () => {
      db.run('DELETE FROM announcement_reads WHERE announcement_id = ?', [announcementId])
      db.run('DELETE FROM announcements WHERE id = ?', [announcementId])
      await saveDatabase()
    })

    res.json({ ok: true })
  } catch (error) {
    console.error('Admin delete announcement error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

