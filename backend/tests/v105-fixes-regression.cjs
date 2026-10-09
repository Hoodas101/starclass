/**
 * v1.0.6 修复项回归测试（离线，隔离库）
 *
 * 覆盖审计报告 2026-10-08 的后端 P0：
 *  1) 金额宽松解析：台账金额列混用「199 / ¥199.00 / ￥29.90 / ¥2,699.00 / 199元」时不再整行失败，
 *     失败时错误文案回显原值（用户才知道是哪个写法不被接受）。
 *  2) 购买日期三格式：Excel 序列号 / 美式 M/D/YY / ISO 非零填充；解析失败**不再静默回退为当前时间**。
 *  3) join_date 文本形态：TEXT 列绑数字会被 SQLite REAL 亲和写成 '...0'（前端解析失败整列显示 `-`），
 *     建档与导入路径必须写纯整数文本。
 *
 * 运行：node tests/v105-fixes-regression.cjs
 */
process.env.DB_PATH = '/tmp/v105_fixes_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/v105_fixes_test.db', '/tmp/v105_fixes_test.db-wal', '/tmp/v105_fixes_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now, normalizeDateInput } = require('../utils');
const ordersRouter = require('../routes/orders');
const studentsRouter = require('../routes/students');

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
function mockReq(o) {
  return Object.assign({ headers: {}, params: {}, query: {}, body: {}, userRole: '', openid: '' }, o);
}
let passed = 0, failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${ok ? '' : '  -> ' + detail}`);
}

const t = now();
const seed = db.transaction(() => {
  const ins = (sql, ...p) => db.prepare(sql).run(...p);
  ins('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_admin', 'admin_x', '管理员', 'admin', 'x', 'active', '', t, t);
  ins('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_sales', 'sales_x', '销售X', 'sales', 'x', 'active', '', t, t);
  ins('INSERT INTO students (id, name, status, created_at, updated_at) VALUES (?,?,?,?,?)', 'stu_a', '导入学员A', 'active', t, t);
});
seed();

console.log('\n\x1b[1m=== v1.0.6 修复项回归测试 ===\x1b[0m\n');

// [1] 购买日期三格式（normalizeDateInput 单元）
console.log('\x1b[1m[1] 购买日期三格式\x1b[0m');
{
  const cases = [
    ['2026/1/1', '2026-01-01'],
    ['1/24/26', '2026-01-24'],
    ['46023', '2026-01-01'],        // Excel 序列号，基准 1899-12-30
    ['2018-02-30', null],           // 不存在的日期必须拒绝
    ['abc', null],
  ];
  for (const [inp, exp] of cases) {
    const r = normalizeDateInput(inp);
    const got = r.ok ? r.value : null;
    rec(`日期「${inp}」→ ${exp || '拒绝'}`, got === exp, `got=${got} reason=${r.reason || ''}`);
  }
}

// [2] 订单导入：金额脏格式与日期
console.log('\n\x1b[1m[2] 订单导入：金额与日期\x1b[0m');
{
  const imp = getHandler(ordersRouter, 'post', '/import');
  const run = (rows) => { const r = mockRes(); imp(mockReq({ userRole: 'sales', openid: 'sales_x', body: { rows } }), r); return r.body && r.body.data; };

  const money = [
    ['199', true],
    ['¥199.00', true],
    ['￥29.90', true],
    ['¥2,699.00', true],
    ['199元', true],
    ['(100.00)', false],   // 会计负数：解析成功但 ≤0 → 拒绝
    ['abc', false],
  ];
  for (const [amount, ok] of money) {
    const d = run([{ studentName: '导入学员A', itemName: '未知项目', amount }]);
    const pass = ok ? d.success === 1 : d.failed.length === 1;
    rec(`金额「${amount}」→ ${ok ? '接受' : '拒绝'}`, pass, `success=${d.success} failed=${JSON.stringify(d.failed)}`);
    if (!ok && d.failed.length) {
      const msg = d.failed[0].reason || '';
      if (amount === 'abc') rec('  拒绝文案回显原值', msg.includes('abc'), `msg=${msg}`);
    }
  }

  // 日期：三种写法都要落到正确日期，非法日期必须让该行失败（不再静默回退为当前时间）
  const byDate = (pd) => {
    const d = run([{ studentName: '导入学员A', itemName: '未知项目', amount: 100, paidDate: pd }]);
    if (d.success !== 1) return { fail: d.failed };
    // 用 rowid 取最后插入行：同一毫秒内连续建单时 created_at 相同，按它排序结果不确定
    const row = db.prepare("SELECT paid_at FROM orders WHERE student_id = 'stu_a' ORDER BY rowid DESC LIMIT 1").get();
    return { ts: row && row.paid_at };
  };
  const d1 = byDate('2026/1/1');
  rec('日期「2026/1/1」落库为 2026-01-01', d1.ts && new Date(d1.ts).getFullYear() === 2026 && new Date(d1.ts).getMonth() === 0 && new Date(d1.ts).getDate() === 1, `ts=${d1.ts}`);
  const d2 = byDate('1/24/26');
  rec('日期「1/24/26」（美式）落库为 2026-01-24', d2.ts && new Date(d2.ts).getMonth() === 0 && new Date(d2.ts).getDate() === 24, `ts=${d2.ts}`);
  const d3 = byDate('46023');
  rec('日期「46023」（Excel 序列号）落库为 2026-01-01', d3.ts && new Date(d3.ts).getFullYear() === 2026 && new Date(d3.ts).getMonth() === 0 && new Date(d3.ts).getDate() === 1, `ts=${d3.ts}`);
  const d4 = byDate('不是日期');
  rec('★ 非法日期不再静默回退为当前时间（该行入 failed）', Array.isArray(d4.fail) && d4.fail.length === 1, `fail=${JSON.stringify(d4.fail)}`);
}

// [3] join_date 文本形态（TEXT 列不得写入 '...0'）
console.log('\n\x1b[1m[3] join_date 文本形态\x1b[0m');
{
  const create = getHandler(studentsRouter, 'post', '/');
  const r = mockRes();
  create(mockReq({ userRole: 'admin', openid: 'admin_x', body: { name: '建档时间测试', phone: '13700008888' } }), r);
  const sid = r.body && r.body.data && r.body.data.id;
  const row = sid ? db.prepare('SELECT join_date FROM students WHERE id = ?').get(sid) : null;
  rec('★ 建档 join_date 为纯整数文本（无 .0）', !!row && /^\d{10,}$/.test(String(row.join_date)), `join_date=${row && row.join_date}`);

  // 导入路径同样
  const imp = getHandler(studentsRouter, 'post', '/import');
  const r2 = mockRes();
  imp(mockReq({ userRole: 'admin', openid: 'admin_x', body: { rows: [{ name: '导入时间测试', joinDate: '2026-01-05' }] } }), r2);
  const row2 = db.prepare("SELECT join_date FROM students WHERE name = '导入时间测试'").get();
  rec('★ 导入 join_date 为纯整数文本（无 .0）', !!row2 && /^\d{10,}$/.test(String(row2.join_date)), `join_date=${row2 && row2.join_date}`);
  rec('导入 join_date 落在指定日期（2026-01-05）',
    !!row2 && new Date(Number(row2.join_date)).getFullYear() === 2026 && new Date(Number(row2.join_date)).getMonth() === 0 && new Date(Number(row2.join_date)).getDate() === 5,
    `join_date=${row2 && row2.join_date}`);
}

console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
