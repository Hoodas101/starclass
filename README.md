# 星课 StarClass · 教培 / 健身机构一体化管理系统

[![CI](https://github.com/Hoodas101/starclass/actions/workflows/ci.yml/badge.svg)](https://github.com/Hoodas101/starclass/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**一套自托管的教务系统**：招生 · 排课 · 考勤 · 家校沟通 · 续费 · 薪资，全在一个后台里。
**零云依赖**，数据 100% 留在机构自己的机器上，一条命令跑起来。

[中文](#快速开始) · [English](#english)

> 对比 SaaS（同类 ¥499–2,099 / 年）：一次部署、不限学员、数据归己，员工离职也带不走。

---

## 快速开始

```bash
git clone https://github.com/Hoodas101/starclass.git && cd starclass

bash deploy.sh                     # 正式使用：只建一个管理员，随机口令仅在终端打印一次
SEED_DEMO_DATA=1 bash deploy.sh    # 先看效果：额外灌入演示数据
```

打开 <http://localhost:3001> 即可。演示账号 `13800000001` / `123456`（仅灌演示数据时存在）。

**部署到云服务器（Docker + 自动 HTTPS）**

```bash
./deploy/deploy.sh --host app.yourdomain.com   # 内网用 --no-https
```

单容器交付（API + 后台同端口），SQLite 存于数据卷、跨升级保留。也可在 GitHub Actions 点 **Deploy → Run workflow** 全自动部署，详见 [`deploy/README.md`](deploy/README.md)。

| 服务 | 地址 |
|---|---|
| 🖥️ 管理后台 | <http://localhost:3001> |
| ⚙️ 后端 API | <http://localhost:3001/api>（健康检查 `/api/health`） |

> 上线前请修改默认密码（系统设置 → 账号安全）；方式 B/C 的管理员为随机口令，以脚本输出为准。

### 常用命令

```bash
bash deploy.sh        # 一键部署 / 重新部署（已有数据不受影响）
bash start-all.sh     # 日常启动     bash stop-all.sh   # 停止
npm test              # 后端全量回归（35 套件 · 362 项断言，隔离测试库）
npm run smoke         # 冒烟测试（需服务运行中）
```

---

## 功能一览

| 模块 | 能力 |
|---|---|
| 📊 数据看板 | 收入趋势、签单排名、到场率、续期预警 |
| 🗓️ 排课 | 周视图 / 列表、重复规则、冲突检测、公开报名、补课 / 调课 |
| ✅ 考勤 | 一键点名、签到统计、缺席自动通知、迟到计积分 |
| 👥 成员 | 学员 / 家长档案、会员卡暂停恢复、多孩绑定、续费提醒 |
| 💬 家校沟通 | 站内通知、反馈回复、教练课后点评 |
| 💰 销售 | 开卡自动激活权益、批量导入、自定义退费、财务汇总 |
| 🧾 薪资 | 课时 / 人头 / 混合计费，规则可视化配置 |
| ⚙️ 可定制 | 全站称呼替换、表格字段配置、积分 / 退费 / 请假规则可配 |
| 🌗 界面 | 深色 / 浅色 / 跟随系统 |

**可选付费扩展**：家长 / 教练 / 管理三端微信小程序（41 页）不随本仓库发布，后端 API 已预留微信登录、支付与订阅消息能力，购买部署授权后对接即可。

> 咨询与合作：在本仓库 [Issues](https://github.com/Hoodas101/starclass/issues) 留言（中文即可）。

---

## 技术架构

```
┌──────────────────────────────────────────────┐
│  Web 管理后台  Vue3 + Element Plus + Vite     │
│  8 个主路由 + 5 个工作台 · 深色模式            │
└───────────────────┬──────────────────────────┘
                    │ 同端口静态托管（:3001 单入口）
┌───────────────────▼──────────────────────────┐
│  Express 后端（Node.js）                      │
│  JWT 鉴权 · bcrypt · 角色门控 · 限流           │
│  自动备份 · 幂等迁移系统                       │
├──────────────────────────────────────────────┤
│  SQLite（better-sqlite3, WAL）· 单文件数据库   │
└──────────────────────────────────────────────┘
        （可选：三端小程序经 HTTPS + Bearer Token 对接）
```

| 端 | 技术栈 | 目录 |
|---|---|---|
| 后端 | Node.js + Express + better-sqlite3 | `backend/` |
| Web 管理端 | Vue3 + Element Plus + ECharts + Vite | `web-admin/` |

> **质量**：35 套自动化回归（支付幂等 / 退款回收 / 跨角色越权 / 审计留痕 / 口径一致性），CI 在 Node 18 / 20 / 22 全绿。改代码后跑 `npm test` 即可复现。

**运行成本为零**：无云服务、无独立数据库、无消息队列，1 核 2G 服务器或一台旧笔记本即可长期运行。

---

## 界面预览

**浅色模式**

| 登录 | 数据看板 | 排课管理 |
|---|---|---|
| ![登录](docs/screenshots/01-login.png) | ![看板](docs/screenshots/02-dashboard.png) | ![排课](docs/screenshots/03-schedule.png) |

| 点名签到 | 成员档案 | 订单管理 |
|---|---|---|
| ![签到](docs/screenshots/04-checkin.png) | ![成员](docs/screenshots/05-students.png) | ![订单](docs/screenshots/07-orders.png) |

**深色模式**

| 数据看板 | 排课管理 |
|---|---|
| ![深色看板](docs/screenshots/10-dark-dashboard.png) | ![深色排课](docs/screenshots/11-dark-schedule.png) |

更多截图见 [`docs/screenshots/`](docs/screenshots/)。

---

## 运维

```bash
sqlite3 backend/db/data.db ".backup 'backup-$(date +%F).db'"   # 备份（Web 端也可一键下载）
git pull && bash deploy.sh                                     # 升级（不动数据）
tail -50 backend.log && curl localhost:3001/api/health         # 日志 / 健康检查
```

7×24 运行建议 pm2 守护：`npm i -g pm2 && cd backend && pm2 start server.js --name starclass && pm2 save`。
公网部署（域名 / HTTPS）完整步骤见 [`部署上线说明.md`](部署上线说明.md)。

---

## 常见问题

| 问题 | 答案 |
|---|---|
| Node 版本？ | **>= 18**（推荐 20 / 22） |
| 依赖编译失败？ | macOS `xcode-select --install`；Linux `apt install build-essential python3` |
| 端口被占用？ | `bash stop-all.sh`；或 `export PORT=3002 && bash start-all.sh` |
| 忘记管理员密码？ | `node backend/db/create-admin.js`（切勿用 `npm run seed`，它会清空业务数据） |
| 换机 / 迁移？ | `bash tools/backup.sh` 生成快照，连同 `backend/uploads/` 一起拷走 |
| 不配小程序能用吗？ | 能，Web 后台全功能可用；小程序为付费扩展 |

完整排障见 [`docs/常见问题FAQ.md`](docs/常见问题FAQ.md)，各角色操作见 [`使用手册.md`](使用手册.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`使用手册.md`](使用手册.md) | 各角色日常操作（招生 → 排课 → 考勤 → 续费） |
| [`docs/常见问题FAQ.md`](docs/常见问题FAQ.md) | 安装 / 使用 / 迁移 / 排障 |
| [`部署上线说明.md`](部署上线说明.md) | 公网部署、HTTPS、数据备份 |
| [`deploy/README.md`](deploy/README.md) | Docker 一键部署 |
| [`TEST-GUIDE.md`](TEST-GUIDE.md) | 回归门禁 |
| [`DESIGN.md`](DESIGN.md) | 设计系统规范（色彩 / 字体 / 组件） |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) · [`CHANGELOG.md`](CHANGELOG.md) | 贡献 / 安全 / 版本记录 |

---

## 安全

- JWT 鉴权 + 角色门控，家长 / 教练 / 管理员数据严格隔离
- 密码 bcrypt 存储；资金操作（订单 / 积分 / 退款 / 审批）全部事务化
- `JWT_SECRET` 未配置时自动生成随机密钥并持久化，绝无硬编码默认值
- 登录限流 100 次 / 15 分钟，全局限流 600 次 / 分钟（仅计 `/api/*`）
- 每日自动备份，Web 端支持一键下载

---

## 打赏

如果这个项目帮到了你，欢迎请作者喝杯咖啡。

<p align="center">
  <img src="docs/donate-wechat.png" alt="微信打赏" width="200">&nbsp;&nbsp;
  <img src="docs/donate-alipay.jpg" alt="支付宝打赏" width="200">
</p>

海外可用 [GitHub Sponsors](https://github.com/sponsors/Hoodas101)。点个 Star 或提 Issue，帮助同样大。

---

## English

**StarClass** is a self-hosted management system for small training & fitness studios — enrollment, scheduling, attendance, parent communication, renewals, points and payroll in one app. A Vue 3 admin console over an Express API, with all data in a single SQLite file. No cloud, no subscription, your data stays yours.

```bash
git clone https://github.com/Hoodas101/starclass.git && cd starclass
SEED_DEMO_DATA=1 bash deploy.sh   # deps + demo data + build + start
```

Open <http://localhost:3001> — demo admin `13800000001` / `123456`.
Without `SEED_DEMO_DATA=1` the script creates one admin with a **random password printed once**.
Public server: `./deploy/deploy.sh --host app.yourdomain.com` (Docker, auto HTTPS).
The admin UI and docs are in Chinese.

---

## License

MIT
