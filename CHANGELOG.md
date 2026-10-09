# 更新日志（Changelog）

本项目所有值得注意的变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.6] - 2026-10-09

### 问题与修复（P0 数据正确性）
- **导入整表错位一列**：机构台账常是「第 1 行标题 + 第 2 行列名」，旧逻辑固定把第 1 行当表头 → 一列都匹配不上 → 各列回退「按列序猜」→ **收据单号被写进备注列**。新增表头行探测（前 10 行取命中已知列最多者，阈值 ≥2），CSV 与 XLSX 统一走网格读取，界面提示「已自动识别第 N 行为表头」。
- **金额带货币符号导致整行被拒**：`Number('¥2,699.00')` → NaN，且错误文案不体现原值。新增宽松解析：剥离 `¥￥$`、千分位、尾缀「元」，支持会计负数 `(100.00)`；失败时**回显原值**。
- **购买日期三种格式混用 → 整批时间错乱**：Excel 序列号 / 美式 M/D/YY / ISO 非零填充。旧实现解析失败后**静默回退为当前时间**，销售趋势与按月统计随之全错而界面看不出异常。新增统一日期解析（Excel 序列号基准 **1899-12-30**），失败改为该行入 `failed` 并说明原因。
- **姓名列别名缺失**：销售台账常用「会员」而非「学员姓名」，缺别名会整列错配（姓名值落到「序号」列）。补「会员 / 会员名 / 客户姓名」等别名。
- **表格设置被静默覆盖**：`students_columns` 是「一个键 = 一整个对象」的覆盖语义，前端持的是打开页面那一刻的快照，直接写回会抹掉期间其他写入。改为「先重读服务端 → 按键合并 → 写回」。
- **「加入时间」整列显示 `-`**：`join_date` 为 TEXT 列，而写入的是 JS 数字 —— better-sqlite3 按 REAL 绑定，SQLite 的 TEXT 亲和性落成 `'1788059200000.0'`，前端按 epoch 解析失败。写入层改绑字符串（`Math.round` 并不足够）、展示层兼容 `.0`，并新增迁移 034 归一化存量。

### 问题与修复（P1 功能不可用）
- 「加入时间」同列混用两种日期写法 → 统一 `YYYY-MM-DD`，「距今多久」移到悬停提示。
- 未填生日被渲染成「0 岁」（`Number(null) === 0`）→ 先排空再转换。
- 详情抽屉「加入时间」显示 `NaN`；「导出为导入模板」产出 `Invalid Date`（使「导出 → 修正 → 再导入」闭环断裂）→ 均改走统一 `formatDate`。
- 销售表「字段设置」是死功能（弹窗被移除且无入口）→ 恢复入口。

### 优化（多维表格）
- **排序**：任意列可排，三态循环（升 → 降 → 取消），多列优先级（表头显示角标）；**空值恒排末尾**；中文按 `localeCompare('zh-CN', { numeric: true })`。纯前端排序，不加后端 `sortBy`。
- **列宽**：canvas 实测文本像素自适应；计入表头控件占位；自由文本列取典型值定宽 + `show-overflow-tooltip` 兜底；逐列手动微调与一键复位；存在手动列宽时全部列固定宽度，避免相邻列被压缩。
- **视图**：一套「筛选 + 排序 + 字段顺序 + 列宽」的快照，可多套并存切换；两个系统视图不可删。学员档案与销售表同时支持。
- 表头单行化（`inline-flex`，独立内边距）；序号跨页连续；金额统一整数元 + 千分位。

### 测试
- 新增 `backend/tests/v105-fixes-regression.cjs`（20 项）与 `web-admin/tests/table-utils.test.mjs`（48 项，含集成接线断言）。
- 后端全量回归 **37/37 套件、364 项断言通过**。

## [1.0.5] - 2026-10-06

### 问题与修复
- **卡种更新接口零校验**：`PUT /membership/card-type/:id` 此前只有存在性校验，把「有效天数」清空即可写出 `valid_days=0` 的时效卡 → 发卡时到期日 = 激活时刻，「买来即过期」且永不被选卡命中。补参数校验（显式传入必须为正整数）与切换计费模式时的必填补齐。
- **订单批量导入不发卡**：导入写入的明细缺 `itemId`，权益发放整体被跳过——**钱收了、课时没发，接口却返回成功**。改为按项目名反查卡种写入 `itemId`；查不到不再静默成功，记入 `warnings`。
- **学员导入不校验日期**：建档/修改都有日期校验，唯独导入路径缺失 → `2018-02-30` 被 SQLite 归一为 `03-02`（年龄错一天）、`2018/1/5` 令 `date()` 返回 NULL（统计时该学员凭空消失）。导入补同一套校验。
- **删除学员残留孤儿家长账号**：建档/导入凭手机号自动建家长账号，删除学员却不清理（真实库曾积累约 41.5% 无绑定幽灵账号，且会被下一个同手机号学员复用）。删除时先采集 openid 再清理，多孩共用不误删、`wx_` 账号不误删。
- **家长端取卡口径与扣课口径不一致**：首页只看 `status='active'`，会员中心无任何条件，而扣课还要求未过期 → 出现「家长看到有课、教练点不了课」。首页补 `expires_at > now`；会员中心补 `display_status` / `is_expired` / `is_usable` 派生字段。
- **扣课范围隔离只覆盖 1/3 路径**：手工扣课与请假扣课各自写 SQL、不校验课程范围，1v1 私教卡可被团课/临时活动扣减。三条扣课路径收口到同一函数；范围匹配改**双向包含**（修复「1v1私教」vs「1v1私教课」误拒）。
- **品牌 Logo 只做了 1/3**：Logo 能上传能存，但侧边栏与登录页仍是写死的系统图标，配置形同虚设。两处改为读取机构 Logo，并补动态页面标题。
- **导入零容错**：表头必须逐字相同（「学员姓名/手机号」等同义列名全部不识别）、CSV 只认逗号（TSV 整批 0 行）、GBK 文件乱码却照常入库、XLSX 只读第 1 个工作表。补表头别名归一化匹配、Tab 分隔自动判别、GBK 兜底解码、XLSX 多工作表回退与表头诊断。
- **教师下拉混入销售账号**：`teachers` 是员工载体，销售也录在里面，「授课教师」下拉会列出销售。改为按角色过滤。
- **排课参数错误返回笼统 500**：传入无效 `courseId` 落到 catch-all 500「操作失败」，不可诊断且污染监控。改为明确提示「所选课程不存在」。

### 优化
- **course_scope 结构化**（迁移 033）：新增 `scope_course_ids`（course_id 多值），扣课按 id 精确匹配，为空回退文本逻辑（存量卡种零迁移）；卡种表单新增「限定课程」多选。
- **存量脏数据治理**：新增数据体检与一次性安全清理（`utils/data-health.js` + `GET /admin/data-health` + `POST /admin/data-cleanup` + CLI `backend/db/cleanup-dirty-data.js` + 设置页「数据体检」卡片）。只自动处理无歧义的两类（孤儿家长账号删除、非法卡种下架），其余仅报告。
- **桌面入口**：安装完成后自动在桌面生成「星课 StarClass」入口（macOS `.app` / Linux `.desktop` / Windows `.url`），双击即进入——服务未运行时会自动拉起，非技术员工无需敲命令。
- **导出为导入模板**：学员列表支持按导入模板列名导出，打通「导出 → 修正 → 再导入」闭环。
- 学员列表新增「导出为导入模板」；README 补充接口约定说明（业务失败以 `body.code` 为准）。
- 新增 `v104-fixes-regression` 回归套件；后端全量回归 **36/36 套件、364 项断言通过**。

## [1.0.4] - 2026-10-06

### 问题与修复
- **收款渠道被记成微信**：`POST /orders/:id/pay` 硬编码 `channel='wechat'`，现金 / 转账收款在支付流水与审计里都变成微信，渠道统计与对账失真。改为解构并归一化 `channel`，与建单自动结算口径统一。
- **销售越权读系统设置**：`GET /api/settings` 按 `isStaffReq` 分流，销售虽无 UI 入口却能直连接口读到积分 / 退费 / 推送等经营规则。收紧为仅管理员返回全量，非管理员只回公开子集（保留表格列配置，避免教练 / 销售列表页列设置失效）。
- **1v1 私教卡被团课消耗**：选卡兜底逻辑对「临时活动」排期绕过课程范围，1v1 高价卡被静默扣减（直接营收损失）。改为范围不匹配一律拒绝扣课。
- **次卡到店限次静默失效**：限次校验硬过滤 `billing_mode='time'`，次卡配了限次却不生效，经营者误以为已约束。改为对次卡与时效卡一并校验。
- **请假无法在后台登记**：`/leave/apply` 是家长自助接口，员工必然被拒「无绑定关系」，点名标请假又不写台账 → 请假页永远为空、补课无从关联。新增员工代录分支（按成员登记 + 审计留痕），并在请假页补「登记请假」入口。
- **教练「家校沟通」死路**：路由放行教练，但页签与接口均为管理员专属 → 教练进入后是空白页 + 403。先收紧路由为管理员专属止血。
- **排课参数错误返回笼统 500**：传入无效 courseId 会落到 catch-all 500「操作失败」，不可诊断且污染监控。改为明确提示「所选课程不存在」。
- **限流误伤静态资源**：限流把 CSS / JS 也计入，批量刷新时触发 429 导致整页白屏。改为仅对 `/api/*` 限流，前端并补 429 友好提示。
- **创建接口响应不一致**：`POST /api/orders` 返回 `data.orderId`，与其它接口的 `data.id` 不统一。补 `id`（保留 `orderId` 兼容）。

### 优化
- 请假页新增「登记请假」弹窗，打通「员工代录 → 请假台账 → 补课」闭环。
- 课表窄屏可横向滚动，缓解手机端「误判今天没课」。
- README 与仓库简介精简重写，结构更清晰。

## [1.0.3] - 2026-10-04

### 问题与修复
- **销售可篡改他人订单（横向越权）**：`PUT /orders/:id`、`POST /orders/:id/cancel` 只校验角色、无订单归属校验，销售 A 可改价/取消销售 B 的订单。补归属校验（非管理员仅可操作自己创建或名下的订单），cancel 补审计留痕。
- **教练无法给学员录名**：非管理员一律落入家长报名分支（要求 `parent_bindings`），员工账号 100% 失败。新增员工代录名分支，打通「排课→录名→点名」闭环。
- **建课接受非法时间**：仅校验格式不校验范围，`25:00`/`00:99` 会落库。补时间范围校验（小时 00-23、分钟 00-59），并容忍非补零写法（`8:00`→`08:00`）。
- **导出锁不释放**：释放判据写反，一次导出后 30 秒内所有人都被 429。修正判据，并把抢锁移到参数校验之后（非法请求不占锁）。
- **旧版本备份无法恢复**：`db-restore` 用 `SELECT *` 强依赖列数一致，升级后回滚必然失败。改为按「目标列 ∩ 源列」映射复制。
- **审计日志可被抹痕**：恢复备份 / 导入会整体回滚 `audit_log`。将其移出恢复与导入范围，并为「改系统设置、整库恢复」补审计留痕。
- **签到积分永不过期**：积分过期只覆盖订单 / 手工调整，最大来源「签到」未写 `expire_at`。补写并回填历史流水（迁移 031）。
- **读权限未收口**：销售可读全机构排期、卡种定价、招生线索 PII、员工名单；看板默认展示全机构营收与他人业绩。逐一补权限守卫，看板对非管理员强制 `scope=me`。
- **私教卡被团课消耗**：选卡兜底逻辑绕过课程范围，1v1 私教卡被团课扣减。真实课程范围不匹配时拒绝扣课。
- **财务口径与参数**：新增 `orders.revenue_excluded`（核销 / 赠卡类订单可排除出营收）；财务时间参数统一兼容 `from/to`，非法输入显式报错、不再静默回退本月。
- **收款方式硬编码微信**：现金 / 转账收款被记成微信，月底对账打架。支持收款方式白名单（现金 / 微信 / 支付宝 / 银行 / 其他）。
- **其他**：学员状态枚举白名单、删除学员补清积分流水、列表排序加唯一键兜底、搜索覆盖备注、续费提醒模板改用称呼占位符、自动缺席开机补跑、导出补登 3 张漏表。

### 优化
- 长表单弹窗可滚动（修复小笔记本上「保存」按钮溢出视口、完全点不到的功能级阻断）。
- 全局行高 1.5 与数字等宽；深色对比度、标题层级、表格行高统一、弹窗圆角 / 遮罩、过渡时长、字重收敛。
- 试听转成交对销售可见；建单弹窗补「收款方式 / 成交金额 / 优惠金额」、卡种下拉可搜索；签到页文案随所选日期动态化。
- 新增订单归属回归套件；全量回归 34/34 套件通过。

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
