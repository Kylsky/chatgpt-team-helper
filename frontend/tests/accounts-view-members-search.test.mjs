import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/views/AccountsView.vue', import.meta.url), 'utf-8')
const apiSource = readFileSync(new URL('../src/services/api.ts', import.meta.url), 'utf-8')

assert.match(source, /const memberSearchQuery = ref\(''\)/, '应新增顶部成员搜索关键字状态')
assert.match(source, /params\.memberSearch = memberSearchQuery\.value\.trim\(\)/, '加载账号列表时应传递成员搜索参数')
assert.match(source, /placeholder="按成员邮箱\/昵称\/ID搜索空间\.\.\."/, '顶部应渲染成员搜索框')
assert.doesNotMatch(source, /placeholder="搜索成员邮箱 \/ 昵称 \/ ID"/, '成员弹窗内不应再渲染成员搜索框')
assert.match(source, /watch\(memberSearchQuery, \(\) => \{[\s\S]*loadAccounts\(\)/, '顶部成员搜索应触发账号列表刷新')

assert.match(apiSource, /memberSearch\?: string/, '账号列表参数应支持成员搜索字段')

console.log('accounts-view-members-search tests passed')
