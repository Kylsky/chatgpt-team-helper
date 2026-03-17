# Team 项目 M3/M4/M5 设计文档

## 背景与目标

本设计面向 `team/PLAN.md` 中的三个待办模块：

- `M3`：在 Node 管理端新增内部导入接口 `/api/internal/accounts/import`。
- `M4`：提供包含 `postgres/redis/go-worker/python-binder/node-web` 的一键编排。
- `M5`：定时探测账号存活，发现封号后触发 Python 取消订阅止损。

本轮采用“不中断自动推进”模式。用户已明确要求全流程自动执行，因此将当前文档视为实现前设计快照并直接进入落地。

## 方案对比

### 方案 A（推荐）：在现有 SQLite 架构上做兼容扩展 + 新增内部流水线服务

- 做法：
  - 新增 `internal-accounts` 路由和 `internal-pipeline` 服务，复用当前 `gpt_accounts/redemption_codes`。
  - 对 `gpt_accounts` 增量扩字段（`password/team_name/session_token/card_last4`），满足导入与止损数据需要。
  - 新增 `account-liveness-probe` 服务，按周期检测并将封号账号推入 Redis `oai:queue:cancel_sub`。
  - 新增 `docker-compose.pipeline.yml` 负责编排 5 容器。
- 优点：改动小、与当前仓库兼容、可快速闭环。
- 缺点：仍是 SQLite，不完全等同共享层 PostgreSQL 模型。

### 方案 B：直接把 Node 端完整迁移到 PostgreSQL 并改全量 DAO

- 优点：与 `shared/init.sql` 完全一致。
- 缺点：影响面太大，超出 M3/M5“接口与探针”范围，交付风险高。

### 方案 C：在 Python/Go 侧绕过 Node，直接写库并生成兑换码

- 优点：Node 改动最少。
- 缺点：破坏管理中心单一入口，不利于后续渠道和通知扩展。

## 结论

采用 **方案 A**。它在不重构现有系统的前提下，实现了 M3/M4/M5 全链路可运行版本。

## 架构设计

### 1. M3 内部导入 API

新增路由：`POST /api/internal/accounts/import`

- 鉴权：Header `X-Internal-Token` 与 `INTERNAL_API_TOKEN` 常量时间比较。
- 输入：`email/password/team_name/access_token/refresh_token/session_token/card_last4/expires_at`。
- 处理：
  - 以邮箱为幂等键 upsert `gpt_accounts`。
  - 新建或复用可用兑换码（优先返回未兑换且未预留的兑换码）。
  - 可选发送 Telegram 通知（`INTERNAL_IMPORT_TELEGRAM_NOTIFY_ENABLED=true` 时触发）。
- 输出：`{ success, account_id, redemption_code }`。

可选辅助接口：`GET /api/internal/accounts/pending-tokens`

- 返回 token 即将过期或缺失关键 token 的账号，供 Python 拉取刷新。

### 2. M5 存活探针与止损

新增服务：`account-liveness-probe`

- 周期扫描 `gpt_accounts` 中 `is_open=1 AND is_banned=0` 的账号。
- 使用 `fetchOpenAiAccountInfo(access_token)` 探测可用性。
- 命中封号/失效后：
  - 标记 `is_banned=1, is_open=0, ban_processed=0`。
  - 将账号信息推送到 Redis `oai:queue:cancel_sub`（含 `email/password/reason`）。
  - 推送成功后置 `ban_processed=1`，避免重复止损。
- 账号缺密码时不推队列，保留 `ban_processed=0` 以便后续补偿。

### 3. M4 编排

新增 `docker-compose.pipeline.yml`：

- `postgres`：共享层数据库。
- `redis`：消息队列。
- `go-worker`：运行 `chatgpt-creator`。
- `python-binder`：运行 `gpt-auto-register --mode worker`。
- `node-web`：运行 `chatgpt-team-helper`。

通过共享 `.env` 变量统一连通：`DB_URL/REDIS_URL/INTERNAL_API_TOKEN/QUEUE_*`。

## 数据与兼容性

- `gpt_accounts` 增量字段：`password/team_name/session_token/card_last4`。
- 仅新增字段，不改历史列语义，避免破坏现有前台/管理后台逻辑。
- 兑换码仍沿用 `redemption_codes` 表，库存变化可被既有页面复用。

## 错误处理

- 鉴权失败：`401 unauthorized`。
- 参数错误：`400 invalid payload`（含具体字段）。
- Redis 不可用：探针记录错误并保留 `ban_processed=0`，下轮重试。
- DB 写入失败：`500` 且不返回半成功状态。

## 测试策略

- 单元测试（Node 内置 test）：
  - `internal-pipeline`：导入校验、幂等导入、兑换码分配。
  - `account-liveness-probe`：封号判定、取消队列推送、重复处理去重。
- 静态校验：`node --check`。
- 编排校验：`docker compose -f docker-compose.pipeline.yml config`。

## 验收标准

- M3 接口可被 Python 端按规范调用并得到 `account_id + redemption_code`。
- M4 编排文件可解析且服务依赖关系正确。
- M5 探针能把新封号账号推送到 `oai:queue:cancel_sub`，且不会重复推送。
