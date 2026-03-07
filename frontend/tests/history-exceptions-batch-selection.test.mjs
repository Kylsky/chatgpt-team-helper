import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/views/history-exceptions/HistoryExceptionsView.vue', import.meta.url), 'utf-8')

assert.match(source, /全选本页|取消全选本页/, '历史异常页应提供全选本页/取消全选本页按钮')
assert.match(source, /批量标记待处理/, '历史异常页应提供批量标记待处理按钮')
assert.match(source, /批量标记已解决/, '历史异常页应提供批量标记已解决按钮')
assert.match(source, /批量标记忽略/, '历史异常页应提供批量标记忽略按钮')
assert.match(source, /批量删除/, '历史异常页应提供批量删除按钮')
assert.match(source, /type="checkbox"/, '历史异常页应提供复选框用于选择记录')

console.log('history-exceptions batch-selection tests passed')
