/**
 * P1-13 回归测试 —— 看板图表接口的聚合正确性与查询次数
 *
 * 原始缺陷：
 *   1. /api/admin/charts 按天循环 prepare + 查询：到场趋势每天 1 次、营收趋势每天 2 次。
 *      month 口径实测共 91 次 prepare；且营收谓词 date(paid_at/1000,'unixepoch','localtime') = ?
 *      不可用索引，等价于每天两次全表扫描。
 *   2. 产品销量把全部已付订单的 items 读进 JS 逐条 JSON.parse。
 *   3. 读取 items 时假定数组元素必为对象。历史数据中存在「元素为 JSON 字符串」的双重编码行，
 *      对这些行取 item.itemName 恒为 undefined，真实销量被整批计入「其他」。
 *
 * 判别性说明（每条断言都先证明旧实现给出不同结果）：
 *   - 查询次数：断言远低于旧实现的 91 次；旧实现必然失败。
 *   - 双重编码：用例内直接跑「旧口径读取」证明它把该行判为「其他」，
 *     从而证明新查询按真实项目名归类是真实生效的，而非恒真断言。
 *   - 非法 JSON：护栏缺失时 SQLite 会对整条查询抛 malformed JSON、接口返回 500，
 *     故「返回 200」本身即判别性断言。
 *
 * 运行：node tests/dashboard-charts-regression.cjs
 */
'use strict';

const { bootstrap } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-charts');

const db = require('../db');
const adminRouter = require('../routes/admin');
// formatDate / attendanceRate 是「期望值」的独立来源：断言不引用被测接口的任何输出，
// 而是用同一份夹具数据按声明口径重算，再与接口逐值比对。
const { formatDate, attendanceRate } = require('../utils');

function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path !== path) continue;
    if (!layer.route.methods[method]) continue;
    const handlers = layer.route.stack;
    return handlers[handlers.length - 1].handle;
  }
  throw new Error(`未找到处理器: ${method.toUpperCase()} ${path}`);
}
function mockRes() {
  const r = { statusCode: 200, body: null };
  r.status = (code) => { r.statusCode = code; return r; };
  r.json = (payload) => { r.body = payload; return r; };
  return r;
}

let passed = 0, failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${ok ? '' : '  -> ' + detail}`);
}

const gen = (p) => p + Math.random().toString(36).slice(2, 10);
const created = []; // 用例自建订单 id，收尾清理

/** 插入一张已支付订单，items 由调用方给定原始文本（可为任意形态 / 非法值） */
function mkPaidOrder(itemsRaw, payable = 100) {
  return mkPaidOrderAt(itemsRaw, payable, Date.now());
}

/**
 * 同上，但 paid_at / refunded_amount 可指定。
 * 营收趋势按 paid_at 归日、且以 payable − refunded 计净额，要断言「某一日桶精确 +N」
 * 与「退款确实被冲减」，就必须能把订单钉在指定日期并带上已退金额。
 */
function mkPaidOrderAt(itemsRaw, payable, paidAt, refunded = 0) {
  const ts = Date.now();
  const id = gen('ORD_CHART_');
  db.prepare(`INSERT INTO orders (id, order_no, student_id, student_name, order_type, items,
      total_amount, discount_amount, payable_amount, status, paid_at, refunded_amount, created_at, updated_at)
    VALUES (?, ?, 'stu_chart_probe', '图表探针', 'membership', ?, ?, 0, ?, 'paid', ?, ?, ?, ?)`)
    .run(id, gen('CHART'), itemsRaw, payable, payable, paidAt, refunded, ts, ts);
  created.push(id);
  return id;
}

/** 调用真实路由处理器（跳过 dashboardGuard，直接测聚合逻辑） */
function callCharts(period) {
  const res = mockRes();
  getHandler(adminRouter, 'get', '/charts')({ query: { period } }, res);
  return res;
}

console.log('\n\x1b[1m=== P1-13 看板图表聚合回归测试 ===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '（seed 夹具）\n');

// ============================================================
// 一、查询次数：不再按天循环 prepare
// ============================================================
console.log('\x1b[1m[一] 查询次数（旧实现 month 口径 = 91 次 prepare）\x1b[0m');
{
  let prepCount = 0;
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => { prepCount++; return realPrepare(sql); };
  let res = null, err = null;
  try { res = callCharts('month'); } catch (e) { err = e; } finally { db.prepare = realPrepare; }

  // 阈值 8：新实现为固定几次（到场/报名/产品/营收各 1，加少量零散查询），
  // 而旧实现为 30 + 60 + 少量 ≈ 91。任何「按天循环」的回归都会立刻越过阈值。
  rec('month 口径 prepare 次数 < 8（旧实现为 91）', prepCount < 8, `实际=${prepCount}`);
  rec('接口返回 200', !err && !!res && res.statusCode === 200,
    err ? `抛错=${err.message}` : `status=${res && res.statusCode}`);
}

// ============================================================
// 二、响应结构与口径
// ============================================================
console.log('\n\x1b[1m[二] 响应结构与口径\x1b[0m');
{
  const charts = callCharts('month').body.data;
  // 结构断言集中在下方；此处先确认 data 存在，避免后续点号取值把失败变成崩溃
  rec('响应包含 data 主体', !!charts, `data=${JSON.stringify(charts)}`);
  const att = (charts && charts.attendanceTrend) || { labels: [], data: [] };
  const rev = (charts && charts.revenueTrend) || { labels: [], current: [], prev: [] };
  rec('到场趋势为 30 天序列', att.labels.length === 30 && att.data.length === 30,
    `labels=${att.labels.length} data=${att.data.length}`);
  rec('营收趋势双序列各 30 天', rev.labels.length === 30 && rev.current.length === 30 && rev.prev.length === 30,
    `labels=${rev.labels.length} cur=${rev.current.length} prev=${rev.prev.length}`);

  // ── 判别性断言 ────────────────────────────────────────────────
  // 被替换掉的两条旧断言是「常量下界」，对任何形状正确的响应都恒真，证明不了数算对了：
  //   · att.data.every(v => Number.isInteger(v) && 0 <= v <= 100)  → 任何 0..100 整数都过
  //   · [...rev].every(v => typeof v === 'number' && v >= 0)       → 任何非负数都过
  // 下面每条都锚定「用同一份夹具独立重算出的具体数值」，任一口径回归都会立刻变红。

  const todayStr = formatDate(Date.now());
  const firstStr = formatDate(Date.now() - 29 * 86400000);

  // (1) 营收总量恒等：30 天逐日营收之和 = 按同一谓词独立重算的总和。
  //     捕获：窗口偏移一天、漏算某日、状态过滤写错。
  //     ⚠️ 要让「退款被冲减」这一条真的可判别，夹具里必须存在 refunded_amount > 0 的订单：
  //        seed 订单已退金额全为 0，若只依赖 seed，把 payable−refunded 写成 payable 也照样绿。
  //        故此处先插入一张「实付 1000、已退 300」的订单，使净额口径（700）真正参与比对。
  mkPaidOrderAt(JSON.stringify([{ itemType: 'membershipCard', itemName: '退款冲减探针', quantity: 1 }]),
    1000, Date.now(), 300);
  const revFresh = callCharts('month').body.data.revenueTrend; // 必须重新取快照：上面刚插入了探针订单
  const revTotal = db.prepare(`
    SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount, 0)), 0) AS s
    FROM orders
    WHERE status IN ('paid', 'refunded')
      AND date(paid_at / 1000, 'unixepoch', 'localtime') >= ?
      AND date(paid_at / 1000, 'unixepoch', 'localtime') <= ?
  `).get(firstStr, todayStr).s;
  const revSum = revFresh.current.reduce((a, b) => a + b, 0);
  rec('30 天逐日营收之和 = 独立重算总量（含退款冲减）', revSum === revTotal,
    `sum(current)=${revSum} sqlTotal=${revTotal} 区间=[${firstStr}..${todayStr}]`);
  // 非平凡性自证：夹具里确实存在已退金额 > 0 的订单，否则上面那条对「退款冲减」没有约束力。
  const refundedOrders = db.prepare(
    "SELECT COUNT(*) c FROM orders WHERE status IN ('paid','refunded') AND COALESCE(refunded_amount,0) > 0"
  ).get().c;
  rec('夹具存在已退款订单（退款冲减口径可判别）', refundedOrders > 0, `refunded_orders=${refundedOrders}`);

  // (2) 今日营收桶精确增量：插入唯一金额的已付订单，今日桶必须恰好增加该金额。
  //     捕获：把今日订单算到别的桶、或桶序整体错位一天。
  const baseCurToday = revFresh.current[29];
  const basePrevToday = revFresh.prev[29];
  mkPaidOrderAt(JSON.stringify([{ itemType: 'membershipCard', itemName: '营收探针', quantity: 1 }]), 4321, Date.now());
  const rev2 = callCharts('month').body.data.revenueTrend;
  rec('今日营收桶精确 +4321（归日窗口未偏移）', rev2.current[29] === baseCurToday + 4321,
    `before=${baseCurToday} after=${rev2.current[29]}`);
  rec('插入今日订单不污染「30 天前」对照桶', rev2.prev[29] === basePrevToday,
    `before=${basePrevToday} after=${rev2.prev[29]}`);

  // (3) 30 天前对照桶精确增量：证明 prev 序列是真实上月数据，不是恒 0 的摆设。
  mkPaidOrderAt(JSON.stringify([{ itemType: 'membershipCard', itemName: '对照探针', quantity: 1 }]), 777,
    Date.now() - 30 * 86400000);
  const rev3 = callCharts('month').body.data.revenueTrend;
  rec('「30 天前」对照桶精确 +777', rev3.prev[29] === basePrevToday + 777,
    `before=${basePrevToday} after=${rev3.prev[29]}`);

  // (4) 到场率逐日序列 = 独立重算值。用测试自己的 SQL 统计每日 present/late/absent，
  //     套 attendanceRate 公式算出整条期望序列，与接口逐值比对。
  //     捕获：迟到被漏计、absent 未进分母、leave 被错误计入分母、按天聚合串行。
  //     先插入探针考勤，确保 late / absent 两条分支真的被走到（seed 今日只有 present/late）。
  //     attendances 对 schedules(id) / students(id) 有外键，且 UNIQUE(schedule_id, student_id)，
  //     故建一条探针排期 + 复用夹具里 5 个真实学员，各写一行不同状态的考勤。
  const probeSchId = gen('SCH_CHART_');
  db.prepare(`INSERT INTO schedules (id, course_id, course_name, teacher_id, date, start_time, end_time, status, created_at, updated_at)
    VALUES (?, 'course_001', '图表探针课', 'teacher_001', ?, '00:00', '00:01', 'scheduled', ?, ?)`)
    .run(probeSchId, todayStr, Date.now(), Date.now());
  const insProbeAtt = db.prepare(`INSERT INTO attendances
      (id, schedule_id, student_id, student_name, course_id, course_name, status, checkin_method, date, created_at, updated_at)
    VALUES (?, ?, ?, '图表探针', 'course_001', '图表探针课', ?, 'probe', ?, ?, ?)`);
  const attProbeIds = [];
  const probePlan = [['stu_001', 'present'], ['stu_002', 'present'], ['stu_003', 'present'],
    ['stu_004', 'late'], ['stu_005', 'absent']];
  for (const [stuId, status] of probePlan) {
    const id = gen('ATT_CHART_');
    insProbeAtt.run(id, probeSchId, stuId, status, todayStr, Date.now(), Date.now());
    attProbeIds.push(id);
  }
  const dayRows = db.prepare(`
    SELECT date,
           COALESCE(SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END), 0) AS p,
           COALESCE(SUM(CASE WHEN status = 'late'    THEN 1 ELSE 0 END), 0) AS l,
           COALESCE(SUM(CASE WHEN status = 'absent'  THEN 1 ELSE 0 END), 0) AS a
    FROM attendances WHERE date >= ? AND date <= ? GROUP BY date
  `).all(firstStr, todayStr);
  const dayMap = new Map(dayRows.map((r) => [r.date, r]));
  const expectRates = [];
  for (let i = 0; i < 30; i++) {
    const ds = formatDate(Date.now() - (29 - i) * 86400000);
    const r = dayMap.get(ds);
    expectRates.push(r ? attendanceRate({ present: r.p, late: r.l, absent: r.a }) : 0);
  }
  const attNow = callCharts('month').body.data.attendanceTrend;
  rec('30 天到场率逐日序列 = 独立重算（迟到计到场 / 请假不进分母）',
    JSON.stringify(attNow.data) === JSON.stringify(expectRates),
    `got=${JSON.stringify(attNow.data)} expected=${JSON.stringify(expectRates)}`);
  // 非平凡性自证：若期望序列全 0，上面的逐值比对就退化成「全 0 = 全 0」的恒真断言。
  const todayExpect = expectRates[29];
  rec('到场率期望值非平凡（0 < 今日期望 < 100）', todayExpect > 0 && todayExpect < 100,
    `todayExpect=${todayExpect}（探针含 3 present + 1 late + 1 absent）`);

  for (const id of attProbeIds) db.prepare('DELETE FROM attendances WHERE id = ?').run(id);
  db.prepare('DELETE FROM schedules WHERE id = ?').run(probeSchId);
}

// ============================================================
// 三、产品销量：两种 items 编码形态都要按真实项目名归类
// ============================================================
console.log('\n\x1b[1m[三] 产品销量的 items 编码兼容\x1b[0m');
{
  const uniq = Math.random().toString(36).slice(2, 6);
  const stdName = `标准形态卡_${uniq}`;
  const dblName = `双重编码卡_${uniq}`;

  // 场景 A：标准形态（数组元素为对象）
  mkPaidOrder(JSON.stringify([{ itemType: 'membershipCard', itemName: stdName, quantity: 2 }]));
  // 场景 B：双重编码形态（数组元素为 JSON 字符串）—— 历史数据实际存在的形态
  const dblId = mkPaidOrder(JSON.stringify([JSON.stringify({ itemType: 'membershipCard', itemName: dblName, quantity: 3 })]));

  // 判别性自证：复刻旧实现的读取方式，证明它取不到 itemName
  const raw = db.prepare('SELECT items FROM orders WHERE id = ?').get(dblId).items;
  let oldSeen;
  for (const item of JSON.parse(raw)) oldSeen = item.itemName || '其他';
  rec('旧口径读取把双重编码行判为「其他」（证明归类断言非恒真）', oldSeen === '其他', `旧口径得到=${oldSeen}`);

  const sales = callCharts('month').body.data.productSales;
  const std = sales.find((p) => p.name === stdName);
  const dbl = sales.find((p) => p.name === dblName);
  rec('标准形态按真实项目名归类且数量正确', !!std && std.count === 2, `得到=${JSON.stringify(std)}`);
  rec('双重编码形态按真实项目名归类（不再落入「其他」）', !!dbl && dbl.count === 3, `得到=${JSON.stringify(dbl)}`);
  rec('「其他」不再吸收双重编码行的销量', !sales.some((p) => p.name === '其他' && p.count >= 3),
    `productSales=${JSON.stringify(sales)}`);
}

// ============================================================
// 四、非法 / 非数组 items 不得拖垮接口
// ============================================================
console.log('\n\x1b[1m[四] 非法明细的护栏\x1b[0m');
{
  mkPaidOrder('garbage-not-json');
  mkPaidOrder('{"notAnArray":true}');
  mkPaidOrder('null');

  let res, err = null;
  try { res = callCharts('month'); } catch (e) { err = e; }
  // 缺护栏时 json_each('garbage-not-json') 会抛 malformed JSON，整条查询失败 → 接口 500。
  // 取字段一律走可选链：护栏缺失时 body 为 null，直接点号取值会让本套件以 TypeError 崩掉，
  // 反而掩盖掉真正的失败项（缺陷注入时实测踩到）。
  const body = res && res.body ? res.body.data : null;
  rec('含非法/非数组明细时接口仍返回 200（护栏生效）', !err && !!res && res.statusCode === 200,
    err ? `抛错=${err.message}` : `status=${res && res.statusCode}`);
  rec('护栏不影响正常聚合（返回结构完整）',
    !err && Array.isArray(body && body.productSales) && body.productSales.length > 0,
    err ? `抛错=${err.message}` : `productSales=${JSON.stringify(body && body.productSales)}`);
}

// ============================================================
// 五、F1 看板「本月购买项目统计」金额口径 + F2 非法元素的页面级护栏
// ============================================================
// 判别性（逐条都能证明旧实现给出不同结果）：
//   · F1 金额：旧实现 SUM(o.payable_amount) 在 json_each 展开后把**整单金额按明细条数
//     重复累加**。下面 n1 同时出现在「单明细 1000」与「双明细 1000」两张单里，
//     正确值 1000+600=1600，旧口径为 1000+1000=2000 —— 断言同时钉住 1600 且排除 2000。
//   · F1 count：旧实现 COUNT(DISTINCT o.id) 是「笔数」，与 /export、/charts 的
//     「件数（Σ quantity）」口径不一致；这里用 quantity=2 的双重编码单钉住件数=2。
//   · F1 护栏：旧实现对非法元素直接 json_extract 会抛 malformed JSON，被外层 try/catch
//     吞掉 → itemStats 变成**空数组**（统计整块静默消失）。故断言 itemStats 非空。
//   · F2：同一份数据下 /charts 在旧实现里整条查询失败 → 500（整个图表页挂掉）。
console.log('\n\x1b[1m[五] F1 看板单品金额/件数口径 + F2 非法元素护栏\x1b[0m');
{
  const u = Math.random().toString(36).slice(2, 6);
  const n1 = `F1单卡_${u}`;
  const n2 = `F1双卡_${u}`;
  const n3 = `F1双重编码_${u}`;
  const n4 = `F1折扣卡_${u}`;

  // 数量刻意放大：看板 itemStats 有 LIMIT 5，而前面几节已往本月塞了不少探针订单，
  // 夹具件数必须稳稳排在 Top5 内，否则断言会因截断而假红（与聚合逻辑无关）。
  // 夹具数量统一放大 ×10：看板 itemStats 为 Top5（ORDER BY 件数 DESC），而种子数据本月
  // 已有「时效月卡 5 件 / 时效季卡 4 件」，原夹具的 n2=4 件会被挤出 Top5 造成假红
  //（与本用例聚合逻辑无关，纯截断）。放大后各断言按同比例更新，语义（跨单合并 / 件数口径 /
  // 不按明细条数放大 / 折扣毛口径）完全不变。
  // 订单1：单明细 10000（100 件 × 100）
  mkPaidOrder(JSON.stringify([{ itemName: n1, quantity: 100, unitPrice: 100, totalPrice: 10000 }]), 10000);
  // 订单2：双明细，n1 占 6000（60 件）、n2 占 4000（40 件），整单实付 10000
  mkPaidOrder(JSON.stringify([
    { itemName: n1, quantity: 60, unitPrice: 100, totalPrice: 6000 },
    { itemName: n2, quantity: 40, unitPrice: 100, totalPrice: 4000 },
  ]), 10000);
  // 订单3：双重编码，quantity=70 → 件数应为 70
  mkPaidOrder(JSON.stringify([JSON.stringify({ itemName: n3, quantity: 70, unitPrice: 100, totalPrice: 7000 })]), 7000);
  // 订单4：折扣单（标价 10000 / 实付 8000）——单品统计刻意保留毛口径
  {
    const ts = Date.now();
    const id = gen('ORD_F1DISC_');
    db.prepare(`INSERT INTO orders (id, order_no, student_id, student_name, order_type, items,
        total_amount, discount_amount, payable_amount, status, paid_at, refunded_amount, created_at, updated_at)
      VALUES (?, ?, 'stu_chart_probe', '图表探针', 'membership', ?, 10000, 2000, 8000, 'paid', ?, 0, ?, ?)`)
      .run(id, gen('F1D'), JSON.stringify([{ itemName: n4, quantity: 50, unitPrice: 200, totalPrice: 10000 }]), ts, ts, ts);
    created.push(id);
  }
  // 订单5：合法数组 + 非法元素（旧实现下这一行会让整块统计抛错/整个图表页 500）
  mkPaidOrder(JSON.stringify(['篮球季卡']), 300);

  const dash = mockRes();
  getHandler(adminRouter, 'get', '/dashboard')({ query: {}, headers: {}, userRole: '' }, dash);
  const dashBody = dash.body && dash.body.data;
  const itemStats = (dashBody && dashBody.sales && dashBody.sales.itemStats) || [];
  const byItem = {};
  for (const it of itemStats) byItem[it.itemName] = it;

  rec('看板在含非法元素时仍返回 200', dash.statusCode === 200, `status=${dash.statusCode}`);
  // 旧实现：非法元素让 SQL 抛错 → catch 吞掉 → itemStats 为空数组（整块静默消失）
  rec('itemStats 非空（非法元素不再让整块统计静默消失）', itemStats.length > 0, `len=${itemStats.length}`);

  const a1 = byItem[n1];
  rec('F1 同一单品跨「单明细 + 双明细」两单的金额 = 10000 + 6000 = 16000',
    !!a1 && a1.amount === 16000, `got=${JSON.stringify(a1)}`);
  rec('F1 金额不再按明细条数放大（旧口径为 20000 = 两张整单金额相加）',
    !!a1 && a1.amount !== 20000, `got=${JSON.stringify(a1)}`);
  rec('F1 count 为件数：n1 跨两单 100 + 60 = 160 件（旧口径为笔数 2）',
    !!a1 && a1.count === 160, `got=${JSON.stringify(a1)}`);
  rec('F1 双明细单的另一项金额 = 4000（旧口径为整单 10000）',
    !!byItem[n2] && byItem[n2].amount === 4000 && byItem[n2].count === 40, `got=${JSON.stringify(byItem[n2])}`);
  rec('F1 count 改为件数：双重编码 quantity=70 → count=70（旧口径为笔数 1）',
    !!byItem[n3] && byItem[n3].count === 70 && byItem[n3].amount === 7000, `got=${JSON.stringify(byItem[n3])}`);
  rec('F1 折扣单按标价毛口径记 10000（与 CSV 导出单品金额同口径）',
    !!byItem[n4] && byItem[n4].amount === 10000 && byItem[n4].count === 50, `got=${JSON.stringify(byItem[n4])}`);

  // /charts 同一份数据：旧实现直接对非法元素 json_extract → 整条查询抛 malformed JSON → 500
  const ch = callCharts('month');
  rec('F2 /charts 在 items=["篮球季卡"] 存在时返回 200（旧实现整页 500）',
    ch.statusCode === 200 && !!(ch.body && ch.body.data), `status=${ch.statusCode}`);
  const ps = (ch.body && ch.body.data && ch.body.data.productSales) || [];
  const psByName = {};
  for (const p of ps) psByName[p.name] = p;
  rec('F2 合法项在非法元素存在时仍按真实项目名归类（n1 件数=160）',
    !!psByName[n1] && psByName[n1].count === 160, `got=${JSON.stringify(psByName[n1])}`);
  rec('F2 非法元素降级进「其他」桶（件数 1），不再拖垮接口',
    !!psByName['其他'] && psByName['其他'].count >= 1, `got=${JSON.stringify(psByName['其他'])}`);
}

// ============================================================
// 收尾清理（仅测试库）
// ============================================================
for (const id of created) db.prepare('DELETE FROM orders WHERE id = ?').run(id);

console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
