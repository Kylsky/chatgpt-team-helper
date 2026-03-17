import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { sendTelegramBotNotification } from '../services/telegram-notifier.js'
import {
  importAccountFromPipeline,
  timingSafeTokenEqual,
  validateImportPayload,
} from '../services/internal-pipeline.js'

const router = express.Router()
const INTERNAL_TOKEN_HEADER = 'x-internal-token'

const toBool = (value, fallback = false) => {
  if (value == null) return fallback
  const raw = String(value).trim().toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return fallback
}

const getExpectedInternalToken = () => String(process.env.INTERNAL_API_TOKEN || '').trim()

const requireInternalToken = (req, res, next) => {
  const expected = getExpectedInternalToken()
  if (!expected) {
    return res.status(503).json({ error: 'internal token not configured' })
  }

  const provided = req.headers[INTERNAL_TOKEN_HEADER]
  if (!timingSafeTokenEqual(provided, expected)) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  return next()
}

router.post('/import', requireInternalToken, async (req, res) => {
  try {
    const payload = validateImportPayload(req.body)
    const db = await getDatabase()
    const notifyEnabled = toBool(process.env.INTERNAL_IMPORT_TELEGRAM_NOTIFY_ENABLED, false)

    const result = await importAccountFromPipeline({
      db,
      payload,
      saveFn: saveDatabase,
      notifyEnabled,
      notifyFn: (message) => sendTelegramBotNotification(message, { db }),
    })

    return res.json({
      success: true,
      account_id: result.accountId,
      redemption_code: result.redemptionCode,
      action: result.action,
    })
  } catch (error) {
    const message = String(error?.message || '')
    if (
      message.includes('required') ||
      message.includes('format') ||
      message.includes('invalid')
    ) {
      return res.status(400).json({ error: 'invalid payload', details: message })
    }

    console.error('[Internal Accounts] import failed:', error)
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.get('/pending-tokens', requireInternalToken, async (req, res) => {
  try {
    const db = await getDatabase()
    const requestedLimit = Number.parseInt(String(req.query.limit ?? ''), 10)
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(200, Math.max(1, requestedLimit))
      : 50

    const result = db.exec(
      `SELECT id, email, password, expire_at, updated_at
       FROM gpt_accounts
       WHERE COALESCE(is_banned, 0) = 0
         AND (
           TRIM(COALESCE(token, '')) = ''
           OR TRIM(COALESCE(refresh_token, '')) = ''
           OR TRIM(COALESCE(session_token, '')) = ''
           OR expire_at IS NULL
           OR TRIM(COALESCE(expire_at, '')) = ''
         )
       ORDER BY updated_at ASC
       LIMIT ?`,
      [limit]
    )

    const accounts = (result[0]?.values || []).map((row) => ({
      account_id: Number(row[0]),
      email: String(row[1] || '').trim().toLowerCase(),
      password: row[2] ? String(row[2]) : null,
      expires_at: row[3] || null,
      updated_at: row[4] || null,
    }))

    return res.json({ accounts })
  } catch (error) {
    console.error('[Internal Accounts] pending-tokens failed:', error)
    return res.status(500).json({ error: 'internal server error' })
  }
})

export default router
