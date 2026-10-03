# 更新日志（Changelog）

本项目所有值得注意的变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.2] - 2026-10-03

### 问题与修复
- **积分永不过期**：`point_logs.expire_at` 此前从未使用，用户积分无限累积。新增迁移 030 与 `utils/points-expiry.js`，发放/消费/购卡积分写入 24 个月过期时间，`server.js` 日调度自动回收。
- **时区口径不确定**：业务日期依赖服务器本地时区，换环境即漂移。启动固定 `TZ=Asia/Shanghai`，新增 `utils/timezone.js` 统一业务日期。
- **归档学员积分仍可动用**：学员归档后积分子账户未冻结。新增迁移 029（`points.frozen`），归档/反归档联动冻结与解冻。
- **导出无频率限制**：`GET /settings/export` 开销高、并发可拖垮服务。新增进程内互斥锁 + 30s 自动过期，并发返回 429。
- **教师改号+改角色赋权失效**：同时改手机号与角色时旧 Token 仍带旧角色最长 7 天。改为同事务赋权并立即吊销旧 Token（`token_version` 链），新增 `teacher-phone-role-regression.cjs` 固化。
- **审计报告遗留问题**：六份第三方审计指出的 P0×3 / P1×59 / P2·P3 业务资金类问题，本轮全量核查并修复。

### 优化
- 回归套件 32 → 33（新增 E10），全量 362 内部用例 0 失败。
- 后端 / 前端版本号统一至 1.0.2。
- 补充部署说明与历史审计、经验文档（`docker/`、`docs/`）。

## [1.0.0] - 2026-09-11

首个公开发布版本（合并自 edu-admin-system 的能力与 edu-admin 完整三端）。

### 新增

- 管理后台深色模式：跟随系统 / 浅色 / 深色三档切换（顶栏按钮），
  偏好持久化到 localStorage，首屏无闪白；ECharts 与课程标识色随主题重绘
- `tools/dark-mode-audit.mjs`：像素级深浅色双模式审计（--theme dark|light）
- Docker 一键部署：单镜像（API + 管理后台）、compose 编排、
  Caddy 自动 HTTPS 边车、`deploy/deploy.sh` 与 GitHub Actions Deploy 工作流
- CI（GitHub Actions）：后端 4 个专项套件 × Node 18/20/22（256 项全量回归
  为本地门禁 `npm run test:backend`）、
  管理端构建、镜像构建冒烟、敏感信息与运行数据门禁
- 社区文档：贡献指南、安全策略、行为准则
- 微信小程序三端（家长 / 教练 / 管理员，41 页原生实现）
- Express + SQLite 后端：JWT 鉴权、按 IP 限流、CORS 来源控制、审计日志
- 业务模块：成员、课程、排期、班级、签到、会员卡、积分、订单与微信支付、
  财务与薪资、线索/跟进、成长记录、意见反馈、请假与补课
- 定时任务：续费/余额/开课提醒、自动缺席标记、数据库自动备份、异步任务队列
- Vue 3 + Element Plus 管理后台：数据看板、排课看板、签到、会员与财务、
  系统设置
- 一键部署 `deploy.sh`（免 Docker 原生路径）+ 全中文文档
  （README / 使用手册 / 部署上线说明 / 常见问题 FAQ / TEST-GUIDE）
- 可定制机构称呼（老师/学员/会员全站替换），全部业务规则可配置
- JWT 安全：未配置 `JWT_SECRET` 时首次启动自动生成强随机密钥并持久化
  （`backend/db/.jwt-secret`，随数据库备份），绝不使用硬编码默认值；
  每日自动备份 + Web 一键导出

## [1.0.1] - 2026-09-15

Stability, correctness and security fixes from a full-codebase review.

### Security

- Add a `token_version` revocation chain to JWT: disabling / password change / role change / staff deletion now invalidates old tokens immediately. Every user signs in once after upgrade (expected cost of this hardening)
- Treat a missing `users` row (rotated openid / deleted account) as revoked instead of letting an ownerless token through for up to 7 days
- Gate parent phone password-free login behind `PARENT_PHONE_LOGIN` (off by default in production); WeChat one-tap login is unaffected
- `deploy.sh` starts the backend with `NODE_ENV=production`, so the "off in production" default actually applies; fix the `JWT_SECRET` hint to match real behavior (auto-generate a random key and persist it)
- Close the check-in arbitrage path: parent QR sign-in now verifies enrollment, deducts classes from count cards, and enforces a time window
- Fix authorization gaps: schedule PUT ownership check, trim other students' rosters, gate `/charts` by permission, verify WeChat Pay order ownership, drop `INSERT OR REPLACE` payment overwrite
- Harden the login redirect against cross-origin forms (`/\evil.com`)

### Fixed

- Finance reporting: summary / monthly / by-product / by-sales now count `status IN ('paid','refunded')` and exclude `order_type='refund'` rows — fully-refunded orders no longer vanish from revenue, and net revenue is no longer double-subtracted into negative
- Card refund amount is prorated by the order's paid/original ratio and capped at the order's remaining refundable amount; refund lookup uses `unitPrice`
- Partial refunds now reclaim the card's unused entitlement (count cards zero `remaining_classes`, time cards clear remaining validity), preventing "refund the cash and keep the classes"; negotiated custom amounts and percent-fee modes are treated as a voluntary discount and left untouched
- Payroll: add `POST /api/payroll/settle` writing `payroll_logs` so net profit stops treating coach pay as zero; `/coaches` and `/settle` exclude future-dated scheduled classes in a mid-month run
- Audit trail for money writes: order refund, paid-order cancel, payroll settle and void each record an `audit_log` row (amount, rule applied, entitlement reclaimed, actor)
- Deleting a course rolls back the net of its `earn` and `checkin` point logs instead of only `earn`
- Wrap order cancel, price edits, points/deduct/class-assign and other read-modify-write paths in transactions
- Backup directory follows `DB_PATH`; `/api/health` runs a real `SELECT 1` probe; WeChat Pay fails honestly when unconfigured; `allow_self_booking` is enforced
- Seed guard: `seed.js` requires `--force` on a non-empty DB, `deploy/deploy.sh` skips when data exists, and the Deploy workflow defaults `seed_demo_data` to false — reruns no longer wipe production data; `remote-deploy.sh` preserves `.env`
- Admin console: fix the missing `Close` icon on the check-in page and the `on-exceed` handler that referenced `ElMessage` from the template (undefined at runtime under on-demand imports); the salary page's "settled this month" flag now queries the specific month instead of the capped 200-row window
- Login / 401 edge cases: `/login?redirect=/login` no longer dead-ends; concurrent 401s prompt and redirect only once

### Changed

- Element Plus switched to on-demand import: element-plus chunk 1060→584 kB, CSS 352→221 kB; xlsx loaded dynamically
- Menu filtering and route guards share one `hasPageAccess` check; add a 404 catch-all; 401 carries a `redirect` back to the original page; logout clears all identity caches
- CI runs 7 isolated regression suites plus the full 256-check suite; add a single `npm test` entry point at the repo root; add `tests/finance-payroll-regression.cjs`
- `.env.example` documents `PARENT_PHONE_LOGIN` and `STAFF_DEFAULT_PASSWORD`

<!--

### 变更 Changed
### 废弃 Deprecated
### 移除 Removed
### 修复 Fixed
### 安全 Security

-->
