# 更新日志（Changelog）

本项目所有值得注意的变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] — 2026-10-28 第三轮深度测试修复（时区 / 跨期退款口径 / 导入闸门 / join_date）

来源：`starclass-web端深度测试报告-20261028`（67 条）+ `-第二轮-`（45 条）+
`starclass数据口径一致性审查报告-20261028`。本轮先落地**根因级、高杠杆**的一批，
其余按页面分批跟进（见文末「仍待处理」）。

### 一、时区（P0，影响 6 个查询）

- `server.js` 的 `process.env.TZ='Asia/Shanghai'` 在裸机 Windows 下会让 SQLite 的 `'localtime'`
  解析成 **UTC+1**（与 JS 的 UTC+8 差 7 小时）→ 月报「每月 1 日凌晨收入记进上月/上年 12 月」、
  趋势错桶、漏斗/流失窗口偏移。把全部 11 处 SQL `'localtime'` 改为显式 `'+8 hours'`
  （`finance.js` / `growth.js` / `students.js` / `admin.js`），与宿主时区解耦；`TZ` 仅保留给 JS Date。

### 二、跨期退款口径（P0，统一到 finance）

- `GET /orders/stats`：由「`status='paid'` + `SUM(payable-refunded)` 按 paid_at」改为
  「收入按 paid_at + 退款按退款发生时间（`last_refunded_at`）两段相减」，并补**销售作用域**
  （销售只看本人，此前返回全机构）。与看板/财务/月报同口径，消除「跨月/跨年退款订单页不扣」。
- 看板「本年」净营收：同样改为两段相加并补上界（此前只按 `paid_at >= 年初`，去年支付今年退款整笔消失）。
- 导出销售报表：收入/退款分段后按签单人合并（此前跨月退款在导出里不扣）。
- 收入趋势：拆成「支付日收入」「退款日退款」两张图合并（此前按支付日冲减）。
- 增长漏斗「本月成交额」：补 `revenue_excluded=0`、时间上界、减退款（此前比看板多 1,925）。

### 三、导入与改单闸门（P0）

- `PUT /orders/:id`：`revenue_excluded` 改 `flag01()` 归一（字符串 `"0"` 不再把订单踢出全部营收统计）；
  改价补单笔 1 亿上限。
- `POST /orders/import`：补金额上限、入账时间合理区间（2000-01-01 至今天，允许历史台账、拒绝未来）、
  非管理员业绩强制本人（此前直接采信文件内容，可冒名）。

### 四、数据口径与安全

- `students.join_date`：建档/导入/增长中心三条写入路径统一为 `formatDate()`（`'YYYY-MM-DD'`）；
  新增迁移 **041** 把存量毫秒串一次性转为日期串（此前日期筛选静默漏数）；`v105` 回归断言同步更新。
- `GET /admin/teachers`：非管理员不再返回 `permissions`（他人功能授权清单）；`phone/payRule/classFee` 早已剔除。
- `finance.js`：补导入 `fail`（`/finance/monthly?year=abc` 此前走异常分支 500）。

### 五、前端（P0/P1 小改）

- 员工创建：提交后弹出**一次性临时口令**（此前文案写死 123456、真实随机口令被丢弃，新员工永不可登录）。
- 卡种编辑：`valid_days/total_classes` 用 `??` 而非 `||`（0 不再被回显成 30/8，避免静默改写权益）。
- 看板状态点：`danger/error` 正确映射为红点（此前缺席/请假显示灰点）。
- 课时统计：金额列 `Number(x||0).toLocaleString()`（单条脏数据不再整表崩）。

### 验证

- 后端全量回归：**367 PASS / 0 FAIL / 0 WARN，46/46 套件**；前端 `npm run build` 通过。

### 仍待处理（需单独提交 / 需决策）

- 退款幂等键、时效卡部分退款「不得改写 expires_at/作废」与结转冲销（牵动
  `finance-refund-regression`/`card-classes-invariant`，需配套改测试）。
- 同卡种多订单结转翻倍（需 `member_cards.face_amount` 快照，schema 变更）。
- 前端 localStorage 提权（需启动拉 `/auth/profile` 校正 + 去 `role==='admin'` 全放行）。
- 只读退化（P0）：需写探针 + 登录写入 best-effort + 错误码区分。
- 页面级「越权接口静默兜底为 0/空」、CSP 内联脚本、Google Fonts 本地化等，按页面分批。

## [Unreleased] — 2026-10-27 全站审计 87 项修复落地（v1.0.10）

来源：`starclass全站扫描与自动化测试报告-20261026`（87 条：14 P0 / 37 P1 / 36 P2）+
`starclass优化与修复方案-20261027` + 统一补丁。补丁 40 文件 / +1308 −163，在 `1dfd7b4` 干净树上
`git apply --check` 通过后整体落地；每处改动以根因为准，参数非法统一走「HTTP 200 + `code != 0`」。

### P0（14 条，全部修复）

- **P0-1 周期排课必然 500**：`skipped` 声明从事务回调内提到事务外（此前 `ReferenceError` 而事务已提交，
  用户重试即重复生成整套排期）；并加「规则签名 + 日期区间」幂等闸门。
- **P0-2 部分退款截断时效卡却保留 active**：回收时效卡时同时置 `status='refunded'`（此前次日摊销把整单
  确认成 100%，负债被推成 −¥2650）；`revenue.js` 增加「应确认额 ≤ 净收（实付−已退）」守卫。
- **P0-3 顺延基准选中 2100 年次卡**：`findDeferralBase` 排除 `billing_mode='count'` 与
  `expires_at > now+3650天` 的哨兵卡，基准卡须已生效。
- **P0-4 摊销不扣暂停 + `delta<=0` 不回冲**：`elapsedMs/totalMs` 统一扣除已结算与进行中的暂停段；
  `delta<0` 落负数冲销行（此前 `continue` → 收入永久虚增且不可逆）。
- **P0-5 多卡订单退款按「最新一张卡」定价可超退**：未指定 `cardId` 且订单多卡时，按卡种标价占比拆分、
  逐卡套用因子后求和并夹取到 `[0, remain]`；支持显式 `cardId`。
- **P0-6 退卡不冲销已结转收入**：抽出 `revertRecognitionForCard(cardId, orderId)`，退卡事务内调用，
  与订单退款收敛为同一实现。
- **P0-7 必填字段传对象 → 500**：抽 `isScalarId()` 等校验，ID/数值类型非法统一 `200 + code!=0` 并带字段名。
  补丁外复核发现 `/feedback/apply`（`content.trim()` 遇对象抛错）与 `/makeup/assign`（ID 传对象直达 SQL 绑定）
  两处遗漏，已按同一口径补齐（探针 4/4：对象/数组入参均返回 `200 + code!=0`，不再 500）。
- **P0-8 销售可冒名挂业绩**：非管理员建单**直接忽略 `salesperson` 入参**，强制 `myStaffName(req)`
  （此前 `||` 兜底永不生效）。
- **P0-9 班级通知越权**：新增 `canManageClass()`（非管理员须为本班班主任或授课教练）+ 标题/内容长度校验
  + 同班每分钟 5 次频控 + `recordAudit`。
- **P0-10 布尔字段真值判断**：`flag01()` 归一，字符串 `"0"` 不再被判为真（此前订单从全部营收报表静默消失）。
- **P0-11 新建员工不下发临时口令**：POST 复用 PUT 的 `tempPassword` 返回形态，员工登录链路打通。
- **P0-12 订单详情接口不存在**：新增 `GET /api/orders/:id`（注册在所有具名路由之后，避免吞 `/my`、`/stats`）。
- **P0-13 路由守卫无限重定向**：`resolveFallback()` 逐个做可达性判断，全部不可达时落到无条件可达的
  `/no-access` 兜底页，杜绝回跳自身成环。
- **P0-14 退款按钮对销售可见必 403**：`v-if="isAdmin && status==='paid'"` + `openRefundDialog` 二次拦截。

### P1 / P2（主要项）

- **资金/卡口径**：退款渠道取原支付记录（不再硬编码 `wechat`）、退卡写 `payments` 负额流水、取消已支付订单
  同步清零剩余权益、部分退款遍历订单下全部卡回收、到店限次只统计已生效卡、请假扣天数改扣在用卡、
  手工扣课校验 `activated_at` 与课程范围。
- **校验/健壮性**：积分限定正整数且 ≤ 100000、卡种价格拒绝负数/非数字、姓名拒绝对象/数组、性别非空枚举、
  日期参数统一格式校验、订单总额上限 1 亿、`/finance/monthly` 年份范围校验、薪资默认月份改本地时区。
- **权限/审计**：`/staff-options`、`/classrooms`、`/courses`、`/courses/options` 补员工只读校验（此前未登录
  即可拉全员姓名+手机号）、`/admin/export` 改回全站约定 `200 + code!=0`、线索 `/stage` 与勿扰名单补校验与留痕。
- **前端体验**：试听「转正式学员」加 `isAdmin` 守卫、成员「导出为导入模板」改全量、增长中心预警补错误态与
  重试、家长通讯录电话列修正字段映射、到店页 `pageSize` 50→200 且超限提示、Logo 上限 2MB→200KB 并压缩、
  财务报表加口径说明、排期时间轴按当日实际课块动态扩展、下拉上限放宽并提示。

### 保留未改（需产品决策 / 外部依赖，方案见文档第十节）

- **P1-1 微信支付**：`utils/wechat-pay.js` 维持 fail-closed（未接入真实商户证书前不放宽，避免伪造回调免费开卡）。
- **P1-6 退卡 `order_type='refund'` 台账行**：收敛为显式状态字段需单独提交并同步更新
  `finance-refund-regression.cjs`（该测试依赖当前形态）。
- **P2-33 卡实例范围快照**：需新增 `member_cards.scope_snapshot` 迁移，属 schema 变更，待确认后执行。

### 验证

- 后端全量回归：**PASS 367 / FAIL 0 / WARN 0**，**46/46 套件通过**（含新增 `settings-columns-persistence`）。
- 前端 `npm run build` 通过；前端静态守卫 **19 PASS / 0 FAIL**；简易退费独立回归 **10 PASS / 0 FAIL**。

## [Unreleased] — 2026-10-26 视觉巡检（Task B）：全 36 页审查 + 列宽截断修复（未发布）

把 Playwright 截图对比纳入常规流程，并系统审查全部页面，定位并修复视觉缺陷、确认无安全漏洞。

### 一、常规化：截图对比纳入 CI / 本地门禁

- 新增 `web-admin/tests/visual-sweep.mjs`：可复用截图巡检（API 登录注入 token、遍历 36 页、采集
  console 错误 / ≥400 响应 / 4 档断点 1280·1024·768·390 横向溢出 / 与 baseline 像素 diff），输出 REPORT.json + REPORT.md；
  硬问题（⛔）必失败，`--fail-on-diff` 让像素漂移（🔺≥1.5%）失败。
- 新增 `tools/serve-ui.mjs`：仓库内静态服务，代理 `/api` 到后端，CI 与本地复用。
- `package.json` 增加 `visual:serve` / `visual:update` / `visual:sweep` 脚本及 playwright / pixelmatch / pngjs 开发依赖。
- `.github/workflows/ci.yml` 增加 `visual-sweep` 作业：构建前端 → seed 隔离库 → 启动后端 + 静态服务 →
  跑 `--update` 采集基线并上传 `tests/shots/` 产物（CI 不卡像素漂移，平台字体敏感；本地 `--fail-on-diff` 为真实闸门）。
- 提交 36 页 baseline 作为后续对比基准（运行产物 `tests/shots/` 与 `baseline/*.diff.png` 已 gitignore）。

### 二、审查结论：安全无漏洞

- 全仓 grep + 读码确认：无 `v-html` / `innerHTML` / `eval` / `new Function` / `dangerouslySetInnerHTML`。
- 两处 `document.write` 打印视图（签到表、收据）均对动态字段做 `escapeHtml`，无 XSS。
- 导出 / 备份 / JSON 导入 / 恢复等端点全部 `isAdminReq` 守卫；`isAdminReq` 由 JWT 校验后的 openid 推导角色，
  前端无法伪造越权（已核对 `backend/utils/index.js` 的 `getOpenId` / `verifyToken` 显式忽略客户端 `x-openid`）。

> **结论修正（2026-10-27）**：经回归测试复查，上述「全部 `isAdminReq` 守卫」只覆盖了**子端点**（导出/备份/导入/恢复），
> 而 `PUT /api/settings` **主写入端点本身此前漏加守卫**——任意已登录的非管理员（销售/教练）均可篡改系统设置
> （机构信息、积分/退费/推送规则、各表格字段配置）。已补守卫，详见第四节。

### 三、修复的视觉缺陷（已程序化验证 scrollWidth ≤ clientWidth）

- **学员表列被省略号截断**：`resolveColumnWidths` 此前只用 `autoWidths` 覆盖列定义 `minWidth`，而
  `computeAutoWidths` 的 `cellPadding(20)` 略小于 Element Plus `.cell` 实际左右内边距（各 12px），
  密集表格下列被压窄 → `联系方式 / 出生日期 / 加入时间 / 序号` 截断。改为取
  `max(自适应实测, 列定义 minWidth)` 作为保底宽度（全表受益）；并上调 `联系方式(130→140) /
  出生日期(100→120) / 加入时间(100→160)` 的 minWidth 且加 `tooltip`。修复后该页截断单元格 30 → 0。
- **请假表「请假时间」截断**：`"2026-10-26 13:30"` 超出 min-width 130 被截断 → 提至 160 并加
  `show-overflow-tooltip`（「申请时间」同改，min-width 100→160）。
- **登录页角色网格幽灵第 4 列**：`grid-template-columns: repeat(4, 1fr)` 但只有 3 个角色 chip →
  改为 `repeat(3, 1fr)`。

### 四、复查补洞：PUT /api/settings 越权写（安全）

- **问题**：`PUT /api/settings` 主写入端点此前**没有 `isAdminReq` 守卫**。全局中间件只校验 JWT 身份
  （填充 `req.openid`），不区分角色，于是任意已登录的非管理员（销售/教练）都能写入系统设置 ——
  机构信息、积分/退费/推送规则、各表格字段配置（`*_columns`）。第二节「导出/备份/导入/恢复等端点全部
  守卫」只覆盖了子端点，主写入端点被漏掉。
- **修复**：`routes/settings.js` 的 `router.put('/')` 入口补 `if (!isAdminReq(req)) return res.status(403)…`，
  与同文件其它写端点一致。
- **回归**：新增 `backend/tests/settings-columns-persistence.test.cjs`（11 项）——`growth/trial/finance/
  students/orders_columns` 落库并原样读回、键级 upsert 不互相抹除、白名单外键被忽略、非管理员 PUT 返回 403；
  已注册进 `run-all.cjs`。

### 验证

- 全 36 页 `--update` 巡检：✅36 / ⛔0（无 console 错误、无 ≥400、无横向溢出、无失败请求）。
- 设置列配置持久化回归：11/11 PASS（`settings-columns-persistence.test.cjs`）。
- 截断探针（程序化测 `scrollWidth` vs `clientWidth`）：学员表 30 → 0；请假表「请假时间」归零；登录网格 3 列 = 3 chip。
- 「请假原因」等长自由文本列仍按设计以 `show-overflow-tooltip` 截断、悬停看全文，非缺陷。

## [Unreleased] — 2026-10-26 订阅卡功能线：真实渲染验收与 UI 修复

上一轮只跑了构建与单测，没有在浏览器里看过实际渲染。本轮用 Playwright（生产构建 + 独立演示库）
逐页验收，发现 8 处只有渲染才暴露的问题，全部修复并补 3 条静态守卫。

### 一、功能回填断链（后端）

- **卡种列表不返回新字段**：`GET /membership/card-types` 的 SELECT 没有 `defer_enabled` /
  `period_anchor` / `refund_formula`，产品页表单永远显示默认值；而写侧是 `COALESCE`，
  用户「打开 → 保存」一次就把已配好的顺延/锚点/公式**静默改回默认**。已补齐三列。
- **待生效卡排在最前**：学员详情按 `created_at DESC` 排序，顺延卡（还不能用）顶到最上面，
  当前在用的卡被挤下去。改为待生效排最后。

### 二、样式层叠缺陷（全站）

- **文字型主按钮被渲染成实心块**：`.el-button--primary` 为压 EP 默认样式给 `background/border/color`
  加了 `!important`；带 `!important` 的声明不参与特异性比较，于是 `.el-button.is-text.el-button--primary`
  （不带 `!important`）**完全失效**。全站 7 处「文字型主按钮」都变成实心蓝块 ——
  学员卡里的「提前激活 / 转让」比真正的次要操作「暂停」还显眼。已给修饰规则补齐 `!important`。
- **文字按钮盖掉语义色**：`.el-button.is-text { color: accent }` 无条件覆盖，把 EP 按类型给的色
  一并压掉 —— `text type="warning"` 的「暂停」渲染成蓝色。收窄为「仅未指定 type 的文字按钮」。

### 三、表单没有行间距（全站，影响最大）

`el-form-item.css` **整份没有进包**：按需解析器把 ElFormItem 归到 form 目录，其 `style/css`
只 import `el-form.css`（仅 inline 表单规则）。此前只手工补回了必填星号，其余一起丢失：

- `.el-form-item` 的 `margin-bottom` → 全站表单零行距（设置页的说明文字与下一行标签粘在一起，读起来像同一段）
- `.el-form-item__error` 定位与配色 → 校验错误位置错乱
- 标签布局规则

处置：`main.js` 显式 `import 'element-plus/es/components/form-item/style/css'`，并删除手写的星号规则
（同一决定的第二份实现）。补回后 `.el-form-item__content` 带上 `line-height: 32px`，
多行说明被撑散，故为 `.form-hint` 显式指定行高。

### 四、弹窗高度

`max-height: calc(100vh - 260px)` 只减固定像素，而 EP 弹窗上边距是 **15vh**（随窗口变化）：
1440×900 下总高 820 + 上边距 135 → 底部溢出视口 15px，末行表单被切在滚动边界上。
改为 `calc(85vh - 200px)`，900/720/640 三档实测均留 20px 余量。

### 五、订阅卡 UI 细节

- **状态自相矛盾**：顺延卡 `status` 也是 `active`，界面同时显示「进行中」和「待生效」。
  改为状态位优先显示「待生效」，日期行显示「生效 2026-11-11 · 到期 2026-12-11」，
  并去掉操作区重复的 tag。
- **确认框里的字面量 `**立即**`**：`ElMessageBox` 未开 HTML，markdown 星号原样输出。已改文案。
- **产品列表看不到顺延开关**：与「可转让」同属影响权益的开关，补 `顺延` 标记。
- **「次 / 周」被压成两行**、`次 / 月（0 表示不限）` 被挤到下一行与输入框脱开：
  单位 `nowrap`、限次行允许整组换行，「0 表示不限」单独成行。

### 六、看板环图标签被裁

330px 卡片里单行「名称 24.32%」超出画布，被裁成「时效月卡 24....」（百分比先丢）。
半径 76%→64%，标签改双行（名称 / 百分比），实测五个切片全部完整可读。

### 七、把这次教训变成守卫（3 条，已反向验证）

`web-admin/tests/static-checks.test.mjs` 新增：

- 基规则带 `!important` 时，`.is-text` 修饰规则必须也带（否则永远不生效）
- `.el-button.is-text` 不得无条件设 `color`（否则盖掉 warning/danger 语义色）
- `main.js` 必须引入 `form-item/style/css`

> 守卫本身也踩了一次坑：第一版对整块取正则，把 `&:hover` 里的 `!important` 当成主体声明，
> 于是永远 PASS（等于没守卫）。改为只看嵌套块之前的顶层声明后才真正能拦。

### 验证

后端 **45/45** 套件、前端 62 + **19**（原 16 + 新增 3）、构建通过。
9 个主页面渲染扫描：横向溢出 0、控制台错误 0、失败请求 0。

## [Unreleased] — 2026-10-26 订阅卡功能线（顺延 / 周期锚定 / 退费公式）

按《订阅卡功能线设计提案》实施 P1–P4。三条口径来自你的拍板：顺延要做、周期锚定可配（开卡日/首次使用日）、
时效卡退费公式可自定义。

### P1 顺延

- 发卡时若学员已有**同科目在途卡**且卡种开启 `defer_enabled`，新卡排在旧卡到期之后（`day` = 次日 00:00，或 `exact` = 到期 +1ms）。
- **基准卡选择包含「已发未生效」的顺延卡** —— 否则连买 N 张会全部落在同一时段，额度翻倍（资损级）。
- 未生效卡不可用：`pickCardForDeduction` 与可用性判定统一加 `activated_at < 次日 0 点` 过滤（按自然日比较，
  避免「当天开卡当天上课」被误判）。
- `POST /api/membership/card/:id/activate-now`（仅管理员）：提前激活并**同步作废同科目在途旧卡**（`status='superseded'`）、
  清空顺延谱系（否则退款回滚会把已不等待的卡拉回等待态）。
- 学员档案：待生效卡显示「待生效 YYYY-MM-DD」+「提前激活」入口，二次确认写明代价。

### P2 周期锚定

- 卡实例快照 `period_anchor`（`natural` / `activated` / `first_use`）+ `cycle_days_week/month`。
  发卡时快照，机构之后改卡种配置不影响已售卡。
- 到店限次改为**逐卡按自己的锚点**切段（固定 7 天 / 30 天），不再把所有卡的上限揉成两个全局数字。
- **末段折算**：卡在段中间到期时，上限按 `ceil(上限 × 剩余天数 / 段长)` 折算（月限 8、剩 12 天 → 4 次）。
- `first_use` 锚点：首次 `present/late` 落库时写 `first_used_at`；未使用前不限次（没消费就不该受限）。
- **保留 `natural` 兼容态**：存量卡迁移后仍是自然周/自然月，避免上线当天所有老客户的限次口径突变。

### P3 退费公式

- 新增 `utils/formula.js`：**受控表达式求值器**，不用 `eval`/`new Function`。
  变量白名单（`remain`/`remain_days`/`remain_classes`/`fee_rate` 等 11 个）、四则运算、`min/max/round/floor/ceil/abs`。
  拒绝字符串、布尔、条件表达式、属性访问、外部函数；长度 ≤500、括号深度 ≤20。
- 三层优先级：卡种 `refund_formula` → 全局 `card_rules.refund.formula` → 内置默认（与改造前金额一致）。
- 结果夹取到 `[0, remain]`；公式写坏时**回落既有规则并留痕**，不会把退款算成 0。
- 预览返回 `formula` 明细（公式 + 代入值 + 结果），前端可解释「这钱怎么算出来的」。

### P4 配置与前端

- 新增 `settings.card_rules`（迁移 039，已登记进 `KEYS` 白名单），保存走**按组浅合并** ——
  只提交一组不会把另外两组冲空（设置页历史通病）。
- 设置页新增「订阅卡规则」分组：顺延（开关/起点/跨科目/提前激活）、周期锚定、退费公式（含变量说明与示例）。
- 卡种表单新增「参与顺延 / 限次周期 / 退费公式」三项，留空 = 跟随全局。
- 迁移 037（卡实例 5 列）/ 038（卡种 3 列）/ 039（设置）/ 040（回填 `first_used_at`，只补 0 值）。

### 回归

新增 `backend/tests/subscription-card-regression.cjs`（35 断言，A 顺延 / B 周期 / C 公式 / D 配置）。
后端 **45/45 套件**（CST + UTC 双时区）、前端 62+16、构建通过。

### 与外部补丁的差异

外部交付的 8 个补丁实现了同一目标但基线不同、无法应用，本实现按其报告描述的问题独立完成，
并在两处更保守：① 退费公式用受控表达式而非枚举；② 周期锚定保留 `natural` 兼容态。

## [Unreleased] — 2026-10-26 多孩家庭 + 冷门路径 9 项修复（未发布）

来源：《多孩家庭仿真测试报告-20261025》D1–D6、《冷门路径仿真测试报告-20261025》F8-1 / F7-1 / F4-1。
补丁文件按 file:line 逐项核实后自行实施（原补丁基于旧基线，无法直接 `git apply`）。

### 多孩家庭（6 项）

- **D1 兄弟姐妹被查重误拦，且返回体是「假成功」**：`findDuplicateStudents` 把「家长手机号相同」
  单独判为强重复 —— 多孩家庭共用家长手机号是常态，第二个孩子起一律建不进去；
  更糟的是响应 `code=0, message:"ok"`，只判 code 的前端会以为建档成功（实际没有 id、没有落库）。
  现强匹配收紧为**同号 + 同名**，同号不同名降级为弱提示；查重命中改为业务失败码 + 明确文案。
  > 附带修正：导入路径的「兄弟姐妹」warning 原先依赖 strong 命中，改为按**手机号命中**派生，
  > 否则收紧后会丢掉提示（v106 回归发现）。
- **D2 排课名单不生成报名**：`student_ids` 只写进 `schedules` 的文本列，而家长端课表、扫码签到、
  「是否已报名」全部以 `enrollments` 为数据源 —— 管理端排好的课，家长看不到、也不能自助签到。
  现单次与周期排课都会按名单生成报名，并同步 `enrolled_count`。
  > 边界：**只对显式 `student_ids` 生效**。班级/团体的报名走申请-审批流（`status='pending'`），
  > 自动建成 active 会把审批架空（class-module 回归发现）。
- **D3 解绑后永远无法重绑**：`unbindStudent` 物理删除绑定行，而重绑的手机号后 4 位校验依赖
  `parent_bindings.parent_phone` —— 行一删，验证依据被销毁。现改为**软解绑**（`parent_openid=''`），
  保留手机号作为重绑依据；登录时的绑定迁移同步排除软解绑行，否则解绑会被自动挂回。
- **D4 绑定上限 3 与多孩家庭矛盾**：放宽到 5（与「建档填手机号 + 家长登录」自动挂载路径的实际行为对齐）。
  安全边界不依赖名额：绑定仍需「姓名 + 学员编号 + 手机号后 4 位」三重校验，且有三层失败频控。
- **D5 跨课程卡静默不扣课**：持体适能卡上篮球课时，`scopeMismatch` 直接静默 return ——
  卡余额分文未动、收入未结转，界面零提示。现 `applyArrivalDeduction` 显式返回扣课结果，
  点名 results 带回 warning（「持有『X』但不适用于本课程，本次未扣课」）。
- **D6 家长端首页不回学员 id**：`home/data` 的 `student` 只有 name/avatar，多孩家庭前端无法定位切卡。已补 `id`。

### 冷门路径（3 项）

- **F8-1 非在册学员可被排补课**：`makeup/assign` 只校验学员行存在，已退课/已归档学员可被排进未来场次
  （到场无卡可扣却照常计考勤）。现改用与 leave/enroll 同源的 `ACTIVE_STUDENT_SQL`。
- **F7-1 重复取消排期仍报成功**：已 `cancelled` 的排期再次 DELETE 返回 `code=0`，管理端无法区分
  「本次取消了」与「早已取消」。现显式拒绝。
- **F4-1 分享凭证复用误报「凭证无效」**：`tk.used` 与「无效/过期/跨周/跨人」混在一个分支，
  家长手指连点会被告知凭证失效并反复重新分享。现拆开：已使用且本周已到账 → 幂等返回
  「本周已领取分享积分」（`added=0`）；其余情形维持原拒绝。

### 新增回归

`backend/tests/v111-fixes-regression.cjs`（24 断言）。后端 **44/44 套件**、前端 62+16、构建通过。

### 未纳入本轮：订阅卡「规则中心」功能线

另有两份报告（订阅套餐全链路、订阅新口径深度）与 8 个补丁（1025 → h，约 2000 行）描述的是
**一套本项目尚不存在的功能**：顺延卡链、暂停禁入、退款双公式、规则配置中心（`card-rules.js`）、
`activate-now`、迁移 037–040。本项目当前**没有** `defer_rules` / `card-rules.js` /
`deferred_from_card_id` 等任何相关代码，补丁也无法在现有基线上应用。
这不是「修复」，而是**新增一条功能线**，需单独立项评估（见交付说明）。

## [Unreleased] — 2026-10-24 四份外部报告修复（未发布）

来源：《综合问题与漏洞审查报告-20261023》（24 项）、《真实业务自动化测试报告-20261024》（3 缺陷 + 1 建议）、
《三角色仿真测试报告-20261024》（F1–F5）、《修复方案报告-20261024》（6 项）。
**报告所附 patch 未随附**，全部按 file:line 逐项核实后自行实施。本轮修复 17 项。

### 资金与账目（高危）

- **H1 销售可无上限发积分（真实资损）**：`convert` 的 `rewardPoints` 取自请求体且无归属校验，
  配合 `PUT /leads/:id` 可任意改 `student_id`，形成「建线索 → 改关联学员 → 成交发 999999999 分」的资损链。
  现改为**仅管理员可发**，并夹取 ≤ 9999；`studentId` 改关联也仅管理员可操作。
- **H2 `totalPrice` 被信任**：客户端可传 `unitPrice=0, totalPrice=1000`（实付 0）而收入结转
  `itemLineTotal` 优先取 `totalPrice` → 按 1000 逐次确认收入。现入库前**服务端重算** `totalPrice = unitPrice × qty`。
- **H3 `status` / `discountAmount` / `paidAt` 无校验**：`discountAmount:"abc"` 会让 `payable_amount` 变 NULL；
  `status:"refunded"` 可建成无流水的"已退款单"；`paidAt` 可把收入记到任意历史月份。
  现折扣须为 `[0, totalAmount]` 的有限数、状态白名单 `pending/paid`、`paidAt` 夹取到 `[建单-1天, 现在]`。
- **H4 / 缺陷1 一单多件只发一份权益**：`quantity=2` 实收两份钱却只发 1 张卡、1 份积分。
  现发卡与积分**按数量展开**（同一卡种多条明细合并计积分，避免 refId 冲突）。
- **M1 0 元单仍计入销售统计**：现 0 元单强制 `revenue_excluded=1`。
- **S1 / 缺陷3 `/orders/stats` 缺 `revenue_excluded=0`**：赠课/核销单虚增销售业绩，与财务页同屏矛盾。已补。
- **M6 退卡退款不冲减销售统计**：退款落在 `refund_standalone` 载体单上被 `status='paid'` 谓词整条排除。
  现按退款发生时间在同一区间冲减，与 `finance/summary` 对齐。

### 链路与权限

- **F2 销售建单后无法收款**：收款闸门只看 `isAdminReq`，把销售与家长一并拦下。
  现改为「可操作该订单的员工」可代收（管理员不限），**家长自助仍 fail-closed**；
  刻意不用 `canSales` 一刀切 —— 那会让任一销售能给任意人的订单收款，打开既有 IDOR 防护的口子。
  ⚠️ 与 H3 强耦合：H3 收口 `status` 白名单后，「建单即 paid」旁路消失，两者必须同批上线。
- **F1 建档权限口径矛盾**：接口硬编码仅管理员，而 `DEFAULT_PERMS.sales` 含 `students`、前端据此显示入口。
  现口径为**管理员 + 销售可建档、教练不可**；并把姓名/性别校验抽到 `utils/student-basics.js`，
  线索转化建档旁路复用同一判据（此前 60 字姓名可从旁路入库）。
- **M2 销售可伪造业绩归属**：非管理员建单时 `salesperson` 强制为本人昵称。
- **M3 跟进任务无归属校验**：任一销售可完成/取消他人任务。现非本人不可操作。
- **F5 批量点名丢弃成功明细**：部分拒绝时 `data` 为 null，而通过者已写库。现带回 `results` 逐人明细。

### 业务口径与健壮性

- **缺陷2 时长卡跨周期限次被绕过**：周期按 `now()` 算，提前排课的日期全落在区间外 → 上限永不触发。
  现周期按**被签到排期的日期**计算。
- **F3 周期排课冲突静默跳过仍返回成功**：现收集 `skipped` 明细；**一节都没排上时回滚整个事务**
  （含 `schedule_rules` 行，避免堆积空转规则）并返回明确失败。
- **F4 同手机号重复员工档案**：创建/改号均查 `teachers` 表；新增 `migrations/036` 建部分唯一索引
  （空号不参与）。**不自动合并存量**——合并要改课时/工资引用，判断错就是把历史挂到别人名下；
  有重复时打印清单由管理员人工处理。
- **MH4 无安全响应头**：补 `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / `CSP`，
  去掉 `X-Powered-By`；HSTS 需显式 `ENABLE_HSTS=1`（避免本地 http 被强制升级）。
- **MH3 npm critical**：`overrides` 将 `proxy-addr` 提到 2.0.8（IP 伪造可绕限流/登录锁定）。
- **M7 出站 fetch 无超时**：统一 `AbortSignal.timeout(5000)`（默认 300s，微信抖动会挂满连接）。
- **L3 LIKE 通配符未转义**（6 处）：输入 `%` 等价于不带条件。统一 `escapeLike + ESCAPE`。
- **L7 JWT 密钥权限 644**：写入与读取时均 `chmod 600`（同机任意用户可读即等于可伪造管理员 token）。

### 新增回归

`backend/tests/v110-fixes-regression.cjs`（19 断言）：H1 积分 / H2 totalPrice / H3 状态折扣 /
H4 数量展开 / F1 建档权限 / F5 点名明细 / M3 归属。后端 **43/43 套件**。

### 本轮未修（已知，需单独决策）

| 项 | 原因 |
|---|---|
| MH1 多卡订单退款按「最新一张卡」定价 | 需要退款接口支持显式 `cardId` + 多卡消耗聚合，改动面涉及退款定价核心 |
| MH2 缺席不扣课 + 补课免扣 | 属产品口径（缺席是否计次），需先定规则 |
| M4 手工扣课指定 `cardId` 绕过课程范围 | 需与「1v1 卡只能扣 1v1 课」的既有约定对齐后改 |
| M5 请假扣课不写收入结转 | 涉及权责发生制口径，需财务确认 |
| M8 `/uploads` 未鉴权 | 需改私有存储 + 签名 URL，属架构调整 |
| L2 卡种负价 / L4 头像 scheme / L5 CORS 打印 / L6 日志含 secret | 低危加固，单独排期 |
| 超额退款静默夹取 | 金额正确，仅缺提示文案 |

## [Unreleased] — 设计令牌收敛（未发布）

对应 trycompai/crm 的 `docs/design.md` 第一条规则：**同一语义只能有一个值**。
本轮不改功能、不改视觉，只消除"同一个决定在两处各写一遍"。

### 1. 删除未启用的第二代设计令牌（v4）

`variables.scss` 里并存 v3（`--t-*`）与 v4（`--v4-*`）两代令牌，注释称"v4 为准备态、不覆盖 v3"。
逐项核查结果：

| 令牌 / 类 | 页面引用次数 |
|---|---|
| `$v4-success` / `$v4-danger` / `$v4-primary` / `$v4-radius-6` / `$v4-dur-*` 等 | **0** |
| `.v4-btn` / `.v4-card` / `.v4-tabular` / `.v4-stagger-in` | **0** |
| `.v4-num-display`（数字展示） | 19 |

也就是说：**两套色板里只有一套在用，另一套纯属脚手架**。它不占运行时成本，但占认知成本 ——
同一个"成功"有 `#34C759` 与 `#10B981` 两种绿、同一个按钮有 8px 与 6px 两种圆角；
后人照 v4 写新页面，两套就都变成"在用"，再收敛要改 27 个页面。

处置：删除 v4 的颜色/圆角/动效/字体令牌与四个死类，只保留实际在用的数字展示
（`--font-display` / `--fs-5xl` / `--fs-6xl` / `--num-features`），类名 `.v4-num-display` → `.num-display`。
**视觉零变化**。

### 2. 焦点环收敛为单一 token

全站 4 处 `outline` 原本各自写 `2px solid var(--t-accent-line)`，其中一处偏移是 1px 而其余是 2px。
现统一为 `--focus-ring` / `--focus-offset`，改宽度只需改一处。

### 3. 弹窗遮罩修复：一个变量管两套主题

`.el-overlay` 此前硬编码 `rgba(0,0,0,.32)`，把深色主题单独调过的 0.6 **又盖了回去** ——
同一个遮罩在两套主题下实际只有一种取值，而 `--t-scrim` 定义了却从未被任何规则使用。

现统一走 `--t-scrim`（浅色 .32 / 深色 .62），`--el-mask-color` 也指向它。
补充一句实述：深色下页面本身接近纯黑，黑遮罩能压暗的余量很小，
**层次主要由弹窗表面色（#17171C）与 0.65 投影承担**，遮罩是辅助 —— 不要指望它单独撑起分隔。

### 4. 把规则变成 CI 门禁

`web-admin/tests/static-checks.test.mjs` 新增 3 条守卫（并已做反向验证：注入违规后确实变红）：

- 不得再出现第二代令牌（`$v4-` / `var(--v4-`）
- 焦点环不得硬编码 px（必须走 `--focus-ring`）
- `.el-overlay` 必须走 `--t-scrim`

> 这正是该 CRM 的做法：把设计规则写成可执行的检查（它有 `tools/oxlint/anti-slop`），
> 而不是写在文档里靠自觉。

## [1.0.10] - 2026-10-23

逆向 trycompai/crm 后的对照落地。该 CRM 的功能清单与本项目重合度很高（管道看板、跟进建议、
批量操作、导入向导、时间线、URL 状态、命令面板均已具备），因此本轮只补**唯一确认的交互缺口**，
并把对照结论写成文档，避免后续重复"加功能"。

### 线索看板支持拖拽推进
- 此前每张卡片带一个阶段下拉框，改阶段要"点开下拉再选"——这是表单式操作，不是管道式操作。
- 现支持拖动卡片到目标列即推进（`POST /growth/leads/:id/stage`），已成交的卡片不可拖，
  与下拉框的 `disabled` 判据一致。
- 落点用 `outline` 高亮而非 `border`：避免拖动时列高跳动；拖动中卡片 `opacity: .45`。
- 拖回原列 / 拖到空白处不发请求；`dragleave` 按 `relatedTarget` 判定是否真正离开，
  避免掠过子元素时高亮闪断；Firefox 需显式 `dataTransfer.setData`，已补。
- **保留下拉框**：拖拽是鼠标增强，键盘用户仍需可用的非拖拽路径。

### 文档
- 新增 `starclass-CRM逆向对照报告.md`：该 CRM 的定位与三条反常规原则（不做置信度评分 /
  智能不放在 API 里 / 无多租户抽象）、租约式工作队列、沙箱"无网络无数据库"边界、
  圆角三档与"填充只给两种"的设计规则，以及与项目逐项对照表。
- 报告另列三条**未落地但建议立项**的一致性整改：v3/v4 双设计令牌并存
  （同一个"成功"有两种绿、同一个按钮有两种圆角）、焦点环无统一 token、暗色遮罩可辨性待目视核对。

## [1.0.9] - 2026-10-23

合入外部四轮测试反馈（v1.0.9~v1.0.11 报告，23 项待办中的 18 项），并补做三项产品裁决（R1/R2/R3）。

### 资金与一致性
- **时效卡部分退款必崩 500**：`UPDATE member_cards` 有 3 个占位符只传 2 个实参，
  `better-sqlite3` 抛 `RangeError` → 事务回滚。默认规则下任意时效卡部分退款都不可用。
- **开课前百分比退费不回收卡权益**：回收条件多带 `suggestion.started`，而
  `beforeStart='percent'` 分支该值恒为 false → 学员拿回现金却保留整张卡。
- **已取消排期仍可点名**：取消时已回滚课时/积分/结转，再点名会二次扣课发分并留幽灵考勤。

### 安全
- **线索模块横向越权**：PUT/DELETE/convert/stage/suggestion 五条路径只校验「有 growth 权限」，
  任一销售可改删转化他人线索（含手机号）。新增 `canOperateLead`，列表读侧同步隔离，
  DELETE 补存在性检查与审计留痕，创建时非管理员默认归属本人。
- **登录限流误伤正常用户**：每次尝试无条件计数，NAT 共享出口下第 100 个从未输错的用户
  即被 429 封锁 15 分钟。改为仅失败（HTTP≥400）计入。

### 数据质量
- 性别白名单 `['', '男', '女']`、姓名上限 50 字：**建档 / 编辑 / 导入三路径收敛到同一判据**
  （此前只有建档校验，PUT 与导入是绕过通道）。
- 下单 items 值域：单价 0~1e9、数量 1~9999 整数（负单价与 `1e308` 此前可穿透）。
- 删除学员补删 `points` 账户行，消除「有余额、无流水」的僵尸账户。
- 种子数据性别 `male/female` → `男/女`，与生产库/前端口径一致。

### 产品裁决（R1 / R2 / R3）
- **R1**：销售在学员列表与详情均**不可见生日、累计消费/购买次数**，可见 roster 与家长手机；
  两处接口同口径（此前只改列表会让详情成为绕过通道）。
- **R2**：为「会员卡转让」补管理端入口（学员详情 → 会员卡 → 转让，仅对可转让卡种显示）；
  其余无 UI 能力（体测 CRUD、教室增删改、积分排行、学员维度考勤单查、会员卡列表）
  在 `docs/api-only-capabilities.md` 中明确标注为 API-only 并说明理由。
- **R3**：新增 `POST /api/makeup/batch-assign`（一次课多名学员缺席时批量补课，
  逐人复用缺席校验/幂等/容量闸，单人失败不影响他人），补课页新增多选 + 批量安排入口。

### 其它
- 周期规则「停用并取消 N 场」：后端只认 `cascade=1`、前端传 `true` → 静默失效，两侧对齐。
- 家长账号可自助改密（角色集漏 `parent`）。
- 线索手机号正则统一为 `/^1[3-9]\d{9}$/`；线索创建、取消订单补防重提交。
- 测试脚手架跨平台：`/tmp` 映射到 `os.tmpdir()`，15 个套件守卫统一为 `assertIsolatedTempDb()`。

### 测试
新增 `v109-v111-regression.cjs`（25 断言）与 `chaos-v109.cjs`（26 断言，覆盖批量补课幂等/容量、
R1 脱敏、卡转让）。后端 **42/42 套件**（CST 与 UTC 双时区）、前端 62+13、构建通过。

## [1.0.8] - 2026-10-18

自 v1.0.7 起做了**四路独立审计**（安全 / 业务口径 / 前端流程 / 性能）与一轮全流程测试报告修复，
共确认缺陷 43 条，本轮修复 27 条，并新增 3 个回归套件。

### 安全（多数为默认值放开的漏洞）
- **P0 家长手机号免密登录默认开启**：`PARENT_PHONE_LOGIN` 按 `NODE_ENV` 推断，而日常启动脚本不设
  `NODE_ENV` → 生产实例实际运行在「非 production」分支。任何人知道手机号即可免口令登录该家长。
  改为只认显式 `PARENT_PHONE_LOGIN=true`。
- **P1 家长自助「模拟支付」默认开启** → 改为只认显式 `SIMULATED_PAY_DISABLED=0`。
- 排期列表 / 今日课表对家长返回 `s.*`，泄露内部 `remark` → 白名单化。
- 学员详情把同一孩子的其他监护人手机号返回给家长 → 家长只读自己那条。
- 头像上传从不校验文件头 → 按 magic bytes 判定，非 JPG/PNG/GIF/WEBP 直接拒。
- 数据导出含 `users.password` 哈希与 `token_version`、审计 `actor_id` 为空 → 剔除并传入操作者。
- 家长可自助暂停/恢复会员卡（等价「冻结时间」，可无限续期）→ 仅 admin/coach。
- 分享积分无凭证可脚本化刷分 → 新增 `POST /api/points/share/ticket`，一次性、绑定 openid+自然周。
- 零价建单/置已付：不审批、但要留痕 → 审计新增 `zeroAmount` / `zeroAmountPaid` 标记。

### 业务口径（账不平 / 数据错）
- **时效卡退费后日任务把已退订单重新确认成 100% 收入**（摊销取卡没过滤 status）。
- **取消已付订单不留退款记录、不冲销结转** → 原月收入凭空消失、合同负债为负。
- 0 元单（赠卡/核销）按标价结转收入；积分过期把已退款赠分再扣一次；时效卡转让后同一订单确认两次。
- 时效卡摊销改写 `recognized_at`，把历史月份收入搬到当天 → 改为只追加增量行。
- 退卡追加退款漏写 `last_refunded_at`；看板退款按 `updated_at` 归集（与财务报表不同源）。
- 看板 16 处营收查询补齐 `revenue_excluded` / 退款载体行排除；积分排行榜漏计签到积分。
- 暂停卡撤销签到时课时不回补、流水反被删 → 允许 `paused` 回补。

### 前端流程
- **P0 排期「日视图」几乎永远空白**（`day` 分支不带日期）。
- **P0 退款预览失败静默降级为「全额退款」** → 改为禁用提交 + 红字告警。
- **P0 停用周期规则勾「并取消 N 场」实际一场不取消**（`cascade` 放请求体、后端读 query）。
- **P1 订单页所有表格设置保存全部静默失败**（`saveSettings` 未导入，`ReferenceError` 被空 catch 吞掉）。
- **P1 签到页无法把学员标为「请假」**；新建成员可重复点击导致重复档案。
- 排期默认时间段是 `Invalid Date`（`dayjs('09:00','HH:mm')` 未注册 customParseFormat）。
- 开单 / 请假下拉此前只加载前 100 / 200 名学员 → 改远程搜索；`/students/options` 补 `parent_phone`。
- 导出弹窗「导出中…」是假的（`await emit()` 不等待父级 Promise）→ 改为父级回调驱动。
- 金额口径统一（此前同屏出现 `¥4997` 与 `¥4,997`）；删除与表头漏斗重复的订单状态 radio。

### 性能
- 补 `idx_notifications_template`（提醒任务逐条全表扫描）、`idx_orders_created`（订单列表默认排序）。
- 上课记录页默认近 30 天时间窗（此前留空 = 全表扫描 + 临时 B-tree 排序）。

### 测试
- 新增 `backend/tests/security-regression.cjs`（21 项）、`backend/tests/business-regression.cjs`（11 项）。
- 新增 `web-admin/tests/static-checks.test.mjs`（13 项源码断言：`$t` 作用域、`@save` 接线、`:align`、`timeRange.format`）。
- 后端 **40/40 套件**、前端 **62 + 13 项**、构建通过。

## [1.0.7] - 2026-10-17

用机构真实台账（会员表 150 行 / 销售表 3 个工作表 579 行）实测 v1.0.6，修复 15 项问题。
实测数据：**会员表入库 23 人 → 140 人**；**销售表入库 24 单 → 251 单**（三表合并）。

### 数据正确性
- **学员导入的生日只认 `YYYY-MM-DD`**：会员表 115 个非空生日中 65 个是 `M/D/YY`（如 `5/1/15`）、50 个是 `YYYY/M/D`（如 `2021/6/17`），**全部被判失败** —— 140 行只进 23 行。`birthday` / `joinDate` 改走与订单导入同源的宽松解析，归一后再做真实性终验（仍拦截 `2018-02-30` 这类「格式对但不存在」的日期）。
- **多工作表只导入第一张**：`25销售` / `24销售` 两个年度表 **416 行从未被读取**，界面仅一行灰色小字。改为解析全部工作表 + 勾选器（默认全选有数据的表），合并导入；错误信息带 `[表名]` 前缀，未勾选的表显式提示。
- **导入的「状态」原样入库**：台账写「正常 / 流失 / 退款 / 暂停」，系统枚举却是 `active / churn / refunded / paused`。新增中文 → 枚举映射（未知值记 warning 并回落 `active`）、迁移 035 治理存量，并**统一状态筛选口径** —— 旧实现按「会员卡存在性」推断，与列表状态列、看板统计三处打架，这才是「列头筛『正常』返回 0 条」的真正根因。
- **兄弟姐妹被强查重跳过**：同家长手机号、不同姓名 = 多孩家庭（实测 22 组），旧逻辑每组只进第一人。改为放行建档 + 警告；仅「手机号 + 姓名都相同」才判同一人跳过。
- **订单导入结果丢弃 skipped / warnings**：重复导入时只显示「全失败」，用户无法理解原因；「订单已入账但未开通会员卡」也看不到。
- **失败行号与文件不符**：`csvToObjects` 会先丢弃必填缺失行，后端按数组下标 `idx+2` 推算 → 缺失行夹在中间时偏移逐行累积。改为前端随行带原始文件行号 `_fileRow`。

### 交互
- **0 元订单**可导入（赠品 / 体验单是真实销售记录），负数仍拒绝。
- **同一收据单号多行**：批内重复自动追加 `-2/-3` 后缀全部入账并记警告；跨批重复仍跳过。
- **表头交互**：整个表头可点排序（不再要求点准右侧那个很淡的小箭头），Shift/⌘ 点击追加次级排序；表头右缘可**拖拽调列宽**，与「字段设置 → 列宽」写同一份存储。
- **搜索实时化**（300ms 防抖），不再要求回车或失焦。
- 列配置默认值：出生日期默认显示；联系方式最小宽度 130px（11 位手机号不再截断）。
- 导入确认文案按导入类型分别配置（不再串台，也不再声称「整批回滚」）；完成提示带全量数字且非常态时用警告样式。

### 多维表格扩展到 5 个页面
新增 `composables/useTableKit.js`，把「排序 + 列宽 + 视图 + 字段设置」抽为可复用能力，**试听预约 / 财务报表 / 增长中心**三个页签接入（分别按 `trial_columns` / `finance_columns` / `growth_columns` 持久化）。至此学员档案、销售管理、增长中心、试听预约、财务报表五处口径一致。

### 测试
- 新增 `backend/tests/v106-fixes-regression.cjs`（25 项）；前端工具层扩到 **62 项**（含 5 个页面的接线断言）。
- 后端全量回归 **38/38 套件通过**。

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
