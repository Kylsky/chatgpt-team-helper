# ChatGPT Team Helper

[![Telegram 交流群](https://img.shields.io/badge/Telegram-交流群-blue?logo=telegram)](https://t.me/+W7iplSdBGXhlMDc1)
[![Linux DO](https://img.shields.io/badge/Linux%20DO-Yelo-green?logo=discourse)](https://linux.do/u/yelo/summary)

> **中文**：一个多渠道 Team 账号管理与兑换平台，支持多种订单来源、自动发货、积分体系、权限管理与 Telegram 机器人。  
> **English**: A multi-channel Team account management and redemption platform with order integrations, auto-delivery, points system, RBAC, and Telegram bot support.

---

## 目录 / Table of Contents

- [1. 项目概览 / Overview](#1-项目概览--overview)
- [2. 核心功能 / Features](#2-核心功能--features)
- [3. 系统架构 / Architecture](#3-系统架构--architecture)
- [4. 技术栈 / Tech Stack](#4-技术栈--tech-stack)
- [5. 快速开始（Docker，推荐）/ Quick Start](#5-快速开始docker推荐-quick-start)
- [6. 本地开发 / Local Development](#6-本地开发--local-development)
- [7. 配置说明 / Configuration](#7-配置说明--configuration)
- [8. 运维与升级 / Operations & Upgrade](#8-运维与升级--operations--upgrade)
- [9. 常见问题 / Troubleshooting](#9-常见问题--troubleshooting)
- [10. 项目结构 / Project Structure](#10-项目结构--project-structure)
- [11. 文档索引 / Documentation](#11-文档索引--documentation)
- [12. 许可证 / License](#12-许可证--license)

---

## 1. 项目概览 / Overview

**中文**

ChatGPT Team Helper 面向“账号分发 + 订单管理 + 自动兑换”场景，提供统一后台与自动化能力。你可以把它理解为一个轻量的运营控制台：

- 管理 Team 账号库存、状态、有效期
- 接入多来源订单（支付、小红书、闲鱼、Linux DO）
- 用户侧自助兑换，系统自动发码/上车
- 后台统一权限、统计和系统配置

**English**

ChatGPT Team Helper is designed for account distribution and automated redemption workflows. It acts as a lightweight operations console:

- Manage Team account lifecycle, inventory, and status
- Integrate multiple order sources (payments, XHS, Xianyu, Linux DO)
- Enable self-service redemption with automatic fulfillment
- Centralize permissions, metrics, and runtime configuration

---

## 2. 核心功能 / Features

### 2.1 账号与兑换 / Accounts & Redemption

- Team 账号全生命周期管理（创建、编辑、封禁、到期）
- 自动生成兑换码并关联账号
- 多渠道兑换：通用、小红书、闲鱼、Linux DO
- 补号/账号恢复（历史订单找回）

### 2.2 订单与支付 / Orders & Payments

- 在线购买（多商品）
- Zpay / Linux DO Credit 支付支持
- 支付回调、订单轮询、过期清理
- 自动兑换 + 邮件/Telegram 通知

### 2.3 平台能力 / Platform Capabilities

- RBAC 权限管理（超级管理员 + 自定义角色）
- 邀请奖励、购买奖励、积分返现
- 候车室机制（排队、信任门槛、自动上车）
- 系统设置后台化（大部分配置可在线调整）

---

## 3. 系统架构 / Architecture

```text
┌───────────────────────────┐
│        Frontend (Vue3)    │
│ Admin / User / Purchase   │
└──────────────┬────────────┘
               │ /api
┌──────────────▼────────────┐
│     Backend (Express)     │
│ Auth / Orders / Redeem    │
│ Purchase / Open Accounts  │
│ Telegram / Schedulers     │
└──────────────┬────────────┘
               │
┌──────────────▼────────────┐
│      SQLite (sql.js)      │
│ Accounts / Orders / Config│
└───────────────────────────┘
```

**关键流程 / Key Flow**

1. 用户选商品并创建订单  
2. 调起支付并等待回调  
3. 回调验签通过后，自动兑换并入账  
4. 发送邮件/TG 通知并更新后台状态

---

## 4. 技术栈 / Tech Stack

### Frontend
- Vue 3 + TypeScript + Vite
- Vue Router + Pinia
- shadcn-vue + Tailwind CSS

### Backend
- Node.js + Express
- SQLite (`sql.js`)
- JWT Authentication
- node-telegram-bot-api

### Deployment
- Docker / Docker Compose
- Nginx reverse proxy
- Supervisor process management

---

## 5. 快速开始（Docker，推荐）/ Quick Start

### 5.1 克隆项目 / Clone

```bash
git clone https://github.com/Kylsky/chatgpt-team-helper.git
cd chatgpt-team-helper
```

### 5.2 准备环境变量 / Prepare env

```bash
cp backend/.env.example backend/.env
```

最少需要配置（Minimum required）：

```env
JWT_SECRET=your-strong-random-secret
INIT_ADMIN_PASSWORD=your-admin-password
```

> 生产环境必须设置高强度 `JWT_SECRET`，否则后端会拒绝启动。

### 5.3 启动服务 / Start

```bash
docker compose up -d
```

访问地址 / Access:
- `http://<your-server-ip>:5173`

默认管理员 / Default admin:
- 用户名：`admin`
- 密码：`INIT_ADMIN_PASSWORD` 的值（若未设置会在日志随机生成）

### 5.4 数据持久化 / Data persistence

`docker-compose.yml` 默认将数据库目录挂载到宿主机 `./data`。

---

## 6. 本地开发 / Local Development

### 6.1 安装依赖 / Install

```bash
npm install
```

### 6.2 启动开发环境 / Run dev

终端 1 / Terminal 1:
```bash
cd backend
npm run dev
```

终端 2 / Terminal 2:
```bash
cd frontend
npm run dev
```

访问地址 / Access:
- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3000`

---

## 7. 配置说明 / Configuration

完整变量请看：[`backend/.env.example`](backend/.env.example)

高频配置（Most used）：

- 基础安全：`JWT_SECRET`, `CORS_ORIGINS`
- 支付：`ZPAY_BASE_URL`, `ZPAY_PID`, `ZPAY_KEY`
- Telegram：`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`
- Linux DO OAuth/Credit：`LINUXDO_CLIENT_ID`, `LINUXDO_CLIENT_SECRET`, `LINUXDO_CREDIT_*`
- 定时任务：`ORDER_EXPIRATION_SWEEPER_*`, `XHS_AUTO_SYNC_*`, `XIANYU_*`

> **价格与商品说明**：线上商品价格与服务期以数据库 `purchase_products` 为准；`.env` 主要用于初始化默认商品。

---

## 8. 运维与升级 / Operations & Upgrade

### 8.1 查看状态与日志

```bash
docker compose ps
docker compose logs -f app
```

### 8.2 更新版本（Git 部署）

```bash
git pull
docker compose down
docker compose up -d --build
```

### 8.3 升级前建议 / Before upgrade

- 备份数据库：`./data/database.sqlite`
- 记录当前镜像 tag/commit，便于快速回滚

### 8.4 Zeabur 用户

请参考：[`docs/zeabur-deploy.md`](docs/zeabur-deploy.md)

---

## 9. 常见问题 / Troubleshooting

### 容器启动失败

```bash
docker compose logs app
```

### 数据库目录权限问题

```bash
chmod 777 ./data
docker compose restart app
```

### 本地端口占用

```bash
# backend:3000
lsof -ti:3000 | xargs kill -9

# frontend:5173
lsof -ti:5173 | xargs kill -9
```

---

## 10. 项目结构 / Project Structure

```text
.
├── frontend/              # Vue 3 前端
│   └── src/
│       ├── views/         # 页面
│       ├── services/      # API 调用
│       ├── router/        # 路由
│       └── components/    # 组件
├── backend/               # Node.js 后端
│   └── src/
│       ├── routes/        # API 路由
│       ├── services/      # 业务服务
│       ├── middleware/    # 认证/权限
│       └── database/      # 初始化与迁移
├── docs/                  # 文档
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## 11. 文档索引 / Documentation

- 中文说明（纯中文）: [`docs/README.zh-CN.md`](docs/README.zh-CN.md)
- Zeabur 部署: [`docs/zeabur-deploy.md`](docs/zeabur-deploy.md)
- 贡献指南: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- 安全策略: [`SECURITY.md`](SECURITY.md)

---

## 12. 许可证 / License

ISC
