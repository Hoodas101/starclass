# edu-admin 教培工作台 · 系统架构设计 + 任务分解

> 架构师：高见远（Gao）｜面向对象：主理人（team-lead）+ 工程师
> 工程路径：`/Users/huanghoodas/edu-admin/`（web-admin 前端 / backend 后端；小程序端独立私有仓库，本期不纳入）
> 设计依据：基于**真实代码库实测**（非凭空设想）。关键结论先行——**本系统已实现度极高（36 页 / 23 个后端路由模块 / 36 套回归套件），本期 P0 绝大多数是「一致性收敛 + 回归锁定」，而非从零实现。**

---

## 1. 实现方案 + 框架选型（含本期边界）

### 1.1 技术栈确认（沿用，无需引入新框架）

| 层 | 选型 | 实测证据 | 结论 |
|---|---|---|---|
| 前端 | Vue3 + Vite5 + Element Plus(真·按需) + Pinia + SCSS | `web-admin/package.json`、`vite.config.js`（自研 `ElementPlusOndemandResolver`，按组件独立入口注入样式，已规避 barrel tree-shaking 失败） | 合适，沿用 |
| 后端 | Node + Express4 + better-sqlite3（单 SQLite 文件 `db/data.db`） | `backend/package.json`、`backend/server.js`、`backend/db/index.js` | 合适，沿用 |
| 鉴权 | JWT（`.jwt-secret`）+ bcryptjs + 角色门控 + 功能权限键 | `backend/middleware/authz.js`、`src/utils/access.js`、`src/composables/usePerm.js` | 合适，沿用 |
| 图表 | ECharts5（独立分包）+ `utils/theme-colors.js` 主题感知取色 | `web-admin/src/utils/theme-colors.js`、`vite.config.js` manualChunks | 合适，沿用 |
| 出数 | SheetJS(xlsx) + `utils/xlsx.js` 多表保护 | `web-admin/src/utils/xlsx.js` | 合适，沿用 |
| 测试 | Playwright + pixelmatch + pngjs（视觉像素闸门）；Node 进程级回归套件 | `web-admin/package.json` devDeps、`backend/tests/run-all.cjs`（36 套件） | 合适，沿用 |

**为何合适**：单店轻运营（500㎡、三角色）无需微服务/ORM/容器编排；SQLite 单文件 + 每日备份（`utils/backup.js`）+ `audit_logs` 已满足审计与容灾；前端 monorepo 单一 SPA + 路由守卫 + Pinia 已能支撑三角色隔离。

### 1.2 本期边界（默认，详见第 8 节确认建议）

- **仅 Web 端**（web-admin），小程序源码不在本仓库、不纳入本期；后端接口已通过 `x-openid` 头与 `parent` 角色天然解耦，本期不改小程序契约。
- **不引入**：多校区/连锁、排班打卡、薪酬个税、在线微信收款（wxpay.js 仅预留，需商户号）。
- **不改数据库引擎/目录结构**：后端模块在 `backend/routes|utils|db|middleware`，**无 `src/` 目录**（PRD 描述与实际不符，已实测修正）。

---

## 2. 文件清单（相对路径，标注 新增/修改/沿用）

> 基准根：`web-admin/`（前端）、`backend/`（后端）。仅列本期涉及文件。

### 2.1 前端（web-admin/）

**设计令牌 / 布局（沿用 + 微调）**
- `src/styles/index.scss`【沿用】—— `--t-*` 令牌唯一源；`html[data-theme='dark']` 双主题第一公民；`.el-overlay` 遮罩走 `--t-scrim`；`.page-header` / `.hub-tabs` 全局样式。
- `src/styles/variables.scss`【沿用】—— `--t-fs-* / --t-spacing-* / --t-radius-* / --t-text-* / --t-accent` 等变量定义（被 vite `additionalData` 全局注入）。
- `src/layouts/MainLayout.vue`【沿用】——侧栏(160px)+内容区(padding 24px 32px)，菜单过滤用 `usePageAccess()`（与路由守卫同源判定）。
- `src/constants/terms.js`【修改】——全站称呼（学员/家长/教练/课程等）替换扩展（P2-LOCALE）。

**页头 / Tab 范式（沿用，收敛）**
- `src/components/PageHeader.vue`【沿用】——唯一页头组件，props 仅 `title:String`；标题 `var(--t-fs-2xl)/600/--t-text-1/line-height --t-leading-snug`；右侧 `actions` slot；`margin-bottom: var(--t-spacing-lg)`。
- `src/views/hubs/*.vue`（OperationsHub/SalesHub/StudentsHub/ParentsHub/StaffHub）【沿用】——5 个 hub 范本：`PageHeader + 单条 el-tabs(.hub-tabs) + visibleTabs 过滤(角色&&权限)`。
- `src/views/**/*.vue`（25 个已用 PageHeader）【沿用】；`views/makeup/index.vue`【沿用，embedded 子视图无页头，合法例外】。

**权限（沿用，回归验证）**
- `src/router/index.js`【沿用】——`hasPageAccess` AND 语义、无权限回跳 `resolveFallback`、JWT `exp` 有限正数校验。
- `src/utils/access.js`【沿用】——`hasPageAccess` / `usePageAccess` / `permsFromStorage`，与 `usePerm` 同源 `DEFAULT_PERMS`。
- `src/composables/usePerm.js`【沿用】—— `has()` 判定；`DEFAULT_PERMS = {coach:[students,schedule,checkin,leave,coachstats], sales:[dashboard,sales,students,growth]}`。
- `src/store/user.js`、`src/store/settings.js`【沿用】。

**API / 工具（修改 = 新增本期接口）**
- `src/api/modules/index.js`【修改】——现有 156 个导出；新增 `getActivityTypePresets / saveActivityTypePreset`、`getGrowthCurve`、`transferCard / activateCardEarly / batchMakeup / upsertRecurringRule`、`getDashboardKpi / getWarningThresholds / saveWarningThresholds`、`getCoachSalesView`、`exportWithConfirm` 等。
- `src/api/request.js`【沿用】——`{code,data,message}` 契约、Bearer、401/403/429/404/500 统一拦截。
- `src/utils/theme-colors.js`【沿用】——`chartPalette() / courseTextColor() / isDarkTheme()`，ECharts 取令牌。
- `src/components/ExportDialog.vue`、`ColumnSettingsDialog.vue`、`ImportCsvDialog.vue`【修改/沿用】——导出二次确认 + 字段设置持久化（P1-EXPORT）。

**测试 / CI（修改 = 扩闸门）**
- `web-admin/tests/visual-sweep.mjs`【修改】——baseline 扩至 36 页；CI 像素闸门。
- `web-admin/tests/static-checks.test.mjs`【修改】——新增「无游离页头」「无硬编码 hex（写死色值）」「ECharts 经 theme-colors 取色」三条守卫（P0-UI-1/3）。
- `tools/dark-mode-audit.mjs`【沿用/扩展】——双主题回归（P2-DARK 常态化）。

### 2.2 后端（backend/）

**路由模块（修改/新增）**
- `routes/classes.js`（课程/活动类型）【修改】——预置篮球/体适能/跳绳类型 + 默认课时/场地/年龄段（P1-ACT）。
- `routes/schedules.js`（排课/公开报名/冲突）【沿用】——`POST /schedules/:id/enroll` 已存在。
- `routes/attendances.js` / `routes/checkin.js`【沿用】——签到 + UPSERT 幂等。
- `routes/membership.js`（会员卡生命周期）【修改】——转让/提前激活/批量补课/周期排课规则 编辑删除（P1-CARD）；`utils/card-lifecycle.js`、`card-rules.js` 配套。
- `routes/students.js` / `physical-tests.js`【修改】——体测模板 + 成长曲线（P1-FIT）。
- `routes/settings.js`【修改】——预警阈值配置页持久化（P1-DASH）；字段设置持久化已存在。
- `routes/feedback.js` / `routes/messages.js`【修改（条件）】——若开放教练家校，改造 `isAdminReq` →「管理员或该学员教练」（P1-PARENT-COACH，默认 OFF）。
- `routes/orders.js` / `points.js` / `finance.js` / `payroll.js` / `auth.js` / `admin.js` / `trial.js` / `followups.js` / `growth.js` / `leave.js` / `makeup.js`【沿用】。
- `routes/wxpay.js`【沿用，预留】——本期不启用在线收款。

**中间件 / 工具（沿用 + 微调）**
- `middleware/authz.js`【沿用】——`requireStaffPerm(req,res,perm,label)`，AND 语义后端强制（P0-AUTH 锁定）。
- `utils/index.js`（resolvePerms / DEFAULT_PERMS / safeFail / getReqUser）【沿用】。
- `utils/renewal.js` / `reminders.js`【沿用】——续费提醒（server.js 每日调度）。
- `utils/card-lifecycle.js` / `card-rules.js` / `deduction.js`【修改】——事务一致（P1-CARD）。
- `db/seed.js`【修改】——冠以「恩平莱德队长」品牌的三类活动 + 学员 + 周课表（P0-LOOP / 待确认 #5）。
- `db/init.js` / `migrations/*`【沿用】。

**测试（修改 + 新增）**
- `smoke-test.mjs`（根）【修改】——增 P0-LOOP 端到端断言（排课→报名→签到→激活→续费提醒全绿）。
- `tests/run-all.cjs`【修改】——纳入新增 P0-LOOP 回归套件。
- `tests/*-regression.cjs`【新增】——P0-LOOP 闭环、P1-CARD 事务、P1-DASH 口径各一套进程级回归。

---

## 3. 数据结构与接口（类图 + 核心 API 契约）

完整 ER / 类图见 `docs/class-diagram.mermaid`（已写入）。核心实体与关系摘要：
- **Course = 活动类型**（篮球/体适能/跳绳已 seed）；`ActivityTypePreset` 存默认课时/场地/年龄段（P1-ACT 新增）。
- **Schedule 1—* Enrollment（公开报名）/ 1—* Attendance（签到，unique[schedule,student] 保证幂等）**。
- **MembershipCard 1—* CardInstance（按学员激活，remaining_classes 递减）**；订单经 `idempotency_key` 幂等发卡。
- **Student—* PhysicalTest—* TestMetricPreset（体测模板 + 成长曲线）**。

### 关键 API 端点契约（沿用 `/api/{resource}/{action}`，返回 `{code:0,data,message}`）

| 能力 | Method & Path | 说明 | 权限键 |
|---|---|---|---|
| 排课（公开） | `POST /api/schedules` | body 含 `is_public:true, recurrence` | schedule |
| 公开报名 | `POST /api/schedules/:id/enroll` | 家长/学员报名，enrolled_count++ | （家长/学员数据级） |
| 签到 | `POST /api/attendances/checkin` | UPSERT，status=present | checkin |
| 23:30 缺席 | 定时 `runAutoAbsentDaily()` | UPDATE 已结束未签到→absent（幂等） | 系统 |
| 会员卡激活 | `POST /api/orders` | 幂等 key 发卡 + 建 CardInstance | membership |
| 续费提醒 | 定时 `scheduleReminder('renewal_reminder')` | 扫临期卡推送 | 系统 |
| 活动类型预设 | `GET/POST /api/classes/presets` | 三类活动模板 | courses |
| 体测曲线 | `GET /api/students/:id/growth` | 返回趋势序列 | students |
| 看板 KPI | `GET /api/dashboard/kpi` | 莱德经营口径 | dashboard |
| 预警阈值 | `GET/POST /api/settings/warning-thresholds` | 可配 | settings |
| 教练销售视图 | `GET /api/sales/coach-view` | 仅本人相关（条件启用） | sales/growth |
| 家校消息(教练) | `GET /api/messages?studentId=` | isAdminReq 改造后开放（条件） | parents |

---

## 4. 程序调用流程（时序图，P0-LOOP 核心闭环）

完整 Mermaid 时序图见 `docs/sequence-diagram.mermaid`（已写入）。摘要：
1. **排课**：管理员 `addSchedule` → `POST /api/schedules`（冲突检测）→ 公开可报名。
2. **公开报名**：家长 `enroll(scheduleId)` → `POST /schedules/:id/enroll` → `enrollments(present)/enrolled_count++`。
3. **签到 + 自动缺席**：管理员 `checkinTeacher` → `POST /attendances/checkin`（UPSERT）；23:30 定时 `runAutoAbsentDaily()` 把「已结束且未签到」标 absent（unique 索引兜底幂等）。
4. **会员卡激活**：支付/后台发卡 → `POST /api/orders`（幂等 key）→ `INSERT card_instances(activated_at, remaining=total)`。
5. **续费提醒**：`scheduleReminder('renewal_reminder')` 每日扫临期卡 → 推送。

---

## 5. 任务分解清单（有序 + 依赖，按实现顺序）

> **关于任务粒度**：基础架构模板默认「≤5 任务」，但本任务为高度成熟系统的**规划落地**，主理人明确要求 P0/P1/P2 有序分解 + 三类工作流节点，故按**阶段分组的有序任务**（共 13 项）交付，更贴合工程实际。每项标注：`编号 / 名称 / 涉及文件 / 前置依赖 / 验收标准 / 估时点(S/M/L) / 工作流节点`。

### 阶段 A：纯前端一致性收敛（P0-UI）
- **T01 · P0-UI-1 页头统一收敛**
  - 涉及：`src/components/PageHeader.vue`(沿用)、`src/views/**`(沿用)、`web-admin/tests/static-checks.test.mjs`(修改)
  - 依赖：无
  - 验收：`grep` 全仓无游离 `<h1>/<h2>` 页头；25 业务页 + 5 hub 统一页头；标题 `--t-fs-2xl/600/--t-text-1`；3 个豁免页（login 公开 / NoAccess 兜底 / makeup embedded）注释说明合法。
  - 估时：**S**｜节点：纯前端一致性收敛
- **T02 · P0-UI-2 页级 tab 栏一致性**
  - 涉及：`src/views/hubs/*.vue`(沿用)、`src/styles/index.scss`(沿用，`.hub-tabs` margin-bottom `--t-spacing-lg`)
  - 依赖：T01
  - 验收：每页至多一条页级 tab，固定于 PageHeader 下方、margin-bottom=24px；无双 tab 栏+双横线；记录详情内联 tab 合法；5 hub `visibleTabs` 均 `roles.includes && has(perm)`。
  - 估时：**S**｜节点：纯前端一致性收敛
- **T03 · P0-UI-3 令牌/圆角一致性 + CI 像素闸门**
  - 涉及：`src/styles/index.scss`(沿用)、`src/utils/theme-colors.js`(沿用)、`web-admin/tests/visual-sweep.mjs`(修改，扩至 36 页)、`static-checks.test.mjs`(修改，新增「无硬编码 hex」「ECharts 经 theme-colors 取色」)
  - 依赖：T01,T02
  - 验收：`static-checks` 三项守卫 PASS；`visual-sweep` 36 页 baseline 无 diff；`dark-mode-audit` 双主题无异常；圆角全走 `--t-radius-*`。
  - 估时：**M**｜节点：纯前端一致性收敛 + 测试

### 阶段 B：权限双控回归（P0-AUTH）
- **T04 · P0-AUTH 三角色权限双控回归**
  - 涉及：`src/router/index.js`、`src/utils/access.js`、`src/composables/usePerm.js`、`middleware/authz.js`、`backend/tests/permission-keys-regression.cjs`(沿用)、新增 `tests/authz-3role-regression.cjs`
  - 依赖：无（可与 A 并行）
  - 验收：路由守卫(角色)+功能权限(perm) **AND** 语义；教练默认仅课务页（schedule/checkin/leave/coachstats）；家校 admin 专属；家长 URL 直达后台被 403/重定向；`live-smoke-3role.mjs` 全绿。
  - 估时：**M**｜节点：测试（回归锁定）

### 阶段 C：核心闭环（P0-LOOP）
- **T05 · P0-LOOP 莱德数据闭环跑通**
  - 涉及：`db/seed.js`(修改，莱德品牌三类活动+学员+周课表)、`smoke-test.mjs`(修改，增闭环断言)、新增 `tests/p0-loop-regression.cjs`、`server.js`(沿用，23:30 缺席/续费提醒)
  - 依赖：T04（权限基线稳定）
  - 验收：seed 含篮球/体适能/跳绳三类活动；端到端 排课→公开报名→签到(23:30 自动缺席)→会员卡激活→续费提醒 跑通；`smoke-test.mjs` 全绿；新回归套件纳入 `run-all.cjs`。
  - 估时：**M**｜节点：前后端联调 + 测试

### 阶段 D：轻运营适配（P1）
- **T06 · P1-ACT 活动/课程类型模板**
  - 涉及：`routes/classes.js`(修改)、`db/seed.js`(修改)、`src/api/modules/index.js`(修改)、本仓库新增前端 `views/classes/*` 或复用现有课程管理页
  - 依赖：T05
  - 验收：三类活动在 admin/courses 预置类型 + 默认课时/场地/年龄段；新增课程默认带预设。
  - 估时：**S**｜节点：前后端联调
- **T07 · P1-FIT 体测模板与成长曲线**
  - 涉及：`routes/physical-tests.js`(修改)、`routes/students.js`(修改)、`src/api/modules/index.js`(修改)、档案页 + 看板趋势组件
  - 依赖：T05
  - 验收：复用 physical-tests 预设指标；学员档案 + 看板出趋势曲线（ECharts 经 theme-colors 取色）。
  - 估时：**M**｜节点：前后端联调
- **T08 · P1-CARD 会员卡前端入口补全 + 事务一致**
  - 涉及：`routes/membership.js`(修改)、`utils/card-lifecycle.js`/`card-rules.js`/`deduction.js`(修改)、`src/api/modules/index.js`(修改)、会员卡管理视图
  - 依赖：T05
  - 验收：转让/提前激活/批量补课/周期排课规则 编辑删除 前端补齐；所有写操作在事务内一致（回滚可测）；新增 `tests/card-txn-regression.cjs`。
  - 估时：**L**｜节点：前后端联调 + 测试
- **T09 · P1-DASH 看板 KPI 口径对齐 + 预警阈值**
  - 涉及：`routes/settings.js`(修改，预警阈值持久化)、看板视图、`src/api/modules/index.js`(修改)
  - 依赖：T07
  - 验收：KPI 口径对齐莱德经营指标；预警阈值设置页可配并持久化。
  - 估时：**M**｜节点：前后端联调
- **T10 · P1-COACH-SALE + P1-PARENT-COACH 边界（条件）**
  - 涉及：`src/router/index.js`(沿用，/sales 已含 coach 角色)、`routes/feedback.js`/`messages.js`(条件修改 isAdminReq)、`src/api/modules/index.js`(修改 getCoachSalesView)
  - 依赖：T04
  - 验收：**默认 OFF**。若产品确认（待确认 #3/#4）：教练招生仅见本人相关页签（授权 sales/growth 键即可，无新代码）；家校对教练开放需 isAdminReq 改造为「管理员或该学员教练」+ 页签 roles 放开。
  - 估时：**M**（若启用）｜节点：前后端联调
- **T11 · P1-EXPORT 导出/字段配置扩展**
  - 涉及：`src/components/ExportDialog.vue`(修改，二次确认弹窗)、`ColumnSettingsDialog.vue`(沿用，@save 已接)、`src/store/settings.js`(沿用，字段设置持久化)
  - 依赖：T01
  - 验收：新模块导出走二次确认弹窗；字段设置持久化（static-checks 已守卫 @save 接线）。
  - 估时：**S**｜节点：纯前端一致性收敛

### 阶段 E：增强（P2）
- **T12 · P2 增强项**
  - 涉及：`tools/dark-mode-audit.mjs`(扩展常态化)、`routes/wxpay.js`(条件接入商户号)、`src/constants/terms.js`(全站称呼扩展)、规则可配面板、多端同步测试
  - 依赖：T03,T09
  - 验收：P2-DARK 像素回归常态化；P2-WX（如启用）微信支付/订阅消息；P2-LOCALE 全站称呼替换扩展；P2-INTEG 规则可配面板化。
  - 估时：**L**｜节点：前后端联调 + 测试

### 依赖关系（简化）
```
T01 ──► T02 ──► T03
T04（并行）          
T04 ──► T05 ──► T06 / T07 / T08 / T09
T04 ──► T10（条件）        T01 ──► T11
T03,T09 ──► T12
```
**工作流节点归类**：纯前端一致性收敛 = {T01,T02,T03,T11}；前后端联调 = {T06,T07,T08,T09,T10,T12}；测试 = {T03,T04,T05,T08,T12}。

---

## 6. 依赖包列表

**前端（web-admin）**：无需新增包。`playwright / pixelmatch / pngjs / sass / @vitejs/plugin-vue / unplugin-auto-import / unplugin-vue-components / vite` 已在 devDependencies，覆盖视觉像素闸门与按需引入。
**后端（backend）**：无需新增包。`express / better-sqlite3 / jsonwebtoken / bcryptjs / cors / body-parser` 已覆盖全部 P0/P1。**不引入**微信支付 SDK（P2-WX 待商户号就绪再评估 `wechatpay-node-v3` 等）。

> 结论：**本期零新增 npm 依赖**，完全复用现有成熟栈。

---

## 7. 共享知识（跨文件约定，工程师必读）

1. **设计令牌来源单一**：所有颜色/字号/间距/圆角走 `src/styles/variables.scss` + `index.scss` 的 `--t-*`；ECharts 经 `src/utils/theme-colors.js` 取 `cssVar('--t-*')`；禁止写死 hex（static-checks 守卫「无硬编码 hex」）。深色模式 `html[data-theme='dark']` 第一公民。
2. **PageHeader 契约**：唯一组件 `src/components/PageHeader.vue`，props 仅 `title:String`；标题 `--t-fs-2xl(22px)/600/--t-text-1/line-height --t-leading-snug`；右侧 `actions` slot；`margin-bottom: var(--t-spacing-lg)`。禁止手搓 `<h1>/<h2>` 页头。
3. **Tab 契约**：页级 tab 仅一条，紧接 PageHeader 下方 `.hub-tabs` 的 `:deep(.el-tabs__header){margin-bottom:var(--t-spacing-lg)(24px)}`；sub-view 用 `embedded` 复用 hub 且隐藏自身页头；禁止双 tab 栏+双横线；记录详情内联 tab 合法例外。
4. **统一组件**：`<StatusDot>` / `<EntityAvatar>` / `<ListErrorState>` 为状态/头像/空错的全局唯一实现。
5. **权限双控约定**：前端 `hasPageAccess(role,perms,meta)` 与 `usePerm().has()` **AND 语义**（角色命中 且 权限键命中）；后端 `requireStaffPerm` 同源强制；`DEFAULT_PERMS` 在 `access.js`/`usePerm.js`/`utils/index.js` **三处必须同步**；admin 恒通过；显式 `[]` = 零权限（不回退角色默认）。
6. **深色模式约束**：任何新增组件须双主题自测（亮/暗均无对比度/溢出异常）；遮罩走 `--t-scrim`；焦点环唯一 `var(--focus-ring)`。
7. **测试约定（三类闸门）**：
   - 视觉像素闸门：`web-admin/tests/visual-sweep.mjs`（baseline 36 页，`--update` 重采）；
   - 双主题回归：`tools/dark-mode-audit.mjs`；
   - 回归套件：`backend/tests/run-all.cjs`（进程级 36 套件）+ `smoke-test.mjs`（端到端）+ `live-smoke-3role.mjs`（三角色）；
   - 静态守卫：`web-admin/tests/static-checks.test.mjs`（游离页头/令牌唯一/焦点环/@save 接线等）。
8. **API 契约**：统一 `/api/{resource}/{action}`，返回 `{code:0,data,message}`；Bearer 鉴权；401 清缓存跳登录、4031 强制定向改密、429 限流提示。

---

## 8. 待明确事项 + 架构建议（6 个待确认问题，给出默认推荐）

| # | 问题 | 架构建议（默认推荐） | 是否阻塞主线 |
|---|---|---|---|
| 1 | 小程序是否纳入本期 | **否，仅 Web 端**。后端已通过 `x-openid` 头 + `parent` 角色解耦，本期不改小程序契约，零影响。 | 否 |
| 2 | 是否需要微信支付在线收款 | **暂不上线**。wxpay.js 已预留，但需商户号 + 合规；保留离线/现金收款路径，P2-WX 再接（不新增 SDK）。 | 否 |
| 3 | 家校沟通是否对教练开放 | **默认不开放**（当前 admin 专属，反馈/消息 `isAdminReq` 硬校验）。若开放：P1-PARENT-COACH 改造 isAdminReq→「管理员或该学员教练」+ 页签 roles 放开（**T10 条件任务**）。 | 否（产品决策后才启用 T10） |
| 4 | 教练是否承担招生 | **默认不承担**（教练默认权限无 sales/growth）。若承担：仅「半接线」——团队管理勾选 sales/growth 键即见本人页签，无需新代码（T10 同源）。 | 否 |
| 5 | 数据初始化用真实机构还是 demo | **demo 数据但冠「恩平莱德队长」品牌命名**（seed 已含篮球/体适能/跳绳三类 + 学员 + 周课表）；不写真实手机号/姓名等隐私字段。 | 否 |
| 6 | 轻运营边界 | **不引入**多校区/连锁/排班打卡/薪酬个税。本期聚焦单店闭环，保持单 SQLite + 每日备份现状。 | 否 |

**结论**：6 项均不阻塞本期主线。唯一会**改变任务排期/增量范围**的是 #3、#4——若产品确认「开放教练家校 / 教练招生」，则激活 T10 条件任务（中等工作量，已预留架构空间，无需前期返工）。建议主理人在 P0 收口（T01–T05）后、进入 P1 前就 #3/#4 拍板。

---

### 附：设计产物文件
- `docs/system-design.md`（本文件）
- `docs/class-diagram.mermaid`（核心实体 ER/类图）
- `docs/sequence-diagram.mermaid`（P0-LOOP 核心闭环时序图）
