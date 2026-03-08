# 对外开放 API（API Key）

本项目提供一组用于自动化/第三方对接的接口，统一使用 `x-api-key` 鉴权。

## 1) 基础信息

- Base URL：`https://<host>/api`
- 请求体：默认 `application/json`

## 2) 鉴权：`x-api-key`

所有“对外开放 API”都需要在请求头携带：

```
x-api-key: <your_api_key>
```

API Key 的读取优先级：

1. 数据库 `system_config.config_key=auto_boarding_api_key`
2. 环境变量 `AUTO_BOARDING_API_KEY`

若以上两处均未配置，则接口会返回 `503`（API Key 未配置，接口已禁用）。

建议：生产环境务必在后台系统设置或 `.env` 中配置强随机的 API Key（建议至少 16 位）。

## 3) 接口列表

| 方法 | Path | 用途 |
| --- | --- | --- |
| POST | `/api/auto-boarding` | 自动上车：创建/更新账号，并触发同步 |
| GET | `/api/auto-boarding/stats` | 自动上车统计 |
| POST | `/api/openai-accounts/generate-auth-url` | 生成 OpenAI OAuth 授权链接（PKCE，会话 10 分钟） |
| POST | `/api/openai-accounts/exchange-code` | 交换授权码，返回 token 与账号信息 |
| POST | `/api/gpt-accounts/ban` | 按邮箱批量标记封号（关闭开放） |
| GET | `/api/redemption-codes/artisan-flow/today` | 获取当天创建的 `artisan-flow` 渠道兑换码 |

## 4) 接口详情

### 4.1 POST `/api/auto-boarding`

用于“自动上车”脚本/服务添加或更新账号信息；当账号存在时更新，否则创建新账号。

**Headers**

- `x-api-key: <your_api_key>`
- `Content-Type: application/json`

**Body（JSON）**

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `email` | 是 | string | 账号邮箱（会被转小写并 trim） |
| `token` | 是 | string | access token |
| `refreshToken` | 否 | string | refresh token |
| `chatgptAccountId` | 否 | string | ChatGPT account id（用于优先匹配已有账号） |
| `oaiDeviceId` | 否 | string | `oai-did` |
| `expireAt` | 否 | string/number | 过期时间：支持 `YYYY/MM/DD HH:mm`、`YYYY-MM-DD HH:mm`、毫秒时间戳 |
| `isDemoted`/`is_demoted` | 否 | boolean/number | **Deprecated**：已弃用（请求会被忽略；响应恒为 `false`，仅保留兼容） |

**行为说明**

- 更新逻辑：优先用 `chatgptAccountId` 查找，其次用 `email` 查找。
- `expireAt`：如果未显式传入，后端会尝试从 `token` 的 JWT `exp` 字段推导并写入。
- `isDemoted`/`is_demoted`：已弃用，后端会忽略该字段。
- 新建账号时会自动生成若干兑换码（`generatedCodes` 字段返回）。
- 会触发一次账号同步（`syncResult`/`removedUsers` 字段返回）。

**响应**

- 200：更新成功（`action=updated`）
- 201：创建成功（`action=created`）
- 400：参数错误（例如缺少 `email/token`、`expireAt` 格式不正确）
- 401：API Key 不正确

**请求示例**

```bash
curl -X POST "https://<host>/api/auto-boarding" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your_api_key>" \
	  -d '{
	    "email": "user@example.com",
	    "token": "eyJhbGciOi...",
	    "refreshToken": "eyJhbGciOi...",
	    "chatgptAccountId": "acct_...",
	    "oaiDeviceId": "oai-did-...",
	    "expireAt": "2026/01/27 12:00"
	  }'
```

### 4.2 GET `/api/auto-boarding/stats`

获取自动上车的统计信息。

**Headers**

- `x-api-key: <your_api_key>`

**响应示例**

```json
{
  "success": true,
  "stats": {
    "totalAccounts": 10,
    "recentAccounts": 3
  }
}
```

### 4.3 POST `/api/openai-accounts/generate-auth-url`

生成 OpenAI 官方 OAuth 授权链接，并在服务端缓存一次性会话（默认 10 分钟有效），用于后续 `exchange-code` 校验 PKCE/state 等信息。

**Headers**

- `x-api-key: <your_api_key>`
- `Content-Type: application/json`

**Body（JSON，可选）**

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `proxy` | 否 | string | 代理 URL，例如 `http://user:pass@host:port` |

**响应示例**

```json
{
  "success": true,
  "data": {
    "authUrl": "https://auth.openai.com/oauth/authorize?...",
    "sessionId": "b3b0ad6e-...",
    "instructions": ["..."]
  }
}
```

**相关环境变量**

| 变量名 | 说明 |
| --- | --- |
| `OPENAI_BASE_URL` | 授权域名（默认 `https://auth.openai.com`） |
| `OPENAI_CLIENT_ID` | OpenAI 应用 Client ID |
| `OPENAI_REDIRECT_URI` | 回调地址（必须与 OpenAI 应用配置一致） |
| `OPENAI_SCOPE` | scope（默认 `openid profile email offline_access`） |

### 4.4 POST `/api/openai-accounts/exchange-code`

使用 `code` + `sessionId` 交换 OpenAI token，并返回解析后的账号/组织信息。会话为一次性，成功后会被删除；过期或重复使用需要重新生成授权链接。

**Headers**

- `x-api-key: <your_api_key>`
- `Content-Type: application/json`

**Body（JSON）**

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `code` | 是 | string | 授权回调 URL 中的 `code` 参数 |
| `sessionId` | 是 | string | `generate-auth-url` 返回的 `sessionId` |

### 4.5 POST `/api/gpt-accounts/ban`

按邮箱将账号标记为“封号”，会将 `is_open=0`、`is_banned=1`。支持单个或批量（最多 500 个邮箱）。

**Headers**

- `x-api-key: <your_api_key>`
- `Content-Type: application/json`

**Body（JSON）**

以下任意一种都可：

- `{"emails":["a@xx.com","b@xx.com"]}`
- `{"email":"a@xx.com"}`
- `["a@xx.com","b@xx.com"]`

**响应示例**

```json
{
  "message": "ok",
  "updated": 1,
  "matched": [{ "id": 123, "email": "a@xx.com" }],
  "notFound": ["b@xx.com"]
}
```

### 4.6 GET `/api/redemption-codes/artisan-flow/today`

获取服务器“本地时间”当天创建的 `artisan-flow` 渠道兑换码列表。

**Headers**

- `x-api-key: <your_api_key>`

**响应示例**

```json
{
  "success": true,
  "date": "2026-01-27",
  "total": 2,
  "codes": [
    {
      "id": 1,
      "code": "ABCD-EFGH-IJKL",
      "isRedeemed": false,
      "redeemedAt": null,
      "redeemedBy": null,
      "accountEmail": "owner@example.com",
      "channel": "artisan-flow",
      "channelName": "ArtisanFlow",
      "createdAt": "2026-01-27 10:00:00",
      "updatedAt": "2026-01-27 10:00:00"
    }
  ]
}
```
