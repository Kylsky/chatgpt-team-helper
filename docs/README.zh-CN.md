# ChatGPT Team Helper（中文说明）

> 本文档为**纯中文**版本，面向中文用户快速部署与运维。

## 目录

- [1. 项目简介](#1-项目简介)
- [2. 适用场景](#2-适用场景)
- [3. 功能清单](#3-功能清单)
- [4. 架构说明](#4-架构说明)
- [5. 部署教程（Docker）](#5-部署教程docker)
- [6. 本地开发](#6-本地开发)
- [7. 后台商品与价格修改](#7-后台商品与价格修改)
- [8. 常用运维命令](#8-常用运维命令)
- [9. 升级与回滚建议](#9-升级与回滚建议)
- [10. 常见问题](#10-常见问题)

---

## 1. 项目简介

ChatGPT Team Helper 是一个多渠道 Team 账号管理与兑换平台，覆盖：

- 账号管理（库存、状态、有效期）
- 兑换码管理（生成、发放、兑换）
- 支付下单（Zpay / Linux DO Credit）
- 订单自动化处理（回调、发码、通知）
- 权限体系（RBAC）与后台系统配置

---

## 2. 适用场景

- 需要统一管理多渠道订单（网页购买 + 第三方订单）
- 需要用户自助兑换、降低人工发码成本
- 需要管理员后台可视化管理商品、价格、权限和统计

---

## 3. 功能清单

### 账号与兑换
- Team 账号增删改查、封禁、到期管理
- 兑换码自动生成并关联账号
- 通用 / 小红书 / 闲鱼 / Linux DO 多渠道兑换
- 订单找回与补号

### 订单与支付
- 多商品购买
- 支付回调验签
- 订单状态自动流转
- 邮件和 Telegram 事件通知

### 平台能力
- 超级管理员 + 自定义角色权限
- 邀请奖励、购买奖励、积分流水
- 候车室、自动上车
- 系统设置在线配置（多数功能无需改代码）

---

## 4. 架构说明

```text
前端（Vue3）
  ↓ /api
后端（Express）
  ↓
数据库（SQLite / sql.js）
```

关键链路：
1. 下单 → 2. 支付 → 3. 回调验签 → 4. 自动兑换 → 5. 通知 + 状态入库

---

## 5. 部署教程（Docker）

### 第一步：拉代码

```bash
git clone https://github.com/Kylsky/chatgpt-team-helper.git
cd chatgpt-team-helper
```

### 第二步：配置环境变量

```bash
cp backend/.env.example backend/.env
```

最低必填：

```env
JWT_SECRET=请使用强随机字符串
INIT_ADMIN_PASSWORD=管理员密码
```

### 第三步：启动服务

```bash
docker compose up -d
```

访问：`http://服务器IP:5173`

登录账号：
- 用户名：`admin`
- 密码：`INIT_ADMIN_PASSWORD` 的值（未设置时可查日志）

---

## 6. 本地开发

```bash
npm install
```

启动后端：
```bash
cd backend
npm run dev
```

启动前端：
```bash
cd frontend
npm run dev
```

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`

---

## 7. 后台商品与价格修改

> 你可以直接在后台网页交互式修改，不必改 `.env`。

路径：**系统设置 → 支付商品管理**

可操作：
- 新增商品
- 修改商品名
- 修改价格（`amount`）
- 修改服务天数（`serviceDays`）
- 设置订单类型（`warranty / no_warranty`）
- 配置渠道优先级（`codeChannels`，如 `paypal,common`）
- 上下架商品

说明：
- 线上下单读取的是数据库 `purchase_products`
- `.env` 中价格主要用于“首次初始化默认商品”

---

## 8. 常用运维命令

查看状态：
```bash
docker compose ps
```

查看日志：
```bash
docker compose logs -f app
```

重启服务：
```bash
docker compose restart app
```

停止服务：
```bash
docker compose down
```

---

## 9. 升级与回滚建议

升级前建议：
1. 备份 `./data/database.sqlite`
2. 记录当前 commit/tag

升级：
```bash
git pull
docker compose down
docker compose up -d --build
```

回滚：
- 切回上一个稳定 commit/tag，再次构建启动
- 若涉及数据结构变更，先验证兼容性再回滚数据库

Zeabur 部署请看：`docs/zeabur-deploy.md`

---

## 10. 常见问题

### 1）容器起不来
```bash
docker compose logs app
```

### 2）数据库权限不足
```bash
chmod 777 ./data
docker compose restart app
```

### 3）改了 `.env` 价格但页面没变
- 原因：实际读取的是数据库商品表
- 解决：到后台“支付商品管理”里直接改商品价格
