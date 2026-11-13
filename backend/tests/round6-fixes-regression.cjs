/**
 * 第六轮加固 · 判别性回归（隔离库 + 隔离端口 3111）
 *
 * 每条断言都要求「守卫被移除后变红」，覆盖 2026-11-13 修复的边界缺陷：
 *   P1 /points/add 判重必须限定 type='earn'，否则同 referenceId 的 consume 流水会误命中；
 *   P2 /points/consume 幂等键必须绑定学员与金额，否则换 studentId 可「免费兑换」；
 *   P3 PUT /settings 必须先全量校验再事务写入，否则非法键前的合法键已落库；
 *   P4 登录限流只统计 POST，GET 404 不得灌满共享出口 IP 的计数；
 *   P5 0 元单不得被判「已全额退款」；refunded_amount 为 NULL 时乐观锁不得死锁；
 *   P6 salesRanking 退款段不得排除空签单人（退卡载体单），否则 Σ排名与净营收对不平；
 *   P7 合同负债 SUM 必须对 payable_amount 也做 COALESCE，NULL 行不能静默丢行。
 *
 * 运行：node tests/round6-fixes-regression.cjs
 */
'use strict';

process.env.PORT = process.env.PORT || '3111';
// 限流阈值在 server 模块加载时读取：压低到 3 才能用少量 GET 404 验证「不计入」。
process.env.LOGIN_RATE_LIMIT = '3';

const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-round6');

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
const show = (r) => JSON.stringify(r.data).slice(0, 180);

/** 直接落一行订单，用于构造边界数据（隔离库，绝不触碰业务库） */
function insertOrder(db, o) {
  const t = Date.now();
  const cols = ['id', 'order_no', 'user_id', 'student_id', 'student_name', 'order_type', 'items',
    'total_amount', 'discount_amount', 'payable_amount', 'status', 'salesperson', 'remark',
    'is_1v1', 'paid_at', 'payment_id', 'created_at', 'updated_at', 'refunded_amount',
    'last_refunded_at', 'revenue_excluded'];
  const v = {
    id: o.id, order_no: o.order_no || ('R6-' + o.id), user_id: null, student_id: 'stu_001',
    student_name: 'R6 探针', order_type: o.order_type || 'membership', items: '[]',
    total_amount: o.payable_amount ?? 0, discount_amount: 0, payable_amount: o.payable_amount ?? 0,
    status: o.status || 'paid', salesperson: o.salesperson ?? '', remark: 'R6 regression',
    is_1v1: 0, paid_at: o.paid_at ?? t, payment_id: null, created_at: t, updated_at: t,
    refunded_amount: o.refunded_amount ?? 0, last_refunded_at: o.last_refunded_at ?? 0,
    revenue_excluded: o.revenue_excluded ?? 0,
  };
  db.prepare(`INSERT INTO orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => v[c]));
}

async function main() {
  console.log('\n\x1b[1m=== 第六轮加固判别性回归 ===\x1b[0m');
  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '\n');

  const db = new Database(process.env.DB_PATH);
  const IDS = resolveStaffIdentities(db);
  const tvOf = (openid) => (db.prepare('SELECT token_version FROM users WHERE openid = ?').get(openid) || {}).token_version || 0;
  const admin = generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) });

  // ── P1 /points/add 判重必须带 type='earn' ────────────────────
  // 先用 REF 扣减，再用同一 REF 发放：旧实现只查 reference_id，会命中 consume 流水
  // 返回 duplicated，积分漏发。
  const earn0 = await call('POST', '/api/points/add', {
    token: admin, body: { studentId: 'stu_002', amount: 100, reason: 'R6 夹具', referenceId: 'R6-EARN-BASE' },
  });
  rec('P1 夹具加积分成功', ok(earn0), show(earn0));
  const c1 = await call('POST', '/api/points/consume', {
    token: admin, body: { studentId: 'stu_002', amount: 10, reason: 'R6 兑换', referenceId: 'R6-CROSS-REF' },
  });
  rec('P1 夹具扣减成功', ok(c1) && c1.data.data.consumed === 10, show(c1));
  const addAfterConsume = await call('POST', '/api/points/add', {
    token: admin, body: { studentId: 'stu_002', amount: 7, reason: 'R6 同引用发放', referenceId: 'R6-CROSS-REF' },
  });
  rec('P1 同一 referenceId 的 consume 不误判 add 重复',
    ok(addAfterConsume) && addAfterConsume.data.data.duplicated !== true && addAfterConsume.data.data.added === 7,
    show(addAfterConsume));

  // ── P2 /points/consume 幂等键必须绑学员与金额 ─────────────────
  const earn2 = await call('POST', '/api/points/add', {
    token: admin, body: { studentId: 'stu_003', amount: 100, reason: 'R6 夹具', referenceId: 'R6-EARN-003' },
  });
  rec('P2 夹具加积分成功', ok(earn2), show(earn2));
  const crossStudent = await call('POST', '/api/points/consume', {
    token: admin, body: { studentId: 'stu_003', amount: 10, reason: 'R6 换人重放', referenceId: 'R6-CROSS-REF' },
  });
  rec('P2 同幂等键换学员被拒绝（不产生免费兑换）', !ok(crossStudent), show(crossStudent));
  // seed 里 stu_003 可能已有余额，不能用「加 100 后恰为 100」做基准；
  // 以「加完之后、被拒之前」的实际余额为准，断言被拒请求没有改动它。
  const bal003 = (db.prepare('SELECT balance FROM points WHERE student_id = ?').get('stu_003') || {}).balance;
  const balSeed = Number(earn2.data.data.balance) || 0;
  rec('P2 被拒绝的请求未扣减余额', bal003 === balSeed, `balance=${bal003}，加积分后=${balSeed}`);
  const crossAmount = await call('POST', '/api/points/consume', {
    token: admin, body: { studentId: 'stu_002', amount: 99, reason: 'R6 换额重放', referenceId: 'R6-CROSS-REF' },
  });
  rec('P2 同幂等键换金额被拒绝', !ok(crossAmount), show(crossAmount));
  const replay = await call('POST', '/api/points/consume', {
    token: admin, body: { studentId: 'stu_002', amount: 10, reason: 'R6 兑换', referenceId: 'R6-CROSS-REF' },
  });
  rec('P2 完全相同的重放仍返回 duplicated', ok(replay) && replay.data.data.duplicated === true, show(replay));

  // ── P3 PUT /settings 原子性 ─────────────────────────────────
  const beforeOrg = (db.prepare("SELECT value FROM settings WHERE key='org_info'").get() || {}).value || '';
  const mixed = await call('PUT', '/api/settings', {
    token: admin, body: {
      org_info: { name: 'R6-不应落库', logo: '' },
      points_rules: [{ name: '非法', enabled: true, points: 999999999 }],
    },
  });
  rec('P3 混合提交被拒绝', !ok(mixed), show(mixed));
  const afterOrg = (db.prepare("SELECT value FROM settings WHERE key='org_info'").get() || {}).value || '';
  rec('P3 被拒绝时合法键未部分落库（原子性）', afterOrg === beforeOrg,
    `before=${String(beforeOrg).slice(0, 60)} after=${String(afterOrg).slice(0, 60)}`);
  const legal = await call('PUT', '/api/settings', {
    token: admin, body: { org_info: { name: 'R6-合法', logo: '' } },
  });
  rec('P3 合法提交仍可保存', ok(legal), show(legal));

  // ── P5 0 元单 / NULL 乐观锁 ─────────────────────────────────
  insertOrder(db, { id: 'R6-ZERO', payable_amount: 0, status: 'paid' });
  const zeroPreview = await call('GET', '/api/orders/R6-ZERO/refund-preview', { token: admin });
  // 规则建议文案里会自然出现「全额退款」，不能据此判失败；
  // 真正的旧缺陷是接口直接返回 code!=0 +「该订单已全额退款，无需再次退款」。
  rec('P5 0 元单不误判「已全额退款」',
    ok(zeroPreview) && !/无需再次退款/.test(JSON.stringify(zeroPreview.data)), show(zeroPreview));
  insertOrder(db, { id: 'R6-NULLREF', payable_amount: 100, status: 'paid', refunded_amount: null });
  const nullRef = await call('POST', '/api/orders/R6-NULLREF/refund', {
    token: admin, body: { amount: 10, reason: 'R6 NULL 乐观锁' },
  });
  rec('P5 refunded_amount 为 NULL 时退款不再死锁 conflict',
    ok(nullRef) && !/conflict/i.test(JSON.stringify(nullRef.data)), show(nullRef));

  // ── P6 salesRanking 空签单人退款载体单 ──────────────────────
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const ts = monthStart + 3 * 86400000;
  const rankOf = async () => {
    const d = await call('GET', '/api/admin/dashboard', { token: admin });
    const list = (((d.data || {}).data || {}).sales || {}).monthRanking || [];
    const u = list.find((r) => r.salesperson === '未分配');
    return u ? Number(u.amount) : 0;
  };
  // seed 本身就含其它空签单人退款行，绝对值不是 -600；
  // 用「插入载体单前后的差额」做判别：旧实现排除空桶，delta 会是 0。
  const unassignedBefore = await rankOf();
  insertOrder(db, {
    id: 'R6-REFUND-CARRIER', order_type: 'refund_standalone', payable_amount: 0,
    refunded_amount: 600, status: 'refunded', salesperson: '',
    paid_at: ts, last_refunded_at: ts,
  });
  const unassignedAfter = await rankOf();
  rec('P6 空签单人退款载体单使「未分配」桶净额减少 600',
    Math.abs((unassignedAfter - unassignedBefore) + 600) < 0.005,
    `before=${unassignedBefore} after=${unassignedAfter} delta=${unassignedAfter - unassignedBefore}`);

  // ── P6b 排名合计必须等于本月净营收（收入段同样不能丢空签单人）──
  // 家长自助下单 / 小程序直购的订单 salesperson 为空；若收入段把它排除，
  // Σ排名 会少于 monthRevenue，差额随自助单量增长且无人对账。
  const dashSum = await call('GET', '/api/admin/dashboard', { token: admin });
  const dd = (dashSum.data || {}).data || {};
  const rankSum = ((dd.sales || {}).monthRanking || []).reduce((s, r) => s + Number(r.amount || 0), 0);
  const monthRev = Number((dd.revenue || {}).month || 0);
  rec('P6b 本月排名合计 == 本月净营收（空签单人收入不被丢弃）',
    Math.abs(rankSum - monthRev) < 0.005, `rankSum=${rankSum} monthRevenue=${monthRev}`);

  // ── P7 合同负债 COALESCE(payable) 双侧 ───────────────────────
  const sumBefore = await call('GET', '/api/finance/summary', { token: admin });
  const clBefore = Number((((sumBefore.data || {}).data || {}).contractLiability) || 0);
  insertOrder(db, {
    id: 'R6-NULLPAY', payable_amount: null, refunded_amount: 300,
    status: 'refunded', last_refunded_at: ts,
  });
  const sumAfter = await call('GET', '/api/finance/summary', { token: admin });
  const clAfter = Number((((sumAfter.data || {}).data || {}).contractLiability) || 0);
  rec('P7 payable 为 NULL 的退款行不再静默丢行（负债减少 300）',
    Number.isFinite(clBefore) && Number.isFinite(clAfter) && Math.abs((clAfter - clBefore) + 300) < 0.005,
    `before=${clBefore} after=${clAfter} delta=${clAfter - clBefore}`);

  // ── P4 登录限流（放最后，避免 429 影响其它用例）─────────────
  // 显式 /api 404 会经过 loginThrottle 包装的 res.json，旧实现把 GET 404 也计入失败。
  let get404 = 0;
  for (let i = 0; i < 5; i++) {
    const r = await call('GET', '/api/auth/login');
    if (r.status === 404) get404++;
  }
  rec('P4 GET /api/auth/login 返回结构化 404', get404 === 5, `实际 ${get404}/5`);
  const stillOk = await call('POST', '/api/auth/login', {
    body: { phone: '13800000001', password: '123456', role: 'admin' },
  });
  rec('P4 GET 404 不计入限流，正确口令仍可登录', ok(stillOk) && stillOk.status === 200,
    `status=${stillOk.status} ${show(stillOk)}`);
  const wx = { code: 'r6-invalid-code' };
  for (let i = 0; i < 3; i++) await call('POST', '/api/auth/wx-login', { body: wx });
  const blocked = await call('POST', '/api/auth/wx-login', { body: wx });
  rec('P4 POST 业务码失败仍计入限流（防护未降级）', blocked.status === 429, `status=${blocked.status}`);

  db.close();
  console.log(`\n=== 结果汇总：PASS ${passed}  FAIL ${failed} ===\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
