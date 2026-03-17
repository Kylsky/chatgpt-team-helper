import test from 'node:test'
import assert from 'node:assert/strict'
import initSqlJs from 'sql.js'
import { runLivenessProbeOnce } from '../src/services/account-liveness-probe.js'

const createDatabase = async () => {
  const SQL = await initSqlJs()
  const db = new SQL.Database()

  db.run(`
    CREATE TABLE gpt_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      password TEXT,
      token TEXT,
      is_open INTEGER DEFAULT 0,
      is_banned INTEGER DEFAULT 0,
      ban_processed INTEGER DEFAULT 0,
      updated_at DATETIME,
      created_at DATETIME
    )
  `)

  return db
}

const makeBanError = (status, message) => {
  const error = new Error(message)
  error.status = status
  return error
}

const fetchAccountFlags = (db, accountId) => {
  const result = db.exec(
    'SELECT is_open, COALESCE(is_banned, 0), COALESCE(ban_processed, 0) FROM gpt_accounts WHERE id = ?',
    [accountId]
  )
  const row = result?.[0]?.values?.[0]
  return {
    isOpen: Number(row?.[0] || 0),
    isBanned: Number(row?.[1] || 0),
    banProcessed: Number(row?.[2] || 0),
  }
}

test('探针识别封号后推送取消队列并标记已处理', async () => {
  const db = await createDatabase()
  db.run(
    `INSERT INTO gpt_accounts (email, password, token, is_open, is_banned, ban_processed, created_at, updated_at)
     VALUES ('a@example.com', 'pw-1', 'token-1', 1, 0, 0, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`
  )

  const pushed = []
  const redisClient = {
    lpush: async (queueName, payload) => {
      pushed.push({ queueName, payload: JSON.parse(payload) })
      return 1
    },
  }

  const summary = await runLivenessProbeOnce({
    db,
    redisClient,
    queueName: 'oai:queue:cancel_sub',
    fetchAccountInfo: async () => {
      throw makeBanError(401, 'token invalid')
    },
    save: async () => {},
  })

  assert.equal(summary.scanned, 1)
  assert.equal(summary.flagged, 1)
  assert.equal(summary.queued, 1)
  assert.equal(summary.queueErrors, 0)
  assert.equal(summary.skippedMissingPassword, 0)

  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].queueName, 'oai:queue:cancel_sub')
  assert.equal(pushed[0].payload.email, 'a@example.com')
  assert.equal(pushed[0].payload.password, 'pw-1')

  const state = fetchAccountFlags(db, 1)
  assert.equal(state.isOpen, 0)
  assert.equal(state.isBanned, 1)
  assert.equal(state.banProcessed, 1)
})

test('封号账号缺少密码时仅标记封号不推送队列', async () => {
  const db = await createDatabase()
  db.run(
    `INSERT INTO gpt_accounts (email, password, token, is_open, is_banned, ban_processed, created_at, updated_at)
     VALUES ('b@example.com', '', 'token-2', 1, 0, 0, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`
  )

  const summary = await runLivenessProbeOnce({
    db,
    redisClient: {
      lpush: async () => {
        throw new Error('should not queue without password')
      },
    },
    fetchAccountInfo: async () => {
      throw makeBanError(403, 'account_deactivated')
    },
    save: async () => {},
  })

  assert.equal(summary.flagged, 1)
  assert.equal(summary.queued, 0)
  assert.equal(summary.skippedMissingPassword, 1)

  const state = fetchAccountFlags(db, 1)
  assert.equal(state.isOpen, 0)
  assert.equal(state.isBanned, 1)
  assert.equal(state.banProcessed, 0)
})

test('已封号未处理账号会在下一轮补推取消队列', async () => {
  const db = await createDatabase()
  db.run(
    `INSERT INTO gpt_accounts (email, password, token, is_open, is_banned, ban_processed, created_at, updated_at)
     VALUES ('c@example.com', 'pw-3', 'token-3', 0, 1, 0, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`
  )

  let probeCalled = false
  const pushed = []
  const summary = await runLivenessProbeOnce({
    db,
    redisClient: {
      lpush: async (queueName, payload) => {
        pushed.push({ queueName, payload: JSON.parse(payload) })
        return 1
      },
    },
    fetchAccountInfo: async () => {
      probeCalled = true
      return []
    },
    save: async () => {},
  })

  assert.equal(probeCalled, false)
  assert.equal(summary.scanned, 0)
  assert.equal(summary.queued, 1)
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].payload.email, 'c@example.com')

  const state = fetchAccountFlags(db, 1)
  assert.equal(state.isBanned, 1)
  assert.equal(state.banProcessed, 1)
})
