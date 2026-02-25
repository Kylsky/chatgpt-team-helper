# ChatGPT Team Helper（中文部署手册｜新手完整版）

> 这份文档专门给第一次部署的新手。按顺序做，基本可以从 0 到可登录后台。

## 目录

- [1. 我需要准备什么](#1-我需要准备什么)
- [2. 最快跑通（10 分钟）](#2-最快跑通10-分钟)
- [3. 详细部署（VPS + Docker）](#3-详细部署vps--docker)
- [4. Zeabur 部署要点](#4-zeabur-部署要点)
- [5. 首次登录后的初始化顺序](#5-首次登录后的初始化顺序)
- [6. 商品和价格怎么改（网页后台）](#6-商品和价格怎么改网页后台)
- [7. 支付 / Telegram / Linux DO 配置入口](#7-支付--telegram--linux-do-配置入口)
- [8. 升级、备份、回滚](#8-升级备份回滚)
- [9. 常见报错与处理](#9-常见报错与处理)
- [10. 安全建议（强烈推荐）](#10-安全建议强烈推荐)

---

## 1. 我需要准备什么

### 服务器方式（推荐）

- 一台 Linux 服务器（Ubuntu / Debian）
- 已安装 Docker + Docker Compose
- 能访问公网（至少你的浏览器能打开服务器 IP）

### 必填信息

- 管理员初始密码（你自己定）
- 一个强随机 JWT 密钥（不要用示例值）

---

## 2. 最快跑通（10 分钟）

```bash
# 1) 克隆项目
git clone https://github.com/Kylsky/chatgpt-team-helper.git
cd chatgpt-team-helper

# 2) 准备环境变量
cp backend/.env.example backend/.env

# 3) 编辑 .env（至少改这两项）
# JWT_SECRET=随机长字符串
# INIT_ADMIN_PASSWORD=你的管理员密码

# 4) 启动
docker compose up -d

# 5) 看状态
docker compose ps
```

浏览器访问：`http://服务器IP:5173`

登录：
- 用户名 `admin`
- 密码 = 你设置的 `INIT_ADMIN_PASSWORD`

如果没设置初始密码，去日志找随机密码：

```bash
docker compose logs app | grep -i password
```

---

## 3. 详细部署（VPS + Docker）

### 3.1 检查 Docker 环境

```bash
docker --version
docker compose version
```

如果未安装（Ubuntu）：

```bash
curl -fsSL https://get.docker.com | bash
sudo usermod -aG docker $USER
# 退出后重新登录
```

### 3.2 配置 `.env`

```bash
cp backend/.env.example backend/.env
nano backend/.env
```

至少确保：

```env
JWT_SECRET=请用 openssl rand -base64 32 生成
INIT_ADMIN_PASSWORD=你自己设置的密码
CORS_ORIGINS=http://你的IP:5173,https://你的域名
```

生成密钥：

```bash
openssl rand -base64 32
```

### 3.3 启动服务

```bash
docker compose up -d
```

查看日志：

```bash
docker compose logs -f app
```

### 3.4 放行端口

- 服务器安全组/防火墙放行 `5173`
- 如果有域名，后续建议反代到 80/443

---

## 4. Zeabur 部署要点

完整说明见 `docs/zeabur-deploy.md`，这里是你最容易漏掉的两件事：

1. **端口必须用 5173**
2. **持久化硬盘必须挂载到 `/app/backend/db`**

否则常见现象：
- 能部署但重启后数据丢失
- 页面可访问但登录异常或配置丢失

---

## 5. 首次登录后的初始化顺序

建议按这个顺序来：

1. 修改管理员密码
2. 进入系统设置，确认基础配置
3. 配置商品（先配一个可售商品）
4. 做一次测试下单（先不接真实支付也可以）
5. 再逐步开启支付、TG 机器人、第三方同步

> 核心原则：**先最小可用，再逐步叠加功能**。

---

## 6. 商品和价格怎么改（网页后台）

路径：**系统设置 → 支付商品管理**

你可以直接交互式修改：

- 商品名称
- 价格（amount）
- 服务天数（serviceDays）
- 订单类型（warranty/no_warranty）
- 渠道优先级（codeChannels）
- 上下架

### 为什么我改 `.env` 的价格没生效？

因为线上读取的是数据库 `purchase_products`。`.env` 主要用于首次初始化默认商品。

---

## 7. 支付 / Telegram / Linux DO 配置入口

所有变量参考：`backend/.env.example`

### 7.1 Zpay（支付）

```env
ZPAY_BASE_URL=https://zpayz.cn
ZPAY_PID=你的pid
ZPAY_KEY=你的key
PUBLIC_BASE_URL=https://你的域名
```

### 7.2 Telegram 机器人

```env
TELEGRAM_BOT_TOKEN=bot token
TELEGRAM_ALLOWED_USER_IDS=你的tg用户id
TELEGRAM_NOTIFY_ENABLED=true
TELEGRAM_NOTIFY_CHAT_IDS=接收通知的chat id
```

### 7.3 Linux DO OAuth / Credit

```env
LINUXDO_CLIENT_ID=xxx
LINUXDO_CLIENT_SECRET=xxx
LINUXDO_REDIRECT_URI=https://你的域名/redeem/linux-do
LINUXDO_CREDIT_PID=xxx
LINUXDO_CREDIT_KEY=xxx
```

---

## 8. 升级、备份、回滚

### 8.1 升级前备份（一定做）

```bash
cp -r data data.backup.$(date +%F-%H%M)
```

### 8.2 升级

```bash
git pull
docker compose down
docker compose up -d --build
```

### 8.3 回滚

```bash
git log --oneline -n 10
git checkout <上一个稳定commit>
docker compose down
docker compose up -d --build
```

---

## 9. 常见报错与处理

### 9.1 启动报 JWT_SECRET 不安全

- 你用了默认值或留空
- 重新生成随机密钥后重启

### 9.2 页面打不开

- 端口没放行
- 容器没起来：`docker compose ps`
- 日志排查：`docker compose logs app`

### 9.3 登录失败

- 用错密码
- 老数据目录导致密码并非新 .env 值
- 查日志确认初始密码是否生效

### 9.4 下单成功但没回调

- 检查 `PUBLIC_BASE_URL` 是否公网可达
- 检查支付平台回调地址配置
- 查看 `/notify` 日志

### 9.5 改价后前台没刷新

- 清缓存后重试
- 确认改的是“支付商品管理”而不是 `.env`

---

## 10. 安全建议（强烈推荐）

1. 不要把 `.env` 提交到公开仓库
2. `JWT_SECRET` 使用强随机值
3. 管理后台尽量走 HTTPS
4. 生产环境限制 CORS 来源（不要 `*`）
5. 定期备份 `data/` 并演练恢复

---

如果你刚接手这项目，建议你先只做三件事：

1. 跑起来并登录后台
2. 改一个商品价格并验证前台显示
3. 做一次完整测试下单流程

这三步打通后，再去接支付机器人和第三方渠道。