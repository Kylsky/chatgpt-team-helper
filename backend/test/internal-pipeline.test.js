import test from 'node:test'
import assert from 'node:assert/strict'
import initSqlJs from 'sql.js'
import {
  importAccountFromPipeline,
  validateImportPayload,
} from '../src/services/internal-pipeline.js'

const createDatabase = async () => {
  const SQL = await initSqlJs()
  const db = new SQL.Database()

  db.run(`
    CREATE TABLE gpt_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      password TEXT,
      team_name TEXT,
      token TEXT NOT NULL,
      refresh_token TEXT,
      session_token TEXT,
      user_count INTEGER DEFAULT 0,
      invite_count INTEGER DEFAULT 0,
      chatgpt_account_id TEXT,
      oai_device_id TEXT,
      expire_at TEXT,
      is_open INTEGER DEFAULT 0,
      is_demoted INTEGER DEFAULT 0,
      is_banned INTEGER DEFAULT 0,
      ban_processed INTEGER DEFAULT 0,
      card_last4 TEXT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `)

  db.run(`
    CREATE TABLE redemption_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      is_redeemed INTEGER DEFAULT 0,
      redeemed_at DATETIME,
      redeemed_by TEXT,
      account_email TEXT,
      channel TEXT DEFAULT 'common',
      channel_name TEXT DEFAULT '通用渠道',
      created_at DATETIME,
      updated_at DATETIME,
      reserved_for_order_no TEXT
    )
  `)

  return db
}

const parseCount = (db, sql, params = []) => {
  const result = db.exec(sql, params)
  return Number(result?.[0]?.values?.[0]?.[0] || 0)
}

test('validateImportPayload 缺少必要字段时抛错', () => {
  assert.throws(() => validateImportPayload({}), /email is required/)
  assert.throws(() => validateImportPayload({ email: 'a@b.com' }), /password is required/)
  assert.throws(
    () => validateImportPayload({ email: 'a@b.com', password: 'x' }),
    /access_token is required/
  )
})

test('importAccountFromPipeline 首次导入创建账号和兑换码', async () => {
  const db = await createDatabase()
  const payload = validateImportPayload({
    email: 'User@Example.com',
    password: 'Passw0rd!',
    team_name: 'TeamAuto1234',
    access_token: 'token-1',
    refresh_token: 'refresh-1',
    session_token: 'session-1',
    card_last4: '4242',
    expires_at: '2026-04-17T00:00:00Z',
  })

  const result = await importAccountFromPipeline({
    db,
    payload,
    saveFn: async () => {},
    generateCodeFn: () => 'TEAM-ABCD-EFGH',
  })

  assert.equal(result.accountId, 1)
  assert.equal(result.action, 'created')
  assert.equal(result.redemptionCode, 'TEAM-ABCD-EFGH')

  assert.equal(parseCount(db, 'SELECT COUNT(*) FROM gpt_accounts'), 1)
  assert.equal(parseCount(db, 'SELECT COUNT(*) FROM redemption_codes'), 1)
})

test('重复导入同邮箱时复用账号与可用兑换码', async () => {
  const db = await createDatabase()
  const basePayload = {
    email: 'reuse@example.com',
    password: 'Passw0rd!',
    team_name: 'TeamA',
    access_token: 'token-1',
  }

  await importAccountFromPipeline({
    db,
    payload: validateImportPayload(basePayload),
    saveFn: async () => {},
    generateCodeFn: () => 'TEAM-REUSE-0001',
  })

  const result = await importAccountFromPipeline({
    db,
    payload: validateImportPayload({
      ...basePayload,
      access_token: 'token-2',
      refresh_token: 'refresh-2',
      session_token: 'session-2',
    }),
    saveFn: async () => {},
    generateCodeFn: () => 'TEAM-REUSE-9999',
  })

  assert.equal(result.accountId, 1)
  assert.equal(result.action, 'updated')
  assert.equal(result.redemptionCode, 'TEAM-REUSE-0001')
  assert.equal(parseCount(db, 'SELECT COUNT(*) FROM gpt_accounts'), 1)
  assert.equal(parseCount(db, 'SELECT COUNT(*) FROM redemption_codes'), 1)
})

test('无可用兑换码时为已有账号补发新码', async () => {
  const db = await createDatabase()

  await importAccountFromPipeline({
    db,
    payload: validateImportPayload({
      email: 'rotate@example.com',
      password: 'Passw0rd!',
      team_name: 'TeamB',
      access_token: 'token-1',
    }),
    saveFn: async () => {},
    generateCodeFn: () => 'TEAM-OLDC-0001',
  })

  db.run("UPDATE redemption_codes SET is_redeemed = 1 WHERE code = 'TEAM-OLDC-0001'")

  const result = await importAccountFromPipeline({
    db,
    payload: validateImportPayload({
      email: 'rotate@example.com',
      password: 'Passw0rd!',
      team_name: 'TeamB',
      access_token: 'token-2',
    }),
    saveFn: async () => {},
    generateCodeFn: () => 'TEAM-NEWC-0002',
  })

  assert.equal(result.accountId, 1)
  assert.equal(result.redemptionCode, 'TEAM-NEWC-0002')
  assert.equal(parseCount(db, 'SELECT COUNT(*) FROM redemption_codes'), 2)
})
