/**
 * getProfile 自定义权限保真 回归测试（离线，隔离库）
 *
 * 原始缺陷：GET /api/auth/getProfile 的 SELECT 精简列漏了 permissions，
 * resolvePerms(user) 因 user.permissions === undefined 永远回退到角色默认权限。
 * Web store/user.js 与小程序 app.js refreshProfile 都在冷启动时采信该返回值，
 * 于是管理员在团队管理里为每个员工配置的自定义权限，被冷启动刷新覆盖为角色默认：
 *   · 被收紧权限的员工 → 界面显示更宽的入口，点击被后端 requireStaffPerm 判 403（看得见点不进）
 *   · 被放宽权限的员工 → 看不到本该可见的入口（多项功能事实上不可达）
 * 这是双端"权限不同步"的根因，且修复前本用例必然失败。
 *
 * 判别性：固定 role=coach，只改 permissions，比较 getProfile 返回。
 *   自定义 ['students'] 的员工：期望返回 ['students']，旧代码返回教练角色默认（含 schedule/checkin/...）。
 *   另测 '[]'（显式零权限）必须保真为空数组，不被回退为默认权限。
 *   admin 固定返回 ['*']（resolvePerms 短路），不受该列影响，作为稳定对照。
 *
 * 运行：node tests/getprofile-perms-regression.cjs
 */
process.env.DB_PATH = '/tmp/getprofile_perms_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/getprofile_perms_test.db', '/tmp/getprofile_perms_test.db-wal', '/tmp/getprofile_perms_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now, DEFAULT_PERMS } = require('../utils');
const authRouter = require('../routes/auth');

function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (!layer.route || layer.route.path !== path) continue;
    if (!layer.route.methods[method]) continue;
    return layer.route.stack[layer.route.stack.length - 1].handle;
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

const t = now();
db.transaction(() => {
  const ins = (...p) => db.prepare(
    'INSERT OR IGNORE INTO users (id, openid, role, password, nickname, permissions, status, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)'
  ).run(...p);
  ins('u_gp_custom', 'gp_custom', 'coach', 'x', '自定义教练', JSON.stringify(['students']), 'active', t, t);
  ins('u_gp_empty', 'gp_empty', 'sales', 'x', '零权限销售', '[]', 'active', t, t);
  ins('u_gp_default', 'gp_default', 'coach', 'x', '默认教练', '', 'active', t, t);
  ins('u_gp_admin', 'gp_admin', 'admin', 'x', '管理员', '', 'active', t, t);
})();

console.log('\n\x1b[1m=== getProfile 自定义权限保真 回归测试 ===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '\n');

const profile = (openid) => {
  const res = mockRes();
  getHandler(authRouter, 'get', '/getProfile')({ headers: {}, openid }, res);
  return res;
};

// 一、自定义权限必须原样返回（本例在修复前返回教练默认权限，必然失败）
console.log('\x1b[1m[一] 自定义权限保真\x1b[0m');
{
  const r = profile('gp_custom');
  const got = r.body && r.body.data && r.body.data.permissions;
  rec('自定义教练 getProfile 返回 [students]（非角色默认）',
    Array.isArray(got) && got.length === 1 && got[0] === 'students',
    `code=${r.body && r.body.code} got=${JSON.stringify(got)}`);
  const defaults = DEFAULT_PERMS.coach || [];
  rec('返回值确实与教练默认权限不同（确保判别性）',
    !(Array.isArray(got) && JSON.stringify(got) === JSON.stringify(defaults)),
    `got=${JSON.stringify(got)} default=${JSON.stringify(defaults)}`);
}

// 二、显式零权限 '[]' 必须保真为空数组
console.log('\x1b[1m[二] 显式零权限保真\x1b[0m');
{
  const r = profile('gp_empty');
  const got = r.body && r.body.data && r.body.data.permissions;
  rec("permissions='[]' 的 getProfile 返回空数组（不回退角色默认）",
    Array.isArray(got) && got.length === 0,
    `got=${JSON.stringify(got)}`);
}

// 三、未配置权限仍回落角色默认（未破坏原语义）
console.log('\x1b[1m[三] 未配置权限回落默认\x1b[0m');
{
  const r = profile('gp_default');
  const got = r.body && r.body.data && r.body.data.permissions;
  const defaults = DEFAULT_PERMS.coach || [];
  rec('未配置 permissions 的教练返回角色默认权限',
    Array.isArray(got) && JSON.stringify(got) === JSON.stringify(defaults),
    `got=${JSON.stringify(got)} default=${JSON.stringify(defaults)}`);
}

// 四、admin 稳定对照：始终 ['*']
console.log('\x1b[1m[四] admin 稳定对照\x1b[0m');
{
  const r = profile('gp_admin');
  const got = r.body && r.body.data && r.body.data.permissions;
  rec('admin 返回 ["*"]', Array.isArray(got) && got[0] === '*', `got=${JSON.stringify(got)}`);
}

console.log(`\n=== getProfile 权限保真：${passed} PASS / ${failed} FAIL ===\n`);
process.exit(failed ? 1 : 0);
