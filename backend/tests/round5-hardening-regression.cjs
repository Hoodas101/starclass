/**
 * 第五轮加固 · 判别性回归
 *
 * 覆盖本轮落地的 U1/U2/U3/U4/U6，每条断言都要求在「守卫被移除后变红」：
 *   U3 卡类型数值校验   —— 1.5 次课时 / 999999 天 / 负价 / 超限到店限次必须被拒；
 *                          更新接口的负价同样必须被拒（此前两条写入链路判据分叉）。
 *   U1 发卡幂等         —— 同一 orderId 连发两次 activate，库内只能有 1 张卡。
 *   U2 积分扣减幂等     —— 同一 referenceId 连发两次 consume，只能扣一次、只留 1 条流水；
 *                          且带 type='consume' 判重，不能被同 referenceId 的 earn 流水误命中。
 *   U6 设置写入校验     —— 超额积分规则、null payload 必须被拒，合法规则可正常保存。
 *   U4 登录限流         —— 微信登录「HTTP 200 但业务码非 0」的失败必须计入限流；
 *                          正确口令登录不计入；非登录路径不受影响。
 *
 * 全程隔离库 + 隔离端口，绝不触碰 backend/db/data.db 与 3001 线上服务。
 * 运行：node tests/round5-hardening-regression.cjs
 */
'use strict';

process.env.PORT = process.env.PORT || '3110';
// 必须在 require('../server') 之前设定：限流阈值在模块加载时读取。
// 单独压低到 3 次，才能在少量请求内验证「业务码失败被计数」。
process.env.LOGIN_RATE_LIMIT = '3';

const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-round5');

const Database = require('better-sqlite3');
const { generateToken } = require('../utils');

const BASE = `http://localhost:${process.env.PORT}`;
let passed = 0, failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${ok ? '' : '  -> ' + detail}`);
}

async function call(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  return { status: res.status, data };
}

const waitHealth = async (retries = 50) => {
  for (let i = 0; i < retries; i++) {
    try { const r = await call('GET', '/api/health'); if (r.status === 200) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

const ok = (r) => r.data && r.data.code === 0;
const show = (r) => JSON.stringify(r.data).slice(0, 160);

async function main() {
  console.log('\n\x1b[1m=== 第五轮加固判别性回归 ===\x1b[0m');
  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '\n');

  const db = new Database(process.env.DB_PATH);
  const IDS = resolveStaffIdentities(db);
  const tvOf = (openid) => (db.prepare('SELECT token_version FROM users WHERE openid = ?').get(openid) || {}).token_version || 0;
  const admin = generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) });

  // ── U3 卡类型数值校验 ────────────────────────────────────────
  const baseCard = { name: 'R5-回归卡', billingMode: 'time', validDays: 30, price: 100, pointsReward: 0 };
  const badCases = [
    ['次数非整数', { billingMode: 'count', totalClasses: 1.5, validDays: 0 }],
    ['有效天数超上限', { validDays: 999999 }],
    ['负价', { price: -1 }],
    ['赠送积分小数', { pointsReward: 1.5 }],
    ['到店限次超限', { visitLimitPerWeek: 9999 }],
  ];
  for (const [label, patch] of badCases) {
    const r = await call('POST', '/api/membership/card-type', { token: admin, body: { ...baseCard, ...patch } });
    rec(`U3 创建拒绝：${label}`, !ok(r), show(r));
  }
  const ct = await call('POST', '/api/membership/card-type', { token: admin, body: baseCard });
  rec('U3 合法卡种可创建', ok(ct), show(ct));
  const ctId = ct.data && ct.data.data && ct.data.data.id;
  if (ctId) {
    const upd = await call('PUT', `/api/membership/card-type/${ctId}`, { token: admin, body: { price: -5 } });
    rec('U3 更新拒绝：负价', !ok(upd), show(upd));
    const upd2 = await call('PUT', `/api/membership/card-type/${ctId}`, { token: admin, body: { price: 200 } });
    rec('U3 合法价格可更新', ok(upd2), show(upd2));
  } else {
    rec('U3 更新拒绝：负价', false, '未取得卡种 id');
    rec('U3 合法价格可更新', false, '未取得卡种 id');
  }

  // ── U1 发卡幂等 ─────────────────────────────────────────────
  if (ctId) {
    const actBody = { cardTypeId: ctId, studentId: 'stu_001', orderId: 'R5-ORDER-001' };
    const a1 = await call('POST', '/api/membership/activate', { token: admin, body: actBody });
    const a2 = await call('POST', '/api/membership/activate', { token: admin, body: actBody });
    const c = db.prepare('SELECT COUNT(*) c FROM member_cards WHERE order_id = ?').get('R5-ORDER-001').c;
    rec('U1 首次发卡成功', ok(a1), show(a1));
    rec('U1 重放返回 duplicated', ok(a2) && a2.data.data.duplicated === true, show(a2));
    rec('U1 同订单仅 1 张卡', c === 1, `实际 ${c} 行`);
    // 后台直接发卡（orderId 为空）仍是独立业务，不能被空串幂等键误判
    const b1 = await call('POST', '/api/membership/activate', { token: admin, body: { cardTypeId: ctId, studentId: 'stu_001' } });
    const b2 = await call('POST', '/api/membership/activate', { token: admin, body: { cardTypeId: ctId, studentId: 'stu_001' } });
    rec('U1 后台直接发卡不受幂等键影响', ok(b1) && ok(b2) && b2.data.data.duplicated === false, `${show(b1)} | ${show(b2)}`);
  } else {
    rec('U1 首次发卡成功', false, '未取得卡种 id');
    rec('U1 重放返回 duplicated', false, '未取得卡种 id');
    rec('U1 同订单仅 1 张卡', false, '未取得卡种 id');
    rec('U1 后台直接发卡不受幂等键影响', false, '未取得卡种 id');
  }

  // ── U2 积分扣减幂等 ─────────────────────────────────────────
  const before = (db.prepare('SELECT balance FROM points WHERE student_id = ?').get('stu_001') || {}).balance || 0;
  const earn = await call('POST', '/api/points/add', {
    token: admin, body: { studentId: 'stu_001', amount: 50, reason: 'R5 夹具', referenceId: 'R5-SHARED-REF' },
  });
  rec('U2 夹具加积分成功', ok(earn), show(earn));
  const consumeBody = { studentId: 'stu_001', amount: 20, reason: 'R5 兑换', referenceId: 'R5-SHARED-REF' };
  const c1 = await call('POST', '/api/points/consume', { token: admin, body: consumeBody });
  const c2 = await call('POST', '/api/points/consume', { token: admin, body: consumeBody });
  const after = (db.prepare('SELECT balance FROM points WHERE student_id = ?').get('stu_001') || {}).balance || 0;
  const logs = db.prepare("SELECT COUNT(*) c FROM point_logs WHERE reference_id = ? AND type = 'consume'").get('R5-SHARED-REF').c;
  rec('U2 首次扣减成功', ok(c1) && c1.data.data.consumed === 20, show(c1));
  rec('U2 重放返回 duplicated 且不扣减', ok(c2) && c2.data.data.duplicated === true && c2.data.data.consumed === 0, show(c2));
  rec('U2 同 referenceId 的 earn 未被误判为重复', logs === 1, `consume 流水 ${logs} 行`);
  rec('U2 余额只扣一次', after === before + 50 - 20, `期望 ${before + 30}，实际 ${after}`);

  // ── U6 设置写入校验 ─────────────────────────────────────────
  const s1 = await call('PUT', '/api/settings', {
    token: admin, body: { points_rules: [{ name: '超额', enabled: true, points: 999999999 }] },
  });
  rec('U6 拒绝超额积分规则', !ok(s1), show(s1));
  const s2 = await call('PUT', '/api/settings', { token: admin, body: { points_rules: null } });
  rec('U6 拒绝 null payload', !ok(s2), show(s2));
  const s3 = await call('PUT', '/api/settings', {
    token: admin, body: { points_rules: [{ name: '训练签到', enabled: true, points: 10 }] },
  });
  rec('U6 合法规则可保存', ok(s3), show(s3));

  // ── U4 登录限流（放最后，避免 429 影响前面的用例）───────────
  const good = await call('POST', '/api/auth/login', {
    body: { phone: '13800000001', password: '123456', role: 'admin' },
  });
  rec('U4 正确口令登录可用', ok(good), show(good));
  // 未配置 WX_APPID/WX_SECRET 时，wx-login 返回「HTTP 200 + code != 0」的业务失败，
  // 正是旧限流（只统计 statusCode >= 400）完全漏计的一类。
  const wx = { code: 'r5-invalid-code' };
  let bizFailures = 0;
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/api/auth/wx-login', { body: wx });
    if (r.status === 200 && !ok(r)) bizFailures++;
  }
  rec('U4 微信登录业务失败为 200 + 非 0 业务码', bizFailures === 3, `实际 ${bizFailures}/3`);
  const blocked = await call('POST', '/api/auth/wx-login', { body: wx });
  rec('U4 业务码失败计入限流后触发 429', blocked.status === 429, `status=${blocked.status} ${show(blocked)}`);
  const health = await call('GET', '/api/health');
  rec('U4 非登录路径未被限流波及', health.status === 200, `status=${health.status}`);

  db.close();
  console.log(`\n=== 结果汇总：PASS ${passed}  FAIL ${failed} ===\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
