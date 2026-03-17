import Redis from 'ioredis'
import { getDatabase, saveDatabase } from '../database/init.js'
import { fetchOpenAiAccountInfo } from './account-sync.js'

const LABEL = '[AccountLivenessProbe]'
const DEFAULT_QUEUE_NAME = 'oai:queue:cancel_sub'

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const toBool = (value, fallback = false) => {
  if (value == null) return fallback
  const raw = String(value).trim().toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return fallback
}

const isEnabled = () => toBool(process.env.ACCOUNT_LIVENESS_PROBE_ENABLED, true)
const intervalSeconds = () => Math.max(30, toInt(process.env.ACCOUNT_LIVENESS_PROBE_INTERVAL_SECONDS, 300))
const initialDelayMs = () => Math.max(1_000, toInt(process.env.ACCOUNT_LIVENESS_PROBE_INITIAL_DELAY_MS, 20_000))
const defaultBatchSize = () => Math.max(1, Math.min(200, toInt(process.env.ACCOUNT_LIVENESS_PROBE_BATCH_SIZE, 30)))

const resolveQueueName = () => String(process.env.QUEUE_CANCEL_JOBS || DEFAULT_QUEUE_NAME).trim() || DEFAULT_QUEUE_NAME
const resolveRedisUrl = () => {
  const raw = String(process.env.PIPELINE_REDIS_URL || process.env.REDIS_URL || '').trim()
  return raw || ''
}

const BAN_STATUS_CODES = new Set([401, 403, 404])

export const isBanLikeError = (error) => {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status)
  if (BAN_STATUS_CODES.has(status)) return true

  const message = String(error?.message || '').toLowerCase()
  if (!message) return false

  return (
    message.includes('account_deactivated') ||
    message.includes('账号已停用') ||
    message.includes('过期或无效') ||
    message.includes('账号不存在')
  )
}

const normalizeReason = (error) => {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status)
  const message = String(error?.message || '').trim() || 'liveness_probe_failed'
  if (Number.isFinite(status) && status > 0) {
    return `probe_${status}:${message}`.slice(0, 180)
  }
  return `probe:${message}`.slice(0, 180)
}

const fetchProbeTargets = (db, limit) => {
  const result = db.exec(
    `SELECT id, email, password, token
     FROM gpt_accounts
     WHERE is_open = 1
       AND COALESCE(is_banned, 0) = 0
       AND TRIM(COALESCE(token, '')) != ''
     ORDER BY updated_at ASC
     LIMIT ?`,
    [limit]
  )
  return result[0]?.values || []
}

const fetchPendingCancelTargets = (db, limit) => {
  const result = db.exec(
    `SELECT id, email, password
     FROM gpt_accounts
     WHERE COALESCE(is_banned, 0) = 1
       AND COALESCE(ban_processed, 0) = 0
     ORDER BY updated_at ASC
     LIMIT ?`,
    [limit]
  )
  return result[0]?.values || []
}

const markBanned = (db, accountId) => {
  db.run(
    `UPDATE gpt_accounts
     SET is_open = 0,
         is_banned = 1,
         ban_processed = 0,
         updated_at = DATETIME('now', 'localtime')
     WHERE id = ?`,
    [accountId]
  )
}

const markBanProcessed = (db, accountId) => {
  db.run(
    `UPDATE gpt_accounts
     SET ban_processed = 1,
         updated_at = DATETIME('now', 'localtime')
     WHERE id = ?`,
    [accountId]
  )
}

const enqueueCancelJob = async ({ redisClient, queueName, accountId, email, password, reason }) => {
  if (!redisClient) {
    throw new Error('redis client unavailable')
  }

  const payload = {
    account_id: accountId,
    email,
    password,
    reason,
  }

  await redisClient.lpush(queueName, JSON.stringify(payload))
}

export const runLivenessProbeOnce = async ({
  db,
  redisClient,
  fetchAccountInfo = fetchOpenAiAccountInfo,
  queueName = resolveQueueName(),
  limit = defaultBatchSize(),
  logger = console,
  save = saveDatabase,
} = {}) => {
  const database = db || (await getDatabase())
  const batchLimit = Math.max(1, Math.min(200, Number(limit) || defaultBatchSize()))

  const summary = {
    scanned: 0,
    flagged: 0,
    alive: 0,
    queued: 0,
    queueErrors: 0,
    probeErrors: 0,
    skippedMissingPassword: 0,
  }

  let changed = false

  const probeTargets = fetchProbeTargets(database, batchLimit)
  for (const row of probeTargets) {
    const accountId = Number(row[0])
    const email = String(row[1] || '').trim().toLowerCase()
    const token = String(row[3] || '').trim()
    if (!Number.isFinite(accountId) || !token) continue

    summary.scanned += 1

    try {
      await fetchAccountInfo(token)
      summary.alive += 1
    } catch (error) {
      if (!isBanLikeError(error)) {
        summary.probeErrors += 1
        logger.warn(`${LABEL} probe failed (non-ban)`, {
          accountId,
          email,
          message: error?.message || String(error),
        })
        continue
      }

      markBanned(database, accountId)
      changed = true
      summary.flagged += 1
    }
  }

  const pendingCancelTargets = fetchPendingCancelTargets(database, batchLimit)
  for (const row of pendingCancelTargets) {
    const accountId = Number(row[0])
    const email = String(row[1] || '').trim().toLowerCase()
    const password = String(row[2] || '').trim()

    if (!Number.isFinite(accountId) || !email) continue

    if (!password) {
      summary.skippedMissingPassword += 1
      continue
    }

    try {
      await enqueueCancelJob({
        redisClient,
        queueName,
        accountId,
        email,
        password,
        reason: 'banned',
      })
      markBanProcessed(database, accountId)
      changed = true
      summary.queued += 1
    } catch (error) {
      summary.queueErrors += 1
      logger.error(`${LABEL} queue push failed`, {
        accountId,
        email,
        queueName,
        message: error?.message || String(error),
      })
    }
  }

  if (changed && typeof save === 'function') {
    await save()
  }

  return summary
}

const createRedisClient = () => {
  const redisUrl = resolveRedisUrl()
  if (!redisUrl) return null

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: false,
  })

  client.on('error', (error) => {
    console.error(`${LABEL} redis error`, error?.message || error)
  })

  return client
}

export const startAccountLivenessProbe = () => {
  if (!isEnabled()) {
    console.log(`${LABEL} disabled`)
    return () => {}
  }

  const interval = intervalSeconds()
  const delay = initialDelayMs()
  const limit = defaultBatchSize()
  const queueName = resolveQueueName()
  const redisClient = createRedisClient()

  let running = false

  const run = async () => {
    if (running) return
    running = true

    try {
      const summary = await runLivenessProbeOnce({
        redisClient,
        queueName,
        limit,
      })

      if (summary.flagged || summary.queued || summary.probeErrors || summary.queueErrors) {
        console.log(`${LABEL} run summary`, summary)
      }
    } catch (error) {
      console.error(`${LABEL} run failed`, error?.message || error)
    } finally {
      running = false
    }
  }

  const startupTimer = setTimeout(() => {
    void run()
  }, delay)

  const intervalTimer = setInterval(() => {
    void run()
  }, interval * 1000)

  console.log(`${LABEL} started`, {
    intervalSeconds: interval,
    initialDelayMs: delay,
    batchSize: limit,
    queueName,
    redisEnabled: Boolean(redisClient),
  })

  return () => {
    clearTimeout(startupTimer)
    clearInterval(intervalTimer)

    if (redisClient) {
      redisClient.quit().catch((error) => {
        console.warn(`${LABEL} redis quit failed`, error?.message || error)
      })
    }
  }
}

export const __testables__ = {
  fetchProbeTargets,
  fetchPendingCancelTargets,
  markBanned,
  markBanProcessed,
}
