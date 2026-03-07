import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/views/AccountsView.vue', import.meta.url), 'utf-8')

assert.match(source, />空间名称<\//, '账号列表应展示空间名称列')
assert.match(source, /\{\{\s*account\.spaceName \|\| '-'\s*\}\}/, '空间名称应在无值时回退为 -')
assert.match(source, /placeholder="搜索邮箱\/空间名称\.\.\."/, '搜索框占位符应提示支持空间名称检索')
assert.doesNotMatch(source, /已降级|未降级|降级状态/, '账号管理页不应再展示降级相关文案')
assert.doesNotMatch(source, /isDemoted/, '账号管理页不应再操作 isDemoted 字段')

console.log('accounts view space-name and demotion-removal tests passed')
