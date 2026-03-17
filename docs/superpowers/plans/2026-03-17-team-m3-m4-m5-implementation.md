# Team M3/M4/M5 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 完成 Team 项目 M3（内部导入 API）、M4（5容器编排）、M5（存活探针与封禁止损）并通过本地验证。

**Architecture:** 在现有 `chatgpt-team-helper` SQLite 架构上做增量扩展。新增内部流水线路由与服务层，复用 `gpt_accounts` / `redemption_codes`。探针服务独立调度并通过 Redis 推送取消订阅任务，编排文件统一连接三仓库服务。

**Tech Stack:** Node.js (Express, sql.js), Redis (ioredis), Docker Compose, Node built-in test runner.

---

## Chunk 1: M3 内部导入 API

### Task 1: 建立内部导入服务与路由

**Files:**
- Create: `backend/src/services/internal-pipeline.js`
- Create: `backend/src/routes/internal-accounts.js`
- Modify: `backend/src/server.js`
- Modify: `backend/src/database/init.js`
- Test: `backend/test/internal-pipeline.test.js`

- [x] **Step 1: 写失败测试（导入校验 + 幂等）**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateImportPayload, upsertImportedAccount } from '../src/services/internal-pipeline.js'

test('validateImportPayload 缺 email 时抛错', () => {
  assert.throws(() => validateImportPayload({}), /email is required/)
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `node --test backend/test/internal-pipeline.test.js`
Expected: FAIL（模块或函数未实现）

- [x] **Step 3: 实现最小服务与路由**

```js
router.post('/import', async (req, res) => {
  const token = req.headers['x-internal-token']
  // 鉴权 + payload 校验 + upsert + redemption code
})
```

- [x] **Step 4: 运行测试确认通过**

Run: `node --test backend/test/internal-pipeline.test.js`
Expected: PASS

- [x] **Step 5: 语法校验**

Run: `node --check backend/src/services/internal-pipeline.js backend/src/routes/internal-accounts.js`
Expected: 无报错

## Chunk 2: M5 探针与止损

### Task 2: 新增存活探针服务并接入启动流程

**Files:**
- Create: `backend/src/services/account-liveness-probe.js`
- Modify: `backend/src/server.js`
- Test: `backend/test/liveness-probe.test.js`

- [x] **Step 1: 写失败测试（封号 -> 推 cancel 队列）**

```js
test('封号账号会触发 cancel queue 且置 ban_processed=1', async () => {
  // mock db + mock redis push + mock probe failure
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `node --test backend/test/liveness-probe.test.js`
Expected: FAIL

- [x] **Step 3: 实现探针逻辑**

```js
export const runLivenessProbeOnce = async (deps) => {
  // 扫描账号 -> 探测 -> 标记封号 -> LPUSH cancel_sub
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `node --test backend/test/liveness-probe.test.js`
Expected: PASS

- [x] **Step 5: 语法校验**

Run: `node --check backend/src/services/account-liveness-probe.js`
Expected: 无报错

## Chunk 3: M4 编排与配置

### Task 3: 新增 5 容器 pipeline compose 与 env 示例

**Files:**
- Create: `docker-compose.pipeline.yml`
- Modify: `backend/.env.example`

- [x] **Step 1: 写 compose 文件（postgres/redis/go-worker/python-binder/node-web）**

```yaml
services:
  postgres: { image: postgres:16-alpine }
  redis: { image: redis:7-alpine }
  go-worker: { image: golang:1.25, command: go run ./cmd/register }
  python-binder: { image: python:3.13-slim, command: python main.py --mode worker }
  node-web: { build: . }
```

- [x] **Step 2: 补充 env 变量说明**

Run: edit `backend/.env.example` with `INTERNAL_API_TOKEN`, `LIVENESS_PROBE_*`, `PIPELINE_REDIS_URL` 等。

- [x] **Step 3: 校验 compose 可解析**

Run: `docker compose -f docker-compose.pipeline.yml config`
Expected: 输出标准化配置且退出码 0

## Chunk 4: 全量回归与收口

### Task 4: 执行验收检查与文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-03-17-team-m3-m4-m5-design.md`（仅在实现差异时回填）

- [x] **Step 1: 运行测试集合**

Run: `node --test backend/test/internal-pipeline.test.js backend/test/liveness-probe.test.js`
Expected: PASS

- [x] **Step 2: 运行语法检查**

Run: `node --check backend/src/routes/internal-accounts.js backend/src/services/internal-pipeline.js backend/src/services/account-liveness-probe.js`
Expected: PASS

- [x] **Step 3: 运行差异与空白检查**

Run: `git status --short && git diff --check`
Expected: 仅目标文件有改动，且无 whitespace 错误

- [x] **Step 4: 提交**

```bash
git add backend/src/routes/internal-accounts.js \
  backend/src/services/internal-pipeline.js \
  backend/src/services/account-liveness-probe.js \
  backend/src/database/init.js \
  backend/src/server.js \
  backend/.env.example \
  backend/test/internal-pipeline.test.js \
  backend/test/liveness-probe.test.js \
  docker-compose.pipeline.yml \
  docs/superpowers/specs/2026-03-17-team-m3-m4-m5-design.md \
  docs/superpowers/plans/2026-03-17-team-m3-m4-m5-implementation.md

git commit -m "feat: complete team pipeline M3 M4 M5"
```
