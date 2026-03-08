import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const syncSource = readFileSync(new URL('../src/services/account-sync.js', import.meta.url), 'utf-8')
const routeSource = readFileSync(new URL('../src/routes/gpt-accounts.js', import.meta.url), 'utf-8')
const dbSource = readFileSync(new URL('../src/database/init.js', import.meta.url), 'utf-8')

assert.match(syncSource, /const replaceAccountMembersCache = async \(db, accountId, usersData = \{\}\) => \{/, '应提供成员缓存写入方法')
assert.match(syncSource, /await replaceAccountMembersCache\(db, syncedAccount\.id, usersData\)/, '同步成员后应写入缓存')
assert.match(syncSource, /DELETE FROM gpt_account_members WHERE account_id = \?/, '写入缓存前应先清理历史数据')

assert.match(routeSource, /router\.get\('\/:id\/members', async \(req, res\) => \{/, '应提供成员缓存查询接口')
assert.match(routeSource, /FROM gpt_account_members/, '成员查询接口应从缓存表读取')
assert.match(routeSource, /LOWER\(email\) LIKE \? OR LOWER\(name\) LIKE \? OR LOWER\(member_id\) LIKE \?/, '成员查询接口应支持邮箱、昵称、ID 搜索')

assert.match(dbSource, /CREATE TABLE IF NOT EXISTS gpt_account_members/, '数据库应包含成员缓存表')
assert.match(dbSource, /UNIQUE\(account_id, member_id\)/, '成员缓存表应包含账号+成员唯一约束')

console.log('gpt-account-members-cache tests passed')
