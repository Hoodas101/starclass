# 更新日志（Changelog）

本项目所有值得注意的变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
