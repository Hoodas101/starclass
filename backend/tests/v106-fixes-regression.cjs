/**
 * v1.0.7 修复项回归测试（离线，隔离库）
 *
 * 覆盖审计报告 2026-10-16 的后端项：
 *  1) P0-1 学员导入生日/入会日期走宽松解析（M/D/YY、YYYY/M/D、Excel 序列号），
 *     归一为 YYYY-MM-DD；「格式可识别但日期不存在」（2018-02-30）仍拦截。
 *  2) P1-3 导入状态中文 → 系统枚举映射；未知值记 warning 并回落 active。
 *  3) P1-4 同家长手机号但姓名不同 = 兄弟姐妹 → 放行建档并记 warning；
 *     手机号与姓名都相同 = 同一人 → 跳过。
 *  4) P1-6 失败提示使用前端传来的原始文件行号（_fileRow）。
 *  5) P2-7 0 元订单可导入；负数仍拒绝。
 *  6) P2-8 批内同收据单号多行 → 追加 -2/-3 后缀全部入账并记 warning；跨批重复 → 跳过。
 *
 * 运行：node tests/v106-fixes-regression.cjs
 */
process.env.DB_PATH = '/tmp/v106_fixes_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/v106_fixes_test.db', '/tmp/v106_fixes_test.db-wal', '/tmp/v106_fixes_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
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
const mockRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
};
const mockReq = (o) => Object.assign({ headers: {}, params: {}, query: {}, body: {}, userRole: '', openid: '' }, o);

let pass = 0, fail = 0;
const rec = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${ok ? '' : '  -> ' + detail}`);
};

const t = now();
db.transaction(() => {
  const ins = (sql, ...p) => db.prepare(sql).run(...p);
  ins('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_admin', 'admin_x', '管理员', 'admin', 'x', 'active', '', t, t);
})();

const importStudents = (rows) => {
  const h = getHandler(studentsRouter, 'post', '/import');
  const r = mockRes();
  h(mockReq({ userRole: 'admin', openid: 'admin_x', body: { rows } }), r);
  return r.body && r.body.data;
};
const importOrders = (rows) => {
  const h = getHandler(ordersRouter, 'post', '/import');
  const r = mockRes();
  h(mockReq({ userRole: 'admin', openid: 'admin_x', body: { rows } }), r);
  return r.body && r.body.data;
};

console.log('\n\x1b[1m=== v1.0.7 修复项回归测试 ===\x1b[0m\n');

// ===== [1] P0-1 生日 / 入会日期宽松解析 =====
console.log('\x1b[1m[1] P0-1 生日宽松解析\x1b[0m');
{
  const d = importStudents([
    { name: '生日美式', birthday: '5/1/15', _fileRow: 2 },
    { name: '生日斜杠', birthday: '2021/6/17', _fileRow: 3 },
    { name: '生日序列号', birthday: '46023', _fileRow: 4 },
    { name: '生日不存在', birthday: '2018-02-30', _fileRow: 5 },
    { name: '生日标准', birthday: '2018-05-01', _fileRow: 6 },
  ]);
  const bd = (n) => { const r = db.prepare('SELECT birthday FROM students WHERE name = ?').get(n); return r && r.birthday; };
  rec('★ M/D/YY「5/1/15」→ 2015-05-01', bd('生日美式') === '2015-05-01', String(bd('生日美式')));
  rec('★ YYYY/M/D「2021/6/17」→ 2021-06-17', bd('生日斜杠') === '2021-06-17', String(bd('生日斜杠')));
  rec('★ Excel 序列号「46023」→ 2026-01-01', bd('生日序列号') === '2026-01-01', String(bd('生日序列号')));
  rec('标准 YYYY-MM-DD 原样入库', bd('生日标准') === '2018-05-01', String(bd('生日标准')));
  rec('不存在的日期（2018-02-30）被拦截', bd('生日不存在') === undefined, String(bd('生日不存在')));
  rec('失败行带原值提示', d.failed.some((f) => /2018-02-30/.test(f.reason)), JSON.stringify(d.failed));
}

// ===== [2] P1-3 状态映射 =====
console.log('\n\x1b[1m[2] P1-3 状态枚举映射\x1b[0m');
{
  const d = importStudents([
    { name: '状态正常', status: '正常', _fileRow: 2 },
    { name: '状态流失', status: '流失', _fileRow: 3 },
    { name: '状态退款', status: '退款', _fileRow: 4 },
    { name: '状态怪值', status: '某种新状态', _fileRow: 5 },
  ]);
  const st = (n) => { const r = db.prepare('SELECT status FROM students WHERE name = ?').get(n); return r && r.status; };
  rec('「正常」→ active', st('状态正常') === 'active', String(st('状态正常')));
  rec('「流失」→ churn', st('状态流失') === 'churn', String(st('状态流失')));
  rec('「退款」→ refunded', st('状态退款') === 'refunded', String(st('状态退款')));
  rec('★ 未知值回落 active（不写非法值）', st('状态怪值') === 'active', String(st('状态怪值')));
  rec('★ 未知值记 warning 并回显原值',
    d.warnings.some((w) => /某种新状态/.test(w.reason)), JSON.stringify(d.warnings.map((w) => w.reason)));
  // 只有「状态怪值」这一行该产生状态类 warning，合法状态不应打扰
  const statusWarns = d.warnings.filter((w) => /不在系统枚举内/.test(w.reason));
  rec('合法状态不产生多余 warning', statusWarns.length === 1 && statusWarns[0].row === 5, JSON.stringify(statusWarns));
}

// ===== [3] P1-4 兄弟姐妹 vs 同一人 =====
console.log('\n\x1b[1m[3] P1-4 兄弟姐妹放行\x1b[0m');
{
  const d1 = importStudents([{ name: '姐大', phone: '13700001111', _fileRow: 2 }]);
  rec('首位建档成功', d1.success === 1, JSON.stringify(d1.failed));
  const d2 = importStudents([{ name: '弟小', phone: '13700001111', _fileRow: 3 }]);
  rec('★ 同手机号不同姓名 → 放行建档（兄弟姐妹）', d2.success === 1, `success=${d2.success} skipped=${JSON.stringify(d2.skippedRows)}`);
  rec('★ 放行时记 warning 明示', (d2.warnings || []).some((w) => /同一家长手机号/.test(w.reason)), JSON.stringify(d2.warnings));
  const cnt = db.prepare("SELECT COUNT(*) c FROM students WHERE name IN ('姐大','弟小')").get().c;
  rec('两人都在库中', cnt === 2, String(cnt));

  const d3 = importStudents([{ name: '姐大', phone: '13700001111', _fileRow: 4 }]);
  rec('★ 手机号与姓名都相同 → 跳过（同一人）', d3.success === 0 && (d3.skipped || 0) === 1, JSON.stringify(d3.skippedRows));
}

// ===== [4] P1-6 行号回显 =====
console.log('\n\x1b[1m[4] P1-6 文件行号回显\x1b[0m');
{
  const d = importStudents([
    { name: '行号甲', phone: '13800002222', _fileRow: 3 },
    { name: '', _fileRow: 9 },          // 缺姓名 → 应报第 9 行（而不是数组下标 +2 = 3）
  ]);
  rec('★ 失败提示用前端给的原始文件行号（第 9 行）',
    d.failed.some((f) => f.row === 9), JSON.stringify(d.failed));
  rec('后端未收到 _fileRow 时退回 idx+2（兼容旧调用方）',
    (() => { const r = importStudents([{ name: '', _fileRow: undefined }]); return r.failed.some((f) => f.row === 2); })(), '');
}

// ===== [5] P2-7 0 元订单 =====
console.log('\n\x1b[1m[5] P2-7 0 元订单可导入\x1b[0m');
{
  importStudents([{ name: '订单客户', phone: '13900003333' }]);
  const d = importOrders([
    { studentName: '订单客户', itemName: '赠品球服', amount: '¥0.00', paidDate: '2026/3/1', orderNo: 'ZERO001', _fileRow: 2 },
    { studentName: '订单客户', itemName: '体验课', amount: '0', paidDate: '2026/3/2', orderNo: 'ZERO002', _fileRow: 3 },
    { studentName: '订单客户', itemName: '正常单', amount: '199', paidDate: '2026/3/3', orderNo: 'ZERO003', _fileRow: 4 },
    { studentName: '订单客户', itemName: '负数单', amount: '-50', paidDate: '2026/3/4', orderNo: 'ZERO004', _fileRow: 5 },
  ]);
  const zero = db.prepare("SELECT COUNT(*) c FROM orders WHERE payable_amount = 0").get().c;
  rec('★ 0 元订单入库（2 条）', zero === 2, String(zero));
  rec('负数金额被拒绝', d.failed.some((f) => /-50/.test(f.reason) || /不小于 0/.test(f.reason)), JSON.stringify(d.failed));
  rec('正常金额照常入库', db.prepare("SELECT COUNT(*) c FROM orders WHERE order_no = 'ZERO003'").get().c === 1, '');
}

// ===== [6] P2-8 同收据单号多行 =====
console.log('\n\x1b[1m[6] P2-8 同单号多行 → 后缀入账\x1b[0m');
{
  const d = importOrders([
    { studentName: '订单客户', itemName: '项目A', amount: '100', paidDate: '2026/4/1', orderNo: 'DUP001', _fileRow: 2 },
    { studentName: '订单客户', itemName: '项目B', amount: '200', paidDate: '2026/4/1', orderNo: 'DUP001', _fileRow: 3 },
    { studentName: '订单客户', itemName: '项目C', amount: '300', paidDate: '2026/4/1', orderNo: 'DUP001', _fileRow: 4 },
  ]);
  const nos = db.prepare("SELECT order_no FROM orders WHERE order_no LIKE 'DUP001%' ORDER BY order_no").all().map((r) => r.order_no);
  rec('★ 三行全部入账并追加后缀', nos.length === 3 && nos.includes('DUP001') && nos.includes('DUP001-2') && nos.includes('DUP001-3'), JSON.stringify(nos));
  rec('★ 后缀行记 warning 说明', (d.warnings || []).some((w) => /DUP001-2/.test(w.reason)), JSON.stringify(d.warnings));

  const d2 = importOrders([
    { studentName: '订单客户', itemName: '项目A', amount: '100', paidDate: '2026/4/1', orderNo: 'DUP001', _fileRow: 2 },
  ]);
  rec('★ 跨批重复导入 → 跳过并明示（不再静默）',
    d2.success === 0 && (d2.skipped || 0) === 1, `success=${d2.success} skipped=${d2.skipped} rows=${JSON.stringify(d2.skippedRows)}`);
}

console.log(`\n\x1b[1m结果汇总：PASS ${pass}  FAIL ${fail}\x1b[0m`);
db.close();
process.exit(fail > 0 ? 1 : 0);
