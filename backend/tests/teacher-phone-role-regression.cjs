/**
 * E10 回归测试 —— 教师「同时改手机号 + 改角色」时赋权不得静默失效（离线，隔离库）
 *
 * 原始缺陷（代码注释 admin.js:1024-1143 已详述）：改手机号时，登录账号的「按新号查询」
 * 在迁移前必然为 null，导致角色变更分支的 token_version bump 条件依赖一个 null 的
 * targetUser，于是老账号 role 虽已改、旧 Token 却未失效，7 天内仍带旧角色。
 *
 * 判别性：以「旧手机号」先定位登录账号（targetUser 不为 null），再在角色变更分支用
 * permUser（= targetUser，同一老账号行）而非改号后恒为 null 的查询来判定 bump。
 * 固定同时改手机号与角色，断言：
 *   1) 按【新手机号】定位的账号拿到【新角色】（role 应用到了被迁移的同一账号，无游离账号）；
 *   2) 该账号 token_version 从 0 → 1（旧 Token 被吊销，核心修复点）；
 *   3) 旧手机号不再对应任何登录账号（手机号已迁移，单一账号）。
 *
 * 控制组（Case B：仅改角色、不改手机号）：同样必须 bump token_version，证明角色变更
 * 的吊销逻辑与是否改号无关。
 *
 * 在旧（缺陷）代码上，Case A 不会给被迁移账号 bump token_version（role 甚至可能落到
 * 一个新建的游离账号），本用例必然失败。
 *
 * 运行：node tests/teacher-phone-role-regression.cjs
 */
process.env.DB_PATH = '/tmp/teacher_phone_role_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/teacher_phone_role_test.db', '/tmp/teacher_phone_role_test.db-wal', '/tmp/teacher_phone_role_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
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
  // 操作者：管理员（openid 与任何目标账号都不相同，规避「不能停用/降级当前登录管理员」分支）
  ins(
    'INSERT OR IGNORE INTO users (id, openid, phone, nickname, role, password, status, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_admin_e10', 'admin_e10', '13900000000', '管理员', 'admin', 'x', 'active', t, t
  );
  // Case A：旧手机号 13800000901，对应教练账号 role=coach、token_version=0
  ins(
    'INSERT INTO teachers (id, name, phone, status, created_at) VALUES (?,?,?,?,?)',
    'tch_a', '王老师', '13800000901', 'active', t
  );
  ins(
    'INSERT INTO users (id, openid, phone, nickname, role, password, status, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_tch_a', 'phone_13800000901', '13800000901', '王老师', 'coach', 'x', 'active', t, t
  );
  // Case B：旧手机号 13800000902，对应教练账号 role=coach、token_version=0（仅改角色，不改号）
  ins(
    'INSERT INTO teachers (id, name, phone, status, created_at) VALUES (?,?,?,?,?)',
    'tch_b', '李老师', '13800000902', 'active', t
  );
  ins(
    'INSERT INTO users (id, openid, phone, nickname, role, password, status, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_tch_b', 'phone_13800000902', '13800000902', '李老师', 'coach', 'x', 'active', t, t
  );
});
seed();

console.log('\n\x1b[1m=== E10 教师改号+改角色赋权回归测试 ===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '\n');

const putTeacher = getHandler(adminRouter, 'put', '/teachers/:id');
const OLD_A = '13800000901', NEW_A = '13800000999', OLD_B = '13800000902';
const actor = { userRole: 'admin', openid: 'admin_e10' };

// ============================================================
// Case A：同时改手机号 + 改角色（coach → admin）
// ============================================================
console.log('\x1b[1m[Case A] 同时改手机号 + 改角色（coach → admin）\x1b[0m');
{
  const res = mockRes();
  putTeacher(mockReq({
    ...actor,
    params: { id: 'tch_a' },
    body: { phone: NEW_A, role: 'admin' },
  }), res);
  rec('PUT 成功（非 500，无副作用崩溃）', res.body && res.body.code === 0, `code=${res.body && res.body.code}, msg=${res.body && res.body.message}`);

  const byNew = db.prepare('SELECT id, openid, role, token_version, phone FROM users WHERE phone = ?').get(NEW_A);
  rec('按【新手机号】定位到账号，且拿到【新角色 admin】',
    !!byNew && byNew.role === 'admin', `row=${JSON.stringify(byNew)}`);
  rec('该账号 token_version 从 0 → 1（旧 Token 被吊销，E10 核心修复）',
    !!byNew && byNew.token_version === 1, `token_version=${byNew && byNew.token_version}`);
  rec('openid 已随手机号迁移为 phone_${新号}',
    !!byNew && byNew.openid === `phone_${NEW_A}`, `openid=${byNew && byNew.openid}`);
  rec('教师档案手机号已更新为新号',
    db.prepare('SELECT phone FROM teachers WHERE id = ?').get('tch_a').phone === NEW_A);

  const byOld = db.prepare('SELECT id FROM users WHERE phone = ?').get(OLD_A);
  rec('旧手机号不再对应任何登录账号（单一账号，无游离老号）',
    !byOld, `oldRow=${JSON.stringify(byOld)}`);
}

// ============================================================
// Case B：仅改角色、不改手机号（coach → admin）
// ============================================================
console.log('\n\x1b[1m[Case B] 仅改角色、不改手机号（coach → admin）\x1b[0m');
{
  const res = mockRes();
  putTeacher(mockReq({
    ...actor,
    params: { id: 'tch_b' },
    body: { role: 'admin' },
  }), res);
  rec('PUT 成功（非 500）', res.body && res.body.code === 0, `code=${res.body && res.body.code}, msg=${res.body && res.body.message}`);

  const byPhone = db.prepare('SELECT id, role, token_version, phone FROM users WHERE phone = ?').get(OLD_B);
  rec('角色已更新为 admin（手机号不变）',
    !!byPhone && byPhone.role === 'admin', `row=${JSON.stringify(byPhone)}`);
  rec('仅改角色也必须 bump token_version（0 → 1）',
    !!byPhone && byPhone.token_version === 1, `token_version=${byPhone && byPhone.token_version}`);
  rec('手机号保持不变',
    !!byPhone && byPhone.phone === OLD_B, `phone=${byPhone && byPhone.phone}`);
}

console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
