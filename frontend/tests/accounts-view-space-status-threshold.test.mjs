import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/views/AccountsView.vue', import.meta.url), 'utf-8')

assert.ok(
  source.includes("Number.isFinite(userCount) && userCount > 5")
  && source.includes("return { code: 'abnormal' as const, reason: `超员（${userCount}人）` }"),
  '人数超过 5 人时应显示“超员”并归类为异常状态'
)

assert.ok(
  source.includes("Number.isFinite(userCount) && userCount === 5")
  && source.includes("return { code: 'normal' as const, reason: '满员' }"),
  '人数等于 5 人时应显示“满员”'
)

console.log('accounts view space status threshold tests passed')
