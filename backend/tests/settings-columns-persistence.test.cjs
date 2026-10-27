/**
 * 设置列配置持久化回归测试（离线，隔离库）
 *
 * 覆盖 Task B #50 的「表格列配置 * _columns 持久化」：
 *  1) growth/trial/finance/students/orders 五类 *_columns 经 PUT /api/settings 落库，
 *     GET /api/settings 能原样读回（后端白名单已包含这五个键，此前缺失导致写入被静默忽略）。
 *  2) PUT 是「按提供的键 upsert」语义：仅保存 students_columns 不会抹掉此前已存的 growth_columns
 *     （覆盖语义写回会丢其他键的问题由前端 read-merge-write 兜底，后端则保证键级隔离）。
 *  3) 白名单之外、或用于越权的键（如 evil_key）被忽略，不入库也不回显。
 *  4) 非管理员（userRole=coach/sales）PUT 返回 403。
 *
 * 运行：node tests/settings-columns-persistence.test.cjs
 */
process.env.DB_PATH = '/tmp/settings_columns_test.db';
process.env.NODE_ENV = 'test';
process.env.FORCE_PASSWORD_CHANGE = '0';

const fs = require('fs');
for (const f of ['/tmp/settings_columns_test.db', '/tmp/settings_columns_test.db-wal', '/tmp/settings_columns_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const settingsRouter = require('../routes/settings').router;

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

const t = Date.now();
db.transaction(() => {
  db.prepare('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)')
    .run('u_admin', 'admin_x', '管理员', 'admin', 'x', 'active', '', t, t);
  db.prepare('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)')
    .run('u_sales', 'sales_x', '销售', 'sales', 'x', 'active', '', t, t);
})();

// isAdminReq 的真实判定：req.userRole==='admin' 或 openid 在库中为 admin。
// 因此「非管理员」场景必须用非 admin 的 openid，仅靠 userRole 会被 openid 兜底覆盖。
const putSettings = (body, openid = 'admin_x') => {
  const h = getHandler(settingsRouter, 'put', '/');
  const r = mockRes();
  h(mockReq({ openid, body }), r);
  return r;
};
const getSettings = (openid = 'admin_x') => {
  const h = getHandler(settingsRouter, 'get', '/');
  const r = mockRes();
  h(mockReq({ openid }), r);
  return r.body && r.body.data;
};

console.log('\n\x1b[1m=== 设置列配置持久化回归测试 ===\x1b[0m\n');

// ===== [1] 各类 *_columns 可落库并读回 =====
console.log('\x1b[1m[1] *_columns 持久化与读回\x1b[0m');
{
  const g = { order: ['name', 'phone'], widths: { name: 120 }, autoColumnWidth: false };
  const put = putSettings({ growth_columns: g });
  rec('★ PUT growth_columns 成功', put.statusCode === 200, `status=${put.statusCode}`);
  const got = getSettings();
  rec('★ GET 原样读回 growth_columns', JSON.stringify(got.growth_columns) === JSON.stringify(g), JSON.stringify(got.growth_columns));
  rec('growth_columns 含 order/widths/autoColumnWidth',
    got.growth_columns && Array.isArray(got.growth_columns.order) && got.growth_columns.widths && got.growth_columns.autoColumnWidth === false,
    JSON.stringify(got.growth_columns));

  // trial / finance 同源，确认白名单覆盖另外两个 v1.0.7 键
  putSettings({ trial_columns: { order: ['a'] } });
  putSettings({ finance_columns: { order: ['b'] } });
  const got2 = getSettings();
  rec('trial_columns 读回', got2.trial_columns && got2.trial_columns.order[0] === 'a', JSON.stringify(got2.trial_columns));
  rec('finance_columns 读回', got2.finance_columns && got2.finance_columns.order[0] === 'b', JSON.stringify(got2.finance_columns));
}

// ===== [2] 键级 upsert 不互相抹除 =====
console.log('\n\x1b[1m[2] 仅保存 students_columns 不抹掉 growth_columns\x1b[0m');
{
  const before = getSettings();
  const hadGrowth = !!before.growth_columns;
  const put = putSettings({ students_columns: { order: ['x', 'y'] } });
  rec('PUT students_columns 成功', put.statusCode === 200, `status=${put.statusCode}`);
  const after = getSettings();
  rec('★ growth_columns 仍在（未被覆盖写回抹除）', hadGrowth && !!after.growth_columns, JSON.stringify(after.growth_columns));
  rec('students_columns 读回', after.students_columns && after.students_columns.order.join(',') === 'x,y', JSON.stringify(after.students_columns));
}

// ===== [3] 白名单之外/越权键被忽略 =====
console.log('\n\x1b[1m[3] 白名单之外键被忽略\x1b[0m');
{
  putSettings({ evil_key: { poke: 1 } });
  const row = db.prepare("SELECT key FROM settings WHERE key = 'evil_key'").get();
  rec('★ 非法键 evil_key 未入库', !row, JSON.stringify(row));
  const got = getSettings();
  rec('GET 不回显 evil_key', !('evil_key' in (got || {})), JSON.stringify(Object.keys(got || {}).filter((k) => k === 'evil_key')));
}

// ===== [4] 非管理员写入被拒 =====
console.log('\n\x1b[1m[4] 非管理员 PUT 403\x1b[0m');
{
  const r = putSettings({ growth_columns: { order: ['z'] } }, 'sales_x');
  rec('★ userRole=sales 的 PUT 返回 403', r.statusCode === 403, `status=${r.statusCode}`);
}

console.log(`\n\x1b[1m结果：${pass} PASS / ${fail} FAIL\x1b[0m`);
process.exit(fail ? 1 : 0);
