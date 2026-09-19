/**
 * 回归套件 —— 操作日志（audit_log）必须可查，且只对管理员开放
 *
 * 被验证的缺陷（留痕不可查 = 白留）：
 *   audit_log 此前**只写不读**——全仓 40+ 处 recordAudit 持续写入，但没有任何查询
 *   接口，前端也没有任何页面。管理员要追「谁在什么时候取消了哪场排期、退了多少
 *   钱、停用了谁」，只能走「数据备份」把整表导出成 JSON 再人工翻找。对只有一两个
 *   管理员的小机构，这等于没有留痕：出事之后查不清，也就无从「不出差错」。
 *
 * 修复：新增 GET /api/admin/audit-logs（只读），adminOnly 守护，支持
 *   entity / action / actorId / start / end / page / pageSize 过滤，
 *   并返回 entity/action 的下拉候选（候选由库内 DISTINCT 反查，前端硬编码必然过期）。
 *
 * 为什么必须 adminOnly：审计行含全机构操作者标识与业务主键，能反推经营动作
 *   （退款、薪资结算、停用员工），教练与销售一律不可见。T2 钉死这条。
 *
 * 判别力设计（每条判别项在修复被移除后必须变红）：
 *   · T1-1 是**判别项**：路由不存在时 Express 走 404 handler，返回体不是 code=0
 *     的 success 结构，此处必红。
 *   · T2 是**鉴权判别项**：若实现漏掉 adminOnly，教练/销售会拿到 200，此处必红。
 *     匿名请求由 server.js 鉴权中间件拦在更前面，断言 401 而非 403（口径不同源）。
 *   · T3/T4 过滤：每条都配「不加过滤时总数更大」的对照，防止过滤器恒真/恒假假绿。
 *   · T5-3 pageSize 上限：传 9999 必须被夹到 100，防止前端误传把整表拉回来。
 *   · T6 before/after 必须是**解析后的对象**而非 JSON 串（前端要直接渲染），
 *     否则页面会出现一坨字符串。
 *
 * 纪律：绝不为了验证判别力而临时改坏刚写的修复——判别力由上述判别项自证。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db 与 3001 端口上的线上服务）：
 *   node tests/audit-log-query-regression.cjs
 */
'use strict';

// 端口必须在 require('../server') 之前设定：server.js 在模块加载时读取 PORT。
// 3001 是线上服务；3095-3099、3101 已被其它套件占用，这里走 3102。
process.env.PORT = process.env.PORT || '3102';

const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-audit-log-query');

// 防呆：临时库必须落在 /tmp，绝不能是真实库 backend/db/data.db
if (!String(process.env.DB_PATH || '').startsWith('/tmp/')) {
  console.error('[致命] DB_PATH 不在 /tmp，拒绝运行以免污染真实库:', process.env.DB_PATH);
  process.exit(2);
}

const db = require('../db');
const { now, generateToken } = require('../utils');

const BASE = `http://localhost:${process.env.PORT}`;

// ---------- 断言记录 ----------
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
  let data = null; try { data = await res.json(); } catch (e) { /* 可能非 JSON */ }
  return { status: res.status, data };
}

const waitHealth = async (retries = 60) => {
  for (let i = 0; i < retries; i++) {
    try { const r = await call('GET', '/api/health'); if (r.status === 200) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

// ---------- 夹具 ----------
const fmt = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const DAY = 86400000;
const dayStart = (ms) => new Date(`${fmt(ms)}T00:00:00`).getTime();
const T0 = Date.now();
// 昨天 12:00（正午）而非「此刻减 24 小时」：后者在凌晨运行时会落到前天，
// 让日期区间断言依赖运行时刻。固定到正午使断言在任何时刻都成立。
const T_YDAY = dayStart(T0) - 12 * 3600 * 1000;
const T_OLD = T0 - 7 * DAY;   // 7 天前：用于验证日期区间过滤把它排除在外
const TODAY = fmt(T0);
const YESTERDAY = fmt(T_YDAY);

const ADMIN_OPENID = 'openid_audit_admin_probe';
const OTHER_OPENID = 'openid_audit_other_probe';

const ins = (sql, ...args) => db.prepare(sql).run(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

/** 直接造审计行：本套件验证的是「读」侧，写侧（recordAudit）另有套件覆盖。 */
function mkAudit(id, entity, action, actorId, createdAt, before, after) {
  ins(`INSERT INTO audit_log (id, entity, entity_id, action, actor_id, actor_role,
        before_state, after_state, created_at)
       VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, ?)`,
    id, entity, `ent_${id}`, action, actorId,
    before === undefined || before === null ? null : JSON.stringify(before),
    after === undefined || after === null ? null : JSON.stringify(after),
    createdAt);
}

const tvOf = (openid) => {
  const r = db.prepare('SELECT COALESCE(token_version, 0) AS tv FROM users WHERE openid = ?').get(openid);
  return r ? r.tv : 0;
};

async function main() {
  console.log('\n\x1b[1m=== 操作日志可查性 回归 ===\x1b[0m');

  // 造 4 条审计行：两条今天（不同 entity/action/actor），一条昨天，一条 7 天前。
  mkAudit('a1', 'order', 'refund', ADMIN_OPENID, T0,
    { refunded_amount: 0, status: 'paid' }, { refunded_amount: 100, amount: 100, full: true });
  mkAudit('a2', 'schedule', 'cancel', ADMIN_OPENID, T0 - 1000,
    { course_name: '探针课', date: TODAY }, { status: 'cancelled', reverted_classes: 2 });
  mkAudit('a3', 'payroll', 'settle', OTHER_OPENID, T_YDAY,
    null, { month: '2026-08', settled: 3, totalAmount: 4200 });
  mkAudit('a4', 'student', 'delete', OTHER_OPENID, T_OLD,
    { name: '老学员' }, { status: 'refunded', parents_unbound: true });

  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '（测试库:', process.env.DB_PATH, '）\n');

  const IDS = resolveStaffIdentities(db);
  const adminToken = generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) });
  const coachToken = generateToken({ openid: IDS.coach, role: 'coach', tv: tvOf(IDS.coach) });
  const salesToken = generateToken({ openid: IDS.sales, role: 'sales', tv: tvOf(IDS.sales) });

  const totalRows = () => one('SELECT COUNT(*) c FROM audit_log').c;

  // ============================================================
  // T0. 前置
  // ============================================================
  console.log('\x1b[1m[T0] 前置：服务就绪 + 夹具审计行已就位\x1b[0m');
  {
    rec('T0-1 /api/health 200（服务已就绪）', (await call('GET', '/api/health')).status === 200);
    // 反假绿护栏：夹具若没写进去，后面「过滤后为 0」的断言会因为压根没数据而假绿
    rec(`T0-2 夹具已写入 4 条审计行（实际 ${totalRows()}）`, totalRows() === 4, `实际 ${totalRows()}`);
  }

  // ============================================================
  // T1. 管理员可查（判别项）
  // ============================================================
  console.log('\x1b[1m[T1] 管理员可查（判别项：修复前该路由不存在）\x1b[0m');
  let all = null;
  {
    const r = await call('GET', '/api/admin/audit-logs', { token: adminToken });
    all = r.data;
    rec('T1-1 [判别] GET /api/admin/audit-logs 返回 200 且 code=0',
      r.status === 200 && r.data && r.data.code === 0, `status=${r.status} body=${JSON.stringify(r.data)}`);
    rec('T1-2 返回 list 为数组', Array.isArray(r.data && r.data.data && r.data.data.list),
      JSON.stringify(r.data && r.data.data && typeof r.data.data.list));
    rec(`T1-3 total 反映全表行数（${totalRows()}）`,
      r.data && r.data.data && r.data.data.total === totalRows(),
      `total=${r.data && r.data.data && r.data.data.total}`);
    rec('T1-4 返回 page / pageSize 默认值（1 / 20）',
      r.data && r.data.data && r.data.data.page === 1 && r.data.data.pageSize === 20,
      `page=${r.data?.data?.page} pageSize=${r.data?.data?.pageSize}`);
    rec('T1-5 返回 filters.entities 与 filters.actions 候选数组',
      Array.isArray(r.data?.data?.filters?.entities) && Array.isArray(r.data?.data?.filters?.actions)
      && r.data.data.filters.entities.length > 0 && r.data.data.filters.actions.length > 0,
      JSON.stringify(r.data?.data?.filters));
  }

  // ============================================================
  // T2. 鉴权：仅管理员（判别项）
  // ============================================================
  console.log('\x1b[1m[T2] 鉴权：教练/销售/匿名一律不可见（判别项）\x1b[0m');
  {
    const c = await call('GET', '/api/admin/audit-logs', { token: coachToken });
    rec('T2-1 [判别] 教练 → 403', c.status === 403, `status=${c.status}`);
    const s = await call('GET', '/api/admin/audit-logs', { token: salesToken });
    rec('T2-2 [判别] 销售 → 403', s.status === 403, `status=${s.status}`);
    const an = await call('GET', '/api/admin/audit-logs');
    // 匿名由 server.js 鉴权中间件拦在路由之前，故是 401 而非 403（口径不同源，不能写成 403）
    rec('T2-3 [判别] 匿名 → 401（鉴权中间件拦在路由之前）', an.status === 401, `status=${an.status}`);
    rec('T2-4 被拒响应不含审计数据', !(c.data && c.data.data && c.data.data.list),
      JSON.stringify(c.data));
  }

  // ============================================================
  // T3. 过滤：entity / action / actorId
  // ============================================================
  console.log('\x1b[1m[T3] 过滤：entity / action / actorId\x1b[0m');
  {
    const r = await call('GET', '/api/admin/audit-logs?entity=schedule', { token: adminToken });
    rec('T3-1 按 entity=schedule 过滤后 total === 1',
      r.data?.data?.total === 1, `total=${r.data?.data?.total}`);
    rec('T3-2 过滤结果的每一行 entity 都等于 schedule',
      r.data?.data?.list?.every((x) => x.entity === 'schedule'),
      JSON.stringify(r.data?.data?.list?.map((x) => x.entity)));

    const r2 = await call('GET', '/api/admin/audit-logs?action=refund', { token: adminToken });
    rec('T3-3 按 action=refund 过滤后 total === 1',
      r2.data?.data?.total === 1, `total=${r2.data?.data?.total}`);

    const r3 = await call('GET', `/api/admin/audit-logs?actorId=${OTHER_OPENID}`, { token: adminToken });
    rec(`T3-4 按 actorId=${OTHER_OPENID} 过滤后 total === 2`,
      r3.data?.data?.total === 2, `total=${r3.data?.data?.total}`);

    // 组合过滤：entity + actorId 必须同时生效（否则等于只应用了一个条件）
    const r4 = await call('GET', `/api/admin/audit-logs?entity=payroll&actorId=${OTHER_OPENID}`, { token: adminToken });
    rec('T3-5 组合过滤 entity+actorId 同时生效（total === 1）',
      r4.data?.data?.total === 1, `total=${r4.data?.data?.total}`);

    // 反假绿：不存在的 entity 应为 0（证明过滤器不是恒真）
    const r5 = await call('GET', '/api/admin/audit-logs?entity=not_exist_entity', { token: adminToken });
    rec('T3-6 [护栏] 不存在的 entity → total === 0（过滤器非恒真）',
      r5.data?.data?.total === 0, `total=${r5.data?.data?.total}`);
  }

  // ============================================================
  // T4. 日期区间过滤（半开区间 [start, end)）
  // ============================================================
  console.log('\x1b[1m[T4] 日期区间过滤\x1b[0m');
  {
    // start=今天 → 只含今天的两条（昨天 1 条、7 天前 1 条应被排除）
    const r = await call('GET', `/api/admin/audit-logs?start=${TODAY}`, { token: adminToken });
    rec('T4-1 start=今天 → total === 2（排除昨天与 7 天前）',
      r.data?.data?.total === 2, `total=${r.data?.data?.total}`);

    // end=昨天 → created_at < 昨天24点，即不含今天的 2 条
    const r2 = await call('GET', `/api/admin/audit-logs?end=${YESTERDAY}`, { token: adminToken });
    rec('T4-2 end=昨天 → total === 2（半开区间，不含今天）',
      r2.data?.data?.total === 2, `total=${r2.data?.data?.total}`);

    // end 是**含当日**（实现取 dayEndMs，即次日 00:00），与看板日期区间口径一致。
    // 故「只要昨天一整天」应传 start=end=昨天，而不是 end=今天。
    const r3 = await call('GET', `/api/admin/audit-logs?start=${YESTERDAY}&end=${YESTERDAY}`, { token: adminToken });
    rec('T4-3 区间 [昨天, 昨天]（end 含当日）→ total === 1（仅昨天那条）',
      r3.data?.data?.total === 1, `total=${r3.data?.data?.total}`);
    rec('T4-4 该行的 entity 确实是 payroll（夹具 a3）',
      r3.data?.data?.list?.[0]?.entity === 'payroll',
      JSON.stringify(r3.data?.data?.list?.[0]));
  }

  // ============================================================
  // T5. 分页与上限保护
  // ============================================================
  console.log('\x1b[1m[T5] 分页与 pageSize 上限保护\x1b[0m');
  {
    const r = await call('GET', '/api/admin/audit-logs?page=2&pageSize=2', { token: adminToken });
    rec('T5-1 第 2 页（pageSize=2）返回 2 条', r.data?.data?.list?.length === 2,
      `len=${r.data?.data?.list?.length}`);
    rec('T5-2 total 仍为全表行数（分页不影响总数）',
      r.data?.data?.total === totalRows(), `total=${r.data?.data?.total}`);

    const r2 = await call('GET', '/api/admin/audit-logs?pageSize=9999', { token: adminToken });
    // 上限 100：防止前端误传大值把整表拉回来（审计表只增不减）
    rec('T5-3 [判别] pageSize 传 9999 被夹到 100', r2.data?.data?.pageSize === 100,
      `pageSize=${r2.data?.data?.pageSize}`);

    const r3 = await call('GET', '/api/admin/audit-logs?page=999', { token: adminToken });
    rec('T5-4 越界页返回空列表而非报错', Array.isArray(r3.data?.data?.list) && r3.data?.data?.list.length === 0,
      JSON.stringify(r3.data?.data?.list?.length));
  }

  // ============================================================
  // T6. before / after 必须是解析后的对象
  // ============================================================
  console.log('\x1b[1m[T6] before / after 返回解析后的对象（前端直接渲染）\x1b[0m');
  {
    const r = await call('GET', '/api/admin/audit-logs?entity=order&action=refund', { token: adminToken });
    const row = r.data?.data?.list?.[0];
    rec('T6-1 [判别] before 是对象而非 JSON 字符串',
      row && typeof row.before === 'object' && row.before !== null, typeof row?.before);
    rec('T6-2 after 是对象且金额可读取（refunded_amount === 100）',
      row?.after?.refunded_amount === 100, JSON.stringify(row?.after));
    rec('T6-3 原始字段 before_state / after_state 不出现在返回体（避免前端渲染到裸串）',
      row && !('before_state' in row) && !('after_state' in row), JSON.stringify(Object.keys(row || {})));

    // 空快照应返回 null，而不是抛错把整页打成 500
    const r2 = await call('GET', '/api/admin/audit-logs?entity=payroll', { token: adminToken });
    rec('T6-4 before 为空的快照返回 null（不因解析失败而 500）',
      r2.data?.data?.list?.[0]?.before === null, JSON.stringify(r2.data?.data?.list?.[0]?.before));
  }

  // ============================================================
  // T7. filters 候选如实反映库内数据
  // ============================================================
  console.log('\x1b[1m[T7] filters 候选列表\x1b[0m');
  {
    const ents = all?.data?.filters?.entities || [];
    const acts = all?.data?.filters?.actions || [];
    rec('T7-1 entities 含夹具写入的 4 种实体（order/schedule/payroll/student）',
      ['order', 'schedule', 'payroll', 'student'].every((e) => ents.includes(e)), JSON.stringify(ents));
    rec('T7-2 actions 含 refund / cancel / settle / delete',
      ['refund', 'cancel', 'settle', 'delete'].every((a) => acts.includes(a)), JSON.stringify(acts));
  }

  // ============================================================
  // T8. SQL 注入防护
  // ============================================================
  console.log('\x1b[1m[T8] SQL 注入防护（过滤参数一律绑定，不拼接）\x1b[0m');
  {
    const evil = "order' OR '1'='1";
    const r = await call('GET', `/api/admin/audit-logs?entity=${encodeURIComponent(evil)}`, { token: adminToken });
    rec('T8-1 注入串作为 entity 传入不报错（200）', r.status === 200, `status=${r.status}`);
    rec('T8-2 注入未生效：total === 0（未把全表带出来）', r.data?.data?.total === 0,
      `total=${r.data?.data?.total}`);
  }

  console.log(`\n========================================\n  结果：${passed} PASS / ${failed} FAIL\n========================================\n`);
  db.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
