import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/views/AccountsView.vue', import.meta.url), 'utf-8')
const apiSource = readFileSync(new URL('../src/services/api.ts', import.meta.url), 'utf-8')

assert.match(source, /const memberSearchQuery = ref\(''\)/, '应新增成员搜索关键字状态')
assert.match(source, /const loadMembers = async \(accountId: number\) => \{/, '应新增成员缓存加载方法')
assert.match(source, /await gptAccountService\.getMembers\(accountId, \{/, '应调用成员缓存接口')
assert.match(source, /placeholder="搜索成员邮箱 \/ 昵称 \/ ID"/, '应在成员区域渲染搜索框')
assert.match(source, /v-for="user in membersList"/, '成员表应渲染缓存列表')
assert.match(source, /watch\(memberSearchQuery, \(\) => \{/, '成员搜索应具备监听和防抖逻辑')

assert.match(apiSource, /async getMembers\(accountId: number, params\?: \{ offset\?: number; limit\?: number; query\?: string \}\): Promise<ChatgptAccountUsersResponse>/, 'API 服务应新增成员缓存接口方法')

console.log('accounts-view-members-search tests passed')
