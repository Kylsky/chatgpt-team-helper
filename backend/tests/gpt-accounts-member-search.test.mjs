import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/routes/gpt-accounts.js', import.meta.url), 'utf-8')

assert.match(source, /const memberSearch = \(req\.query\.memberSearch \|\| req\.query\.member_search \|\| ''\)\.trim\(\)\.toLowerCase\(\)/, '应读取 memberSearch 参数')
assert.match(source, /FROM gpt_account_members gm/, '账号列表查询应关联成员缓存表')
assert.match(source, /gm\.account_id = gpt_accounts\.id/, '成员搜索应与账号ID关联')
assert.match(source, /LOWER\(COALESCE\(gm\.email, ''\)\) LIKE \?/, '成员搜索应支持邮箱模糊匹配')
assert.match(source, /LOWER\(COALESCE\(gm\.name, ''\)\) LIKE \?/, '成员搜索应支持昵称模糊匹配')
assert.match(source, /LOWER\(COALESCE\(gm\.member_id, ''\)\) LIKE \?/, '成员搜索应支持成员ID模糊匹配')
assert.match(source, /AS matched_member_label/, '成员搜索结果应返回命中成员提示文案')
assert.match(source, /AS matched_member_count/, '成员搜索结果应返回命中成员数量')

console.log('gpt-accounts-member-search tests passed')
