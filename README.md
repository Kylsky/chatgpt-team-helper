# ChatGPT Team Helper
<img width="3840" height="1920" alt="image" src="https://github.com/user-attachments/assets/e5fcd950-7844-4ff7-be00-28246024a847" />

<img width="3840" height="1922" alt="image" src="https://github.com/user-attachments/assets/06e169e2-dfd3-4324-82ef-950bc96102c8" />

一个多渠道 Team 账号管理与兑换平台，支持多种订单渠道接入、自动发货、积分体系和权限管理。使用 Vue 3、Node.js、shadcn-vue 和 SQLite 构建。

[![Telegram 交流群](https://img.shields.io/badge/Telegram-交流群-blue?logo=telegram)](https://t.me/+W7iplSdBGXhlMDc1)
[![Linux DO](https://img.shields.io/badge/Linux%20DO-Yelo-green?logo=discourse)](https://linux.do/u/yelo/summary)

## 功能特性

### 账号管理
- Team 账号全生命周期管理（创建、编辑、删除、封号）
- 开放API 提供 Token 自动刷新与状态同步
- 账号用户数、邀请数实时同步（通过 OpenAI API）
- 账号到期管理与开放展示控制
- 创建账号时自动生成兑换码

### 多渠道兑换
- **通用兑换**：邮箱 + 兑换码直接兑换
- **小红书兑换**：邮箱 + 小红书订单号自动匹配兑换
- **闲鱼兑换**：邮箱 + 闲鱼订单号自动匹配兑换
- **Linux DO 兑换**：通过 Linux DO OAuth 身份验证后兑换
- **开放账号页**：Linux DO 用户付费上车，支持 Credit 积分支付
- **补号/账号恢复**：历史订单找回与重新兑换

### 订单管理
- **支付订单**：Zpay 支付网关集成，支持多种商品类型（标准、无质保、防封禁）
- **Credit 订单**：Linux DO Credit 支付网关集成
- **小红书订单**：API 自动同步 + 手动导入，定时轮询
- **闲鱼订单**：API 同步 + WebSocket 实时监听 + IM 自动发货

### 支付与商城
- 在线购买商城，支持多种商品
- Zpay / Credit 双支付网关
- 订单状态轮询与过期自动清理
- 支付回调与自动发码

### 积分体系
- 邀请奖励 & 购买奖励积分
- 积分提现/返现（比例与门槛可配置）
- 积分流水明细查询

### 候车室
- Linux DO 用户排队上车机制
- 信任等级门槛控制
- 自动上车定时任务（可配置活跃时段）
- 冷却期管理

### Telegram 机器人
- 私聊兑换流程（`/redeem`）
- 库存查询（`/stock`）
- 在线购买（`/buy`）
- 管理员专属：随机激活（`/random_activate`）、指定激活（`/activate`）
- 事件通知推送（支付成功、订单同步等）

### 权限管理（RBAC）
- 用户管理（注册、登录、邮箱域名白名单）
- 角色管理（超级管理员 / 自定义角色）
- 菜单权限动态分配
- 功能模块开关（小红书 / 闲鱼 / 支付 / 开放账号）

### 系统运维
- 邮件告警（SMTP）
- Cloudflare Turnstile 人机验证
- 开放账号超员扫描定时任务
- 订单过期清理定时任务
- Credit 订单失败补偿任务
- 数据统计仪表盘

## 技术栈

### 前端
- Vue 3 + TypeScript + Vite
- Vue Router
- shadcn-vue UI 组件
- Tailwind CSS v3
- Axios

### 后端
- Node.js + Express
- SQLite (sql.js)
- JWT 认证
- Nginx 反向代理（Docker 部署）
- Supervisor 进程管理（Docker 部署）

## 部署

### Docker Compose 部署（推荐）

#### 1. 克隆仓库

```bash
git clone <仓库地址>
cd auto-gpt-team
```

#### 2. 构建镜像

```bash
docker build -t auto-gpt-team:latest .
```

#### 3. 配置环境变量

```bash
cp backend/.env.example backend/.env
```

编辑 `backend/.env`，至少配置以下必填项：

```env
# 必须设置为强随机字符串，否则后端拒绝启动
JWT_SECRET=你的随机密钥

# 管理员初始密码（可选，不设则首次启动随机生成并输出到日志）
INIT_ADMIN_PASSWORD=你的初始密码

# 如前后端分离部署，配置允许的前端域名
CORS_ORIGINS=https://你的域名
```

> 完整环境变量列表请参考 `backend/.env.example`，大部分配置也可在管理后台「系统设置」中在线修改。

#### 4. 启动服务

```bash
docker compose up -d
```

#### 5. 访问应用

浏览器打开 `http://你的服务器IP:5173`

#### 6. 登录

- 用户名：`admin`
- 密码：`INIT_ADMIN_PASSWORD` 环境变量值，或查看容器日志获取随机密码：
  ```bash
  docker compose logs app | grep -i password
  ```

#### 数据持久化

`docker-compose.yml` 默认将数据库目录挂载到宿主机：

| 容器路径 | 宿主机路径 | 说明 |
| --- | --- | --- |
| `/app/backend/db` | `./data` | SQLite 数据库文件 |

#### 日志查看

所有日志统一输出到容器 stdout/stderr，使用 Docker 原生日志命令查看：

```bash
# 实时查看日志
docker compose logs -f app

# 查看最近 100 行
docker compose logs --tail 100 app
```

#### 常用运维命令

```bash
# 查看服务状态
docker compose ps

# 查看实时日志
docker compose logs -f app

# 重启服务
docker compose restart app

# 停止服务
docker compose down

# 重新构建并启动（代码更新后）
docker build -t auto-gpt-team:latest . && docker compose up -d
```

#### 更新升级

当有新版本发布时，可通过以下步骤更新：

```bash
# 1. 拉取最新代码
git pull

# 2. 重新构建镜像
docker build -t auto-gpt-team:latest .

# 3. 重启服务（自动使用新镜像）
docker compose down && docker compose up -d
```

> 也可以在管理后台「系统设置」页面点击「检查更新」按钮查看是否有新版本。

#### 自定义端口

修改 `docker-compose.yml` 中的端口映射：

```yaml
ports:
  - "8080:5173"  # 将外部端口改为 8080
```

#### 反向代理（Nginx 示例）

如需通过域名 + HTTPS 访问，在宿主机 Nginx 中添加：

```nginx
server {
    listen 443 ssl;
    server_name 你的域名;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Zeabur 部署

[Zeabur](https://zeabur.com) 是一个无需配置服务器的云平台，支持一键部署。

1. 在 Zeabur 创建项目，选择「从 Git 仓库部署」
2. 输入仓库地址：`https://github.com/Kylsky/chatgpt-team-helper`
3. 配置环境变量：`JWT_SECRET`、`INIT_ADMIN_PASSWORD`
4. 配置端口 `5173` 并生成域名
5. 添加持久化硬盘，挂载路径 `/app/backend/db`

详细步骤请参考 [Zeabur 部署教程](docs/zeabur-deploy.md)。

### 本地开发

#### 1. 安装依赖

```bash
npm install
```

#### 2. 启动开发服务器

终端 1 - 启动后端：
```bash
cd backend
npm run dev
```

终端 2 - 启动前端：
```bash
cd frontend
npm run dev
```

#### 3. 访问应用

- 前端：http://localhost:5173
- 后端 API：http://localhost:3000

## 可选功能配置

> 以下所有配置均可在管理后台「系统设置」中在线修改，系统配置优先于环境变量。

### 邮件服务（SMTP）

用于发送订单通知、告警邮件、邮箱验证码等。

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email@example.com
SMTP_PASS=your-password
SMTP_FROM=noreply@example.com
ADMIN_ALERT_EMAIL=admin@example.com

# 可选：自定义邮件主题
EMAIL_VERIFICATION_SUBJECT=邮箱验证码
PURCHASE_EMAIL_SUBJECT=订单信息
```

### Linux DO OAuth

使用 `/redeem/linux-do`、`/redeem/open-accounts` 或候车室功能前需配置。

```env
# 必填：在 connect.linux.do 创建应用获取
LINUXDO_CLIENT_ID=your-client-id
LINUXDO_CLIENT_SECRET=your-client-secret
LINUXDO_REDIRECT_URI=https://你的域名/redeem/linux-do

# 可选：自定义 OAuth Endpoint（一般无需修改）
LINUXDO_AUTH_URL=https://connect.linux.do/oauth2/authorize
LINUXDO_TOKEN_URL=https://connect.linuxdo.org/oauth2/token
LINUXDO_USER_INFO_URL=https://connect.linuxdo.org/api/user
```

#### Linux DO Credit 支付（开放账号上车）

LINUXDO_CREDIT_BASE_URL=https://credit.linux.do/epay
LINUXDO_CREDIT_PID=your-pid
LINUXDO_CREDIT_KEY=your-key
notify_url=https://yourdomain.com/credit/notify

# 上车消耗积分
OPEN_ACCOUNTS_CREDIT_COST=30
CREDIT_ORDER_EXPIRE_MINUTES=15

### Telegram 机器人

```env
# 必填：通过 @BotFather 创建机器人获得
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz

# 可选：限制可使用机器人的用户（逗号分隔），留空表示对所有人开放
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321

# 可选：机器人调用内部 API 的地址（默认 http://127.0.0.1:PORT/api）
TELEGRAM_INTERNAL_API_BASE_URL=https://你的域名/api
```

#### Telegram 通知推送

```env
# 是否启用通知（支付成功、订单同步等事件）
TELEGRAM_NOTIFY_ENABLED=true

# 通知接收者的 chat_id（逗号分隔），优先级高于 TELEGRAM_ALLOWED_USER_IDS
TELEGRAM_NOTIFY_CHAT_IDS=123456789

# 通知请求超时（毫秒）
TELEGRAM_NOTIFY_TIMEOUT_MS=8000
```

#### Telegram 账号绑定

使用 `/admin auth` 命令将 Telegram 账号绑定到系统用户，绑定后可使用管理员专属功能。

```
/admin auth <用户名或邮箱> <API_KEY>
```

- 仅限私聊中使用
- `API_KEY` 优先使用管理后台「系统设置」中配置的值，未配置时回退到 `backend/.env` 中的 `AUTO_BOARDING_API_KEY`
- 绑定成功后，若该用户拥有 `super_admin` 角色，即可使用 `/random_activate`、`/activate` 等管理员指令

#### Telegram 管理员功能

> ⚠️ `/activate` 和 `/random_activate` 命令暂未开放，以下配置仅供参考。

需要先通过 `/admin auth` 绑定 Telegram 账号，且该用户拥有 `super_admin` 角色。

```env
# /activate 指定激活账号
TELEGRAM_ACTIVATE_SSE_URL=http://127.0.0.1:8000/api/payments/checkout
TELEGRAM_ACTIVATE_API_KEY=your-api-key
TELEGRAM_ACTIVATE_TIMEOUT_MS=120000

# /random_activate 随机激活账号
TELEGRAM_RANDOM_ACTIVATE_SSE_URL=http://127.0.0.1:8000/api/team/accounts/random/checkout/sse
TELEGRAM_RANDOM_ACTIVATE_API_KEY=your-api-key
TELEGRAM_RANDOM_ACTIVATE_TIMEOUT_MS=120000
```

### 小红书订单同步

在管理后台「小红书订单」页面配置 Cookie 后启用。

```env
# 自动同步调度开关
XHS_AUTO_SYNC_SCHEDULER_ENABLED=true

# 轮询间隔（秒）
XHS_AUTO_SYNC_CHECK_INTERVAL_SECONDS=60
```

**Cookie 配置方式：**
1. 安装浏览器插件 [EditThisCookie](https://www.editthiscookie.com/)（推荐）或使用开发者工具
2. 登录小红书千帆（https://ark.xiaohongshu.com）
3. 使用 EditThisCookie 导出 JSON 格式的 Cookie，或在开发者工具 Network 面板复制请求 Cookie
4. 在管理后台「小红书订单」页面粘贴，支持以下格式：

```json
// 对象格式（推荐）
{
  "cookie_name_1": "cookie_value_1",
  "cookie_name_2": "cookie_value_2"
}

// 数组格式
[
  { "name": "cookie_name_1", "value": "cookie_value_1", "domain": ".xiaohongshu.com" }
]
```

### 闲鱼订单同步

在管理后台「闲鱼订单」页面配置 Cookie 后启用。

```env
# Cookie 自动续期调度开关
XIANYU_LOGIN_REFRESH_ENABLED=true

# 续期间隔（分钟）
XIANYU_LOGIN_REFRESH_INTERVAL_MINUTES=30
```

#### 闲鱼 WebSocket 自动发货

开启后，收到"待发货"订单时自动给买家发送 IM 消息。

```env
XIANYU_WS_DELIVERY_ENABLED=true
XIANYU_WS_DELIVERY_MESSAGE=请访问网页输入邮箱和订单号进行自助激活：https://你的域名/redeem/xianyu

# 可选：主动轮询同步间隔（秒），部分环境下服务端不会主动推送
XIANYU_WS_DELIVERY_SYNC_POLL_INTERVAL_SECONDS=60

# 调试选项
XIANYU_WS_DELIVERY_DEBUG=false
XIANYU_WS_DELIVERY_DRY_RUN=false
```

### 支付网关（Zpay）

```env
ZPAY_BASE_URL=https://zpayz.cn
ZPAY_PID=your-pid
ZPAY_KEY=your-key

# 可选：用于生成支付回调 notify_url 的公网域名
PUBLIC_BASE_URL=https://你的域名
```

#### 商品价格配置

```env
# 标准商品
PURCHASE_PRODUCT_NAME=通用渠道激活码
PURCHASE_PRICE=1.00
PURCHASE_SERVICE_DAYS=30

# 无质保商品
PURCHASE_NO_WARRANTY_PRODUCT_NAME=通用渠道激活码（无质保）
PURCHASE_NO_WARRANTY_PRICE=5.00
PURCHASE_NO_WARRANTY_SERVICE_DAYS=30

# 防封禁商品
PURCHASE_ANTI_BAN_PRODUCT_NAME=通用渠道激活码(防封禁)
PURCHASE_ANTI_BAN_PRICE=10.00
PURCHASE_ANTI_BAN_SERVICE_DAYS=30

# 订单过期时间（分钟）
PURCHASE_ORDER_EXPIRE_MINUTES=15
```

### Cloudflare Turnstile 人机验证

```env
TURNSTILE_SITE_KEY=your-site-key
TURNSTILE_SECRET_KEY=your-secret-key
TURNSTILE_TIMEOUT_MS=5000
```

### 代理配置

用于 OpenAI API 调用、开放账号上车、邀请同步等场景。

```env
# 代理池（逗号分隔，支持 http/https/socks5/socks5h）
OPEN_ACCOUNTS_SWEEPER_PROXY_URLS=socks5h://127.0.0.1:1080,http://user:pass@127.0.0.1:8080

# 或从文件读取（每行一个代理地址）
OPEN_ACCOUNTS_SWEEPER_PROXY_FILE=/path/to/proxies.txt

# 单个代理配置请参考 backend/.env.example（优先级与变量名以代码为准）
```

## 数据库

SQLite 数据库文件：`backend/db/database.sqlite`

重置数据库：
```bash
rm backend/db/database.sqlite
# 重启后端服务会自动重建数据库
```

## 项目结构

```
.
├── frontend/              # Vue 3 前端应用
│   ├── src/
│   │   ├── components/ui/ # shadcn-vue 组件
│   │   ├── views/         # 页面视图
│   │   ├── router/        # 路由配置
│   │   ├── services/      # API 服务
│   │   └── lib/           # 工具函数与菜单配置
│   └── package.json
├── backend/               # Node.js 后端应用
│   ├── src/
│   │   ├── database/      # 数据库初始化
│   │   ├── routes/        # API 路由
│   │   ├── services/      # 业务服务（同步、通知、定时任务等）
│   │   ├── middleware/     # 认证与权限中间件
│   │   └── server.js      # 服务器入口
│   └── package.json
├── Dockerfile             # 多阶段构建
├── docker-compose.yml     # 容器编排
├── nginx.conf             # Nginx 配置
├── supervisord.conf       # 进程管理配置
└── package.json           # 根配置（workspaces）
```

## 故障排除

### Docker 部署问题

**容器启动失败：**
```bash
docker compose logs app
```

**数据库权限问题：**
```bash
chmod 777 ./data
docker compose restart app
```

### 本地开发端口占用

```bash
# 后端（3000）
lsof -ti:3000 | xargs kill -9

# 前端（5173）
lsof -ti:5173 | xargs kill -9
```

## License

ISC
