import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/routes/gpt-accounts.js', import.meta.url), 'utf-8')

assert.match(source, /LOWER\(space_name\) LIKE \?/, '账号搜索应支持空间名称字段')

console.log('gpt-accounts search space-name tests passed')
