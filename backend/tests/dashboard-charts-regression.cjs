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
  const ts = Date.now();
  const id = gen('ORD_CHART_');
  db.prepare(`INSERT INTO orders (id, order_no, student_id, student_name, order_type, items,
      total_amount, discount_amount, payable_amount, status, paid_at, refunded_amount, created_at, updated_at)
    VALUES (?, ?, 'stu_chart_probe', '图表探针', 'membership', ?, ?, 0, ?, 'paid', ?, 0, ?, ?)`)
    .run(id, gen('CHART'), itemsRaw, payable, payable, ts, ts, ts);
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
  rec('到场率均为 0-100 的整数', att.data.every((v) => Number.isInteger(v) && v >= 0 && v <= 100),
    `样本=${JSON.stringify(att.data.slice(0, 5))}`);
  rec('营收均为非负数字', [...rev.current, ...rev.prev].every((v) => typeof v === 'number' && v >= 0),
    `样本=${JSON.stringify(rev.current.slice(-3))}`);
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
// 收尾清理（仅测试库）
// ============================================================
for (const id of created) db.prepare('DELETE FROM orders WHERE id = ?').run(id);

console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
