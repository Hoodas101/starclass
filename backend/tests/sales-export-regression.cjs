/**
 * P1-18 回归测试 —— 销售导出（/api/admin/export?type=sales）单品统计的正确性
 *
 * 原始缺陷（两处同源、P1-13 之后同一类数据缺陷在导出路径的重现）：
 *   1. 金额恒为 0：用不存在的字段 i.price（规范字段是 itemType/itemId/itemName/
 *      quantity/unitPrice/totalPrice）。`Number(i.price || 0)` 永远为 0。
 *   2. 双重编码误归：历史订单 items 是「JSON 字符串数组」，JSON.parse 后得到字符串，
 *      逐项取 i.itemName 恒为 undefined，真实单品被整批计入「未命名产品」，且金额 0。
 *   3. 计数口径：原 `count += 1` 按行项计；现改为按件数 += quantity（与看板一致）。
 *
 * 判别性说明（每条断言都先证明旧实现给出不同结果）：
 *   - 季卡(amount=5998, count=2)：旧实现 amount=0、count=1 → 断言必然失败。
 *   - 年卡(双重编码)amount=9999、且按真实名归类：旧实现归为「未命名产品」amount=0 → 必然失败。
 *   - 用例内额外跑「旧口径读取」自证：旧式 Number(i.price||0) 对受控数据恒为 0，
 *     从而证明本断言能甄别回归，而非恒真。
 *
 * 运行：node tests/sales-export-regression.cjs
 */
'use strict';

const { bootstrap } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-sales');

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
const created = [];

/** 插入一张已支付订单；itemsRaw 可为任意形态（对象数组 / 双重编码字符串数组 / 非法值） */
function mkPaidOrder(itemsRaw) {
  const ts = Date.now();
  const id = gen('ORD_SALES_');
  db.prepare(`INSERT INTO orders (id, order_no, student_id, student_name, order_type, items,
      total_amount, discount_amount, payable_amount, status, paid_at, refunded_amount, created_at, updated_at)
    VALUES (?, ?, 'stu_sales_probe', '导出探针', 'membership', ?, 5998, 0, 5998, 'paid', ?, 0, ?, ?)`)
    .run(id, gen('SALES'), itemsRaw, ts, ts, ts);
  created.push(id);
  return id;
}

console.log('\n\x1b[1m=== P1-18 销售导出单品统计回归测试 ===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '（seed 夹具）\n');

// 受控数据：用唯一前缀名，确保不被 seed 夹具里的同名订单污染（P1-13 同款隔离手法）。
//  (a) 普通对象数组：季卡 ×2，单品 totalPrice=5998（即该订单整单金额）
//  (b) 双重编码：数组里装 JSON 字符串，年卡 ×1，totalPrice=9999
const uniq = Math.random().toString(36).slice(2, 6);
const stdName = `QA季卡_${uniq}`;
const dblName = `QA年卡_${uniq}`;
const normalItems = JSON.stringify([
  { itemName: stdName, quantity: 2, unitPrice: 2999, totalPrice: 5998 },
]);
const doubleEncodedItems = JSON.stringify([
  JSON.stringify({ itemName: dblName, quantity: 1, unitPrice: 9999, totalPrice: 9999 }),
]);
mkPaidOrder(normalItems);
mkPaidOrder(doubleEncodedItems);

function callExport() {
  const res = mockRes();
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  getHandler(adminRouter, 'get', '/export')({
    query: { type: 'sales', startDate: '1970-01-01', endDate: `${y}-${m}-${d}` },
  }, res);
  return res;
}

const res = callExport();
const body = res && res.body ? res.body.data : null;
const itemStats = body && body.itemStats ? body.itemStats : (body && body.data ? body.data.itemStats : null);
const byName = {};
if (Array.isArray(itemStats)) for (const it of itemStats) byName[it.itemName] = it;

rec('导出接口返回 200 且含 data 主体', res && res.statusCode === 200 && !!body, `status=${res && res.statusCode}`);
rec('导出含 itemStats 数组', Array.isArray(itemStats), `type=${typeof itemStats}`);

// 判别核心 1：季卡金额不再是 0，而是真实 totalPrice；计数按件数
rec(`季卡(${stdName}) amount === 5998（修复前恒为 0）`, byName[stdName] && byName[stdName].amount === 5998,
  `got=${byName[stdName] && byName[stdName].amount}`);
rec(`季卡(${stdName}) count === 2（按件数，修复前为 1）`, byName[stdName] && byName[stdName].count === 2,
  `got=${byName[stdName] && byName[stdName].count}`);

// 判别核心 2：双重编码按真实名归类，不再落入「未命名产品」，金额正确
rec(`年卡(${dblName})被按真实名归类（非「未命名产品」）`, !!byName[dblName], `keys=${Object.keys(byName).join(',')}`);
rec(`年卡(${dblName}) amount === 9999`, byName[dblName] && byName[dblName].amount === 9999,
  `got=${byName[dblName] && byName[dblName].amount}`);
rec(`年卡(${dblName}) count === 1`, byName[dblName] && byName[dblName].count === 1,
  `got=${byName[dblName] && byName[dblName].count}`);

// 自证：旧口径（Number(i.price||0)）对同样的受控数据恒为 0 —— 证明本断言能甄别回归
const oldSum = (() => {
  let s = 0;
  for (const raw of [normalItems, doubleEncodedItems]) {
    let arr; try { arr = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      let i = x;
      if (typeof x === 'string') { try { i = JSON.parse(x); } catch { i = {}; } }
      s += Number((i && i.price) || 0);
    }
  }
  return s;
})();
rec('自证：旧口径对受控数据金额恒为 0（证明断言可甄别回归）', oldSum === 0, `oldSum=${oldSum}`);

// 清理受控订单（/tmp 库会随进程退出由 bootstrap 删除，此处仅为干净）
for (const id of created) { try { db.prepare('DELETE FROM orders WHERE id = ?').run(id); } catch (e) {} }

console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
