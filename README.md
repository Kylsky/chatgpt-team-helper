# ChatGPT Team Helper

[![Telegram 交流群](https://img.shields.io/badge/Telegram-交流群-blue?logo=telegram)](https://t.me/+W7iplSdBGXhlMDc1)
[![Linux DO](https://img.shields.io/badge/Linux%20DO-Yelo-green?logo=discourse)](https://linux.do/u/yelo/summary)

> **中文**：面向新手可落地的多渠道 Team 账号管理与兑换平台文档。  
> **English**: A beginner-friendly deployment guide for a multi-channel Team account management and redemption platform.

---

## 目录 / Table of Contents

- [1. 项目介绍 / What is this](#1-项目介绍--what-is-this)
- [2. 你将得到什么 / What you get](#2-你将得到什么--what-you-get)
- [3. 系统架构 / Architecture](#3-系统架构--architecture)
- [4. 部署路线选择 / Choose your deployment path](#4-部署路线选择--choose-your-deployment-path)
- [5. 路线 A：Docker（VPS 推荐）/ Path A: Docker on VPS](#5-路线-adockervps-推荐-path-a-docker-on-vps)
- [6. 路线 B：Zeabur（托管）/ Path B: Zeabur](#6-路线-bzeabur托管-path-b-zeabur)
- [7. 首次登录后必做 / First-login checklist](#7-首次登录后必做--first-login-checklist)
- [8. 商品与价格修改（网页后台）/ Product & pricing in Admin UI](#8-商品与价格修改网页后台-product--pricing-in-admin-ui)
- [9. 常用配置模板 / Common config templates](#9-常用配置模板--common-config-templates)
- [10. 更新、备份、回滚 / Update, backup, rollback](#10-更新备份回滚--update-backup-rollback)
- [11. 新手排错指南 / Beginner troubleshooting](#11-新手排错指南--beginner-troubleshooting)
- [12. 项目结构 / Project structure](#12-项目结构--project-structure)
- [13. 文档索引 / Documentation](#13-文档索引--documentation)
- [14. License](#14-license)

---

## 1. 项目介绍 / What is this

**中文**

ChatGPT Team Helper 用来做这几件事：

- 管理 Team 账号库存（开关、状态、到期）
- 多渠道订单接入（支付、小红书、闲鱼、Linux DO）
- 用户自助兑换，系统自动发码/上车
- 管理员后台统一处理商品、订单、权限、通知

**English**

ChatGPT Team Helper helps you:

- Manage Team account inventory and lifecycle
- Integrate multiple order channels (payment, XHS, Xianyu, Linux DO)
- Offer self-service redemption with automatic fulfillment
- Operate products, orders, permissions, and notifications in one Admin panel

---

## 2. 你将得到什么 / What you get

- ✅ 可登录的后台管理系统（admin）
- ✅ 可访问的购买页面（用户下单）
- ✅ 可配置商品（名称、价格、服务天数）
- ✅ 可选开启支付、Telegram 机器人、第三方订单同步

---

## 3. 系统架构 / Architecture

```text
Browser (Admin/User)
        │
        ▼
Frontend (Vue3, served by Nginx)
        │  /api
        ▼
Backend (Node.js + Express)
        │
        ▼
SQLite (sql.js file)
```

**核心链路 / Core flow**

1. 用户选商品并下单
2. 支付平台回调通知
3. 系统验签并更新订单状态
4. 自动兑换 / 发码
5. 邮件或 Telegram 通知

---

## 4. 部署路线选择 / Choose your deployment path

- **路线 A（推荐）**：你有自己的 VPS（Ubuntu/Debian 等），用 Docker Compose 部署。
- **路线 B**：你在 Zeabur 上托管部署（无需自己配服务器）。

> 新手建议：先走路线 A 跑通，再加支付/机器人。

---

## 5. 路线 A：Docker（VPS 推荐）/ Path A: Docker on VPS

### 5.1 前置条件检查（必做）

```bash
# 1) 查看系统版本
uname -a

# 2) 确认 Docker
docker --version

# 3) 确认 Docker Compose 插件
docker compose version
```

如果没装 Docker（Ubuntu 示例）：

```bash
curl -fsSL https://get.docker.com | bash
sudo usermod -aG docker $USER
# 重新登录 shell 后生效
```

### 5.2 克隆仓库

```bash
git clone https://github.com/Kylsky/chatgpt-team-helper.git
cd chatgpt-team-helper
```

### 5.3 准备环境变量

```bash
cp backend/.env.example backend/.env
```

编辑 `backend/.env`，至少填写：

```env
JWT_SECRET=请填写强随机字符串
INIT_ADMIN_PASSWORD=请填写管理员密码
CORS_ORIGINS=http://你的IP:5173,https://你的域名
```

生成安全随机密钥（推荐）：

```bash
openssl rand -base64 32
```

### 5.4 启动服务

```bash
docker compose up -d
```

检查是否已启动：

```bash
docker compose ps
docker compose logs --tail 100 app
```

### 5.5 访问系统

- 浏览器打开：`http://你的服务器IP:5173`
- 用户名：`admin`
- 密码：`INIT_ADMIN_PASSWORD`

如果没配 `INIT_ADMIN_PASSWORD`，可查日志中的随机密码：

```bash
docker compose logs app | grep -i password
```

### 5.6 数据持久化说明（非常重要）

默认 `docker-compose.yml` 已挂载：

- 容器内：`/app/backend/db`
- 宿主机：`./data`

你的核心数据都在 `./data`。**升级前先备份这个目录。**

---

## 6. 路线 B：Zeabur（托管）/ Path B: Zeabur

详细版见：[`docs/zeabur-deploy.md`](docs/zeabur-deploy.md)

快速版：

1. 新建项目 → 从 Git 仓库部署
2. 设置环境变量：`JWT_SECRET`、`INIT_ADMIN_PASSWORD`
3. 端口使用 `5173`
4. 挂载持久化磁盘到 `/app/backend/db`
5. Redeploy 后访问生成域名

---

## 7. 首次登录后必做 / First-login checklist

登录后台后建议按顺序做：

1. 修改管理员密码
2. 检查“系统设置”中的关键配置
3. 新增/编辑商品（价格、天数、渠道）
4. 先做一次“测试下单（不接真实支付也行）”
5. 再逐步开启 Telegram、支付、第三方同步

> 不要一次性全开，按模块逐步验证最稳。

---

## 8. 商品与价格修改（网页后台）/ Product & pricing in Admin UI

路径：**系统设置 → 支付商品管理**

你可以直接网页交互式修改：

- 商品名（productName）
- 价格（amount）
- 服务天数（serviceDays）
- 订单类型（warranty / no_warranty）
- 渠道优先级（codeChannels，例如 `paypal,common`）
- 上下架（isActive）

> 说明：线上下单读取的是数据库 `purchase_products`，不是实时读取 `.env` 价格。

---

## 9. 常用配置模板 / Common config templates

### 9.1 最小可用（先跑通）

```env
JWT_SECRET=xxx
INIT_ADMIN_PASSWORD=xxx
CORS_ORIGINS=http://你的IP:5173
```

### 9.2 开启支付（Zpay）

```env
ZPAY_BASE_URL=https://zpayz.cn
ZPAY_PID=你的pid
ZPAY_KEY=你的key
PUBLIC_BASE_URL=https://你的域名
```

### 9.3 开启 Telegram Bot

```env
TELEGRAM_BOT_TOKEN=123456:ABCDEF
TELEGRAM_ALLOWED_USER_IDS=123456789
TELEGRAM_NOTIFY_ENABLED=true
TELEGRAM_NOTIFY_CHAT_IDS=123456789
```

---

## 10. 更新、备份、回滚 / Update, backup, rollback

### 10.1 升级前备份

```bash
cp -r data data.backup.$(date +%F-%H%M)
```

### 10.2 正常升级

```bash
git pull
docker compose down
docker compose up -d --build
```

### 10.3 快速回滚

```bash
# 1) 切回旧版本
git log --oneline -n 10
git checkout <old_commit>

# 2) 重建并启动
docker compose down
docker compose up -d --build
```

---

## 11. 新手排错指南 / Beginner troubleshooting

### Q1：页面打不开

- 检查安全组/防火墙是否放行 `5173`
- 执行：`docker compose ps`
- 看日志：`docker compose logs --tail 100 app`

### Q2：登录失败

- 确认 admin 密码是否正确
- 查看是否用了旧数据库（`./data`）
- 如需重置请先备份数据后再处理

### Q3：改了 .env 价格但前台没变

- 这是预期行为
- 去后台 **系统设置 → 支付商品管理** 改数据库商品

### Q4：Zeabur 更新后配置丢失

- 检查是否挂载了持久化磁盘 `/app/backend/db`
- 检查环境变量是否在服务里保存

### Q5：支付回调失败

- 确认 `PUBLIC_BASE_URL` 可公网访问
- 检查回调路径可达：`/notify`
- 查看订单日志和支付网关日志对照排查

---

## 12. 项目结构 / Project structure

```text
.
├── frontend/               # Vue 前端
│   └── src/views           # 管理后台与页面
├── backend/                # Node 后端
│   └── src/routes          # API 路由
├── docs/                   # 文档
├── docker-compose.yml      # Docker 编排
├── Dockerfile              # 镜像构建
└── README.md
```

---

## 13. 文档索引 / Documentation

- 纯中文部署文档（更详细）: [`docs/README.zh-CN.md`](docs/README.zh-CN.md)
- Zeabur 部署: [`docs/zeabur-deploy.md`](docs/zeabur-deploy.md)
- 贡献指南: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- 安全策略: [`SECURITY.md`](SECURITY.md)

---

## 14. License

ISC
