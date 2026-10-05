/**
 * Batch 7 · 安全收尾 —— 判别性回归测试（S3 / S4 / S5 / S6 / S7 / S9 / S10 / S11）
 *
 * 设计原则：每一条断言都必须**在守卫被移除后变红**（判别性 / mutation-detectable），
 * 而不是「跑一遍没报错就算过」。为此每条用例都构造了真实的对立场景：
 *   - S4/S5：家长 A（属于班 A）去读班 B 的排课，必须被拒或读不到；
 *   - S6：家长 A 标记广播已读后，家长 B 必须仍看到未读，且广播行 status 不得被改写；
 *   - S3：管理员导入含 users/settings 的文件（含 replace=true），受保护表必须原样不动；
 *   - S9/S10：直接对守卫做单元级否定验证（role 缺失 / 非 HS256 签发的 token）。
 *
 * 运行（隔离库，绝不触碰真实库与 3001 端口上的线上服务）：
 *   node tests/batch7-security-guards.test.cjs
 *   PORT=3095 node tests/batch7-security-guards.test.cjs
 *
 * 退出码：发现失败则非 0。
 *
 * 注：本文件是新增的独立套件，**未**登记进 tests/run-all.cjs（该文件不在本次改动范围内），
 * 需要时手动运行或由维护者加入 SUITES 清单。
 */
'use strict';

// 端口必须在 require('../server') 之前设定：server.js:48 在模块加载时读取 PORT。
// 3001 被线上服务占用，这里默认走 3095，避免与线上服务冲突。
process.env.PORT = process.env.PORT || '3095';

const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-batch7');

const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { generateToken, verifyToken, JWT_SECRET, formatDate, now } = require('../utils');

const BASE = `http://localhost:${process.env.PORT}`;

let passed = 0, failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${ok ? '' : '  -> ' + detail}`);
}

async function call(method, p, { token, body, query } = {}) {
  let url = BASE + p;
  if (query) {
    const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) { /* 可能非 JSON */ }
  return { status: res.status, data };
}

const waitHealth = async (retries = 50) => {
  for (let i = 0; i < retries; i++) {
    try { const r = await call('GET', '/api/health'); if (r.status === 200) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

/** 列表里是否含某 id */
const hasId = (list, id) => Array.isArray(list) && list.some((r) => r.id === id);

async function main() {
  console.log('\n\x1b[1m=== Batch 7 安全守卫判别性测试 ===\x1b[0m');
  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '（测试库:', process.env.DB_PATH, '）\n');

  const db = new Database(process.env.DB_PATH);
  const IDS = resolveStaffIdentities(db);
  const tvOf = (openid) => (db.prepare('SELECT token_version FROM users WHERE openid = ?').get(openid) || {}).token_version || 0;
  const tokens = {
    admin: generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) }),
    coach: generateToken({ openid: IDS.coach, role: 'coach', tv: tvOf(IDS.coach) }),
  };

  // ── 夹具身份 ──────────────────────────────────────────────
  // 夹具（db/seed）固定提供 wx_parent_001 → stu_001、wx_parent_003 → stu_003。
  // 把 stu_001 放进班 A、stu_003 放进班 B，于是「家长 A 属于班 A」而班 B 与 A 无关。
  const parentA = 'wx_parent_001'; // 属于班 A
  const parentB = 'wx_parent_003'; // 属于班 B
  const tokParentA = generateToken({ openid: parentA, role: 'parent', tv: tvOf(parentA) });
  const tokParentB = generateToken({ openid: parentB, role: 'parent', tv: tvOf(parentB) });

  const t = () => now();
  const dateStr = formatDate(now());

  // 建两个班，并各自放入一个学员（同时写新旧两类关联表，覆盖两种可见性模型）
  db.prepare('INSERT OR REPLACE INTO classes (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('cls_b7_a', 'B7班A', 'active', t(), t());
  db.prepare('INSERT OR REPLACE INTO classes (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('cls_b7_b', 'B7班B', 'active', t(), t());
  db.prepare('INSERT OR REPLACE INTO class_members (class_id,student_id,role,joined_at) VALUES (?,?,?,?)')
    .run('cls_b7_a', 'stu_001', 'member', t());
  db.prepare('INSERT OR REPLACE INTO class_members (class_id,student_id,role,joined_at) VALUES (?,?,?,?)')
    .run('cls_b7_b', 'stu_003', 'member', t());

  // 今日排课：班 A 的、班 B 的、以及一条全员可见（class_id 与 group_course_id 均为空）
  const insSch = db.prepare(`INSERT OR REPLACE INTO schedules
    (id,course_id,course_name,teacher_id,date,start_time,end_time,status,class_id,group_course_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insSch.run('sch_b7_a', 'course_001', 'B7班A课程', 'teacher_001', dateStr, '08:00', '09:00', 'scheduled', 'cls_b7_a', '', t(), t());
  insSch.run('sch_b7_b', 'course_001', 'B7班B课程', 'teacher_001', dateStr, '09:00', '10:00', 'scheduled', 'cls_b7_b', '', t(), t());
  insSch.run('sch_b7_open', 'course_001', 'B7全员课程', 'teacher_001', dateStr, '10:00', '11:00', 'scheduled', '', '', t(), t());

  // ════════════════════════════════════════════════════════════
  // S5 — GET /api/schedules?classId= 的班级归属校验
  // ════════════════════════════════════════════════════════════
  console.log('\x1b[1m[S5] 排课查询 classId 跨班窥视\x1b[0m');
  {
    // 本组判别的是「可见性」而非「分页」，故显式放大 pageSize：
    // seed 现在覆盖历史 27 天 + 未来 7 天（≈34 节），默认分页 10 条、按 date 升序，
    // 会把本用例的今日夹具挤到第二页 —— 那是分页现象，与跨班可见性无关。
    // 前端排期页始终传 startDate（weekStart / monthStart），不存在这个问题。
    const ALL_PAGE = { pageSize: 500 };

    const peek = await call('GET', '/api/schedules', { token: tokParentA, query: { classId: 'cls_b7_b', ...ALL_PAGE } });
    rec('S5 家长读他人班级排课 → 403', peek.status === 403, `status=${peek.status}`);

    const own = await call('GET', '/api/schedules', { token: tokParentA, query: { classId: 'cls_b7_a', ...ALL_PAGE } });
    const ownList = (own.data && own.data.data && own.data.data.list) || [];
    rec('S5 家长读自己班级排课 → 200 且含本班排课',
      own.status === 200 && hasId(ownList, 'sch_b7_a'), `status=${own.status} ids=${ownList.map((r) => r.id)}`);
    rec('S5 自己班级的结果中不含他人班级排课',
      !hasId(ownList, 'sch_b7_b'), `ids=${ownList.map((r) => r.id)}`);

    const staff = await call('GET', '/api/schedules', { token: tokens.admin, query: { classId: 'cls_b7_b', ...ALL_PAGE } });
    const staffList = (staff.data && staff.data.data && staff.data.data.list) || [];
    rec('S5 管理员按班级筛选不受影响（仍可见班B）',
      staff.status === 200 && hasId(staffList, 'sch_b7_b'), `status=${staff.status} ids=${staffList.map((r) => r.id)}`);

    const noParam = await call('GET', '/api/schedules', { token: tokParentA, query: { ...ALL_PAGE } });
    const noParamList = (noParam.data && noParam.data.data && noParam.data.data.list) || [];
    rec('S5 家长不带 classId 时看不到他人班级排课',
      !hasId(noParamList, 'sch_b7_b') && hasId(noParamList, 'sch_b7_a'),
      `ids=${noParamList.map((r) => r.id)}`);
  }

  // ════════════════════════════════════════════════════════════
  // S4 — GET /api/schedules/today 的可见性强制
  // ════════════════════════════════════════════════════════════
  console.log('\x1b[1m[S4] 今日课表跨班窥视\x1b[0m');
  {
    const p = await call('GET', '/api/schedules/today', { token: tokParentA });
    const pl = (p.data && p.data.data && p.data.data.list) || [];
    rec('S4 家长今日课表不含他人班级排课', !hasId(pl, 'sch_b7_b'), `ids=${pl.map((r) => r.id)}`);
    rec('S4 家长今日课表含本班与全员可见排课',
      hasId(pl, 'sch_b7_a') && hasId(pl, 'sch_b7_open'), `ids=${pl.map((r) => r.id)}`);

    const a = await call('GET', '/api/schedules/today', { token: tokens.admin });
    const al = (a.data && a.data.data && a.data.data.list) || [];
    rec('S4 管理员今日课表仍为全量（含班B）', hasId(al, 'sch_b7_b'), `ids=${al.map((r) => r.id)}`);

    const c = await call('GET', '/api/schedules/today', { token: tokens.coach });
    rec('S4 教练今日课表仍为全量（员工路径未受影响）', c.status === 200, `status=${c.status}`);
  }

  // ════════════════════════════════════════════════════════════
  // S6 — 广播已读按用户记录，不得全局改写
  // ════════════════════════════════════════════════════════════
  console.log('\x1b[1m[S6] 广播通知已读的按用户语义\x1b[0m');
  {
    const bcId = 'ntf_b7_bc';
    db.prepare(`INSERT OR REPLACE INTO notifications
      (id,user_id,title,content,status,is_broadcast,group_name,category,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(bcId, '', 'B7广播', 'B7广播内容', 'sent', 1, '', 'system', t());

    const r = await call('PUT', `/api/messages/${bcId}/read`, { token: tokParentA });
    rec('S6 家长A标记广播已读 → 200', r.status === 200, `status=${r.status}`);

    const row = db.prepare('SELECT status FROM notifications WHERE id = ?').get(bcId);
    rec('S6 广播行 status 未被全局改写（仍为 sent）', row && row.status === 'sent', `status=${row && row.status}`);

    const readA = db.prepare('SELECT 1 FROM notification_reads WHERE notification_id = ? AND user_id = ?').get(bcId, parentA);
    rec('S6 已读按用户写入 notification_reads', !!readA);

    const la = await call('GET', '/api/notifications/list', { token: tokParentA });
    const itemA = ((la.data && la.data.data) || []).find((n) => n.id === bcId);
    rec('S6 家长A视角该广播为已读', !!itemA && itemA.isRead === true, `item=${JSON.stringify(itemA)}`);

    const lb = await call('GET', '/api/notifications/list', { token: tokParentB });
    const itemB = ((lb.data && lb.data.data) || []).find((n) => n.id === bcId);
    rec('S6 家长B视角该广播仍为未读（未被他人已读污染）',
      !!itemB && itemB.isRead === false, `item=${JSON.stringify(itemB)}`);

    // 定向通知回归：非接收人 403、接收人可写、且确实写回本行
    const pid = 'ntf_b7_direct';
    db.prepare(`INSERT OR REPLACE INTO notifications
      (id,user_id,title,content,status,is_broadcast,created_at) VALUES (?,?,?,?,?,0,?)`)
      .run(pid, parentA, 'B7定向', 'B7定向内容', 'sent', t());
    const rB = await call('PUT', `/api/messages/${pid}/read`, { token: tokParentB });
    rec('S6 定向通知非接收人标记 → 403', rB.status === 403, `status=${rB.status}`);
    const rA = await call('PUT', `/api/messages/${pid}/read`, { token: tokParentA });
    rec('S6 定向通知接收人标记 → 200', rA.status === 200, `status=${rA.status}`);
    const prow = db.prepare('SELECT status FROM notifications WHERE id = ?').get(pid);
    rec('S6 定向通知 status 正常写为 read', prow && prow.status === 'read', `status=${prow && prow.status}`);
  }

  // ════════════════════════════════════════════════════════════
  // S3 / S7 — JSON 导入不得覆盖受保护表；错误不得泄漏内部细节
  // ════════════════════════════════════════════════════════════
  console.log('\x1b[1m[S3/S7] JSON 导入的受保护表与错误脱敏\x1b[0m');
  {
    const beforeUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const adminBefore = db.prepare('SELECT role, password FROM users WHERE openid = ?').get(IDS.admin);
    const orgBefore = (db.prepare("SELECT value FROM settings WHERE key = 'org_info'").get() || {}).value;

    const payload = {
      meta: { app: 'edu-admin', format: 1, exportedAt: Date.now(), modules: ['users', 'settings', 'students'] },
      data: {
        users: { tables: { users: [{ id: 'usr_b7_hack', openid: 'wx_b7_hacked', role: 'admin', password: 'hacked', status: 'active', created_at: 1, updated_at: 1, token_version: 0 }] } },
        settings: { tables: { settings: [{ key: 'org_info', label: 'x', value: '{"name":"HACKED"}', description: '', updated_at: 1 }] } },
        students: { tables: { students: [{ id: 'stu_b7_imp', name: 'B7导入学员', status: 'active', created_at: 1, updated_at: 1 }] } },
      },
    };

    // replace=true 是最危险的组合：旧实现会先 DELETE FROM users/settings
    const r = await call('POST', '/api/settings/import', { token: tokens.admin, body: payload, query: { replace: 'true' } });
    rec('S3 导入请求本身成功返回', r.status === 200 && r.data && r.data.code === 0, `status=${r.status} body=${JSON.stringify(r.data)}`);

    const afterUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    rec('S3 replace=true 未清空 users 表', afterUsers === beforeUsers, `before=${beforeUsers} after=${afterUsers}`);

    const hacked = db.prepare('SELECT 1 FROM users WHERE openid = ?').get('wx_b7_hacked');
    rec('S3 文件中的后门账号未被写入', !hacked);

    const adminAfter = db.prepare('SELECT role, password FROM users WHERE openid = ?').get(IDS.admin);
    rec('S3 管理员口令与角色未被覆盖',
      adminAfter && adminBefore && adminAfter.role === adminBefore.role && adminAfter.password === adminBefore.password);

    const orgAfter = (db.prepare("SELECT value FROM settings WHERE key = 'org_info'").get() || {}).value;
    rec('S3 settings 表未被覆盖', orgAfter === orgBefore, `before=${orgBefore} after=${orgAfter}`);

    rec('S3 受保护表被跳过并在 errors 中说明',
      !!(r.data && r.data.data && Array.isArray(r.data.data.errors) && r.data.data.errors.some((e) => e.includes('受保护表'))),
      `errors=${JSON.stringify(r.data && r.data.data && r.data.data.errors)}`);

    rec('S3 非受保护表（students）仍正常导入',
      !!db.prepare('SELECT 1 FROM students WHERE id = ?').get('stu_b7_imp'));

    const audit = db.prepare("SELECT 1 FROM audit_log WHERE entity = 'data_import' AND action = 'import'").get();
    rec('S3 导入动作已写入审计日志', !!audit);

    // S7：触发一个抛错路径，响应不得回显内部错误原文
    const bad = await call('POST', '/api/settings/import', { token: tokens.admin, body: { meta: { app: 'edu-admin', format: 1 } } });
    const msg = (bad.data && bad.data.message) || '';
    rec('S7 导入失败返回通用安全文案',
      bad.status === 400 && msg === '导入失败，请查看服务端日志', `status=${bad.status} message=${msg}`);
    rec('S7 响应未泄漏内部错误原文（不含「文件中不包含」）', !msg.includes('文件中不包含'), `message=${msg}`);
  }

  // ════════════════════════════════════════════════════════════
  // S9 — requireStaffPerm 失败关闭
  // ════════════════════════════════════════════════════════════
  console.log('\x1b[1m[S9] requireStaffPerm 身份未知时拒绝\x1b[0m');
  {
    const { requireStaffPerm } = require('../middleware/authz');
    const mockRes = () => ({
      statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    });

    const r1 = mockRes();
    const ok1 = requireStaffPerm({ userRole: undefined }, r1, 'schedule', '排课');
    rec('S9 role 缺失 → 拒绝并回 403', ok1 === false && r1.statusCode === 403, `ret=${ok1} status=${r1.statusCode}`);

    const r2 = mockRes();
    const ok2 = requireStaffPerm({ userRole: null }, r2, 'schedule', '排课');
    rec('S9 role 为 null → 拒绝并回 403', ok2 === false && r2.statusCode === 403, `ret=${ok2} status=${r2.statusCode}`);

    const r3 = mockRes();
    const ok3 = requireStaffPerm({ userRole: 'parent' }, r3, 'schedule', '排课');
    rec('S9 家长（已定义的非员工角色）仍放行（回归）', ok3 === true, `ret=${ok3}`);

    const r4 = mockRes();
    const ok4 = requireStaffPerm({ userRole: 'admin' }, r4, 'schedule', '排课');
    rec('S9 管理员仍放行（回归）', ok4 === true, `ret=${ok4}`);
  }

  // ════════════════════════════════════════════════════════════
  // S10 — JWT 校验算法固定为 HS256
  // ════════════════════════════════════════════════════════════
  console.log('\x1b[1m[S10] JWT 校验算法固定\x1b[0m');
  {
    const hs512 = jwt.sign({ openid: IDS.admin, role: 'admin' }, JWT_SECRET, { algorithm: 'HS512' });
    rec('S10 HS512 签发的 token 被拒绝', verifyToken(hs512) === null);

    const legit = generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) });
    rec('S10 正常 HS256 token 仍可验证（回归）', !!verifyToken(legit));

    const noneAlg = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ openid: IDS.admin, role: 'admin' })).toString('base64url')}.`;
    rec('S10 alg=none 的 token 被拒绝', verifyToken(noneAlg) === null);
  }

  // ════════════════════════════════════════════════════════════
  // S11 — 家长绑定限流：轮换后4位无法绕过
  // ════════════════════════════════════════════════════════════
  console.log('\x1b[1m[S11] 绑定限流按目标学员\x1b[0m');
  {
    // 目标学员：真实手机后4位为 9999，攻击者不知道，需要枚举
    db.prepare('INSERT OR REPLACE INTO students (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('stu_b7_bind', 'B7限流学员', 'active', t(), t());
    db.prepare(`INSERT OR REPLACE INTO parent_bindings
      (student_id,student_name,parent_openid,parent_phone,relation,is_main,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run('stu_b7_bind', 'B7限流学员', '', '13700009999', '家长', 0, t());
    // 攻击者账号（须存在于 users 才能通过 token_version 校验）
    db.prepare('INSERT OR REPLACE INTO users (id,openid,role,status,created_at,updated_at,token_version) VALUES (?,?,?,?,?,?,0)')
      .run('usr_b7_atk', 'wx_b7_atk', 'parent', 'active', t(), t());
    const tokAtk = generateToken({ openid: 'wx_b7_atk', role: 'parent', tv: 0 });

    // 关键：每次换一个「不同的」错误后4位 —— 若限流只按 openid 或只按后4位计数，
    // 轮换后4位就能拿到独立配额，枚举将继续可行。按目标学员计数才能拦住。
    for (let i = 0; i < 5; i++) {
      await call('POST', '/api/auth/bindStudent', {
        token: tokAtk,
        body: { studentName: 'B7限流学员', phoneLast4: String(1001 + i) },
      });
    }
    const r6 = await call('POST', '/api/auth/bindStudent', {
      token: tokAtk,
      body: { studentName: 'B7限流学员', phoneLast4: '9999' }, // 正确后4位，但仍应被冷却拦下
    });
    rec('S11 轮换后4位枚举同一学员 → 第6次被 429 拦截', r6.status === 429, `status=${r6.status}`);

    // 反向对照：换一个学员 + 换一个账号，正常家长一次填对仍应成功（未破坏合法流程）
    db.prepare('INSERT OR REPLACE INTO students (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('stu_b7_ok', 'B7正常学员', 'active', t(), t());
    db.prepare(`INSERT OR REPLACE INTO parent_bindings
      (student_id,student_name,parent_openid,parent_phone,relation,is_main,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run('stu_b7_ok', 'B7正常学员', '', '13700008888', '家长', 0, t());
    db.prepare('INSERT OR REPLACE INTO users (id,openid,role,status,created_at,updated_at,token_version) VALUES (?,?,?,?,?,?,0)')
      .run('usr_b7_ok', 'wx_b7_ok', 'parent', 'active', t(), t());
    const tokOk = generateToken({ openid: 'wx_b7_ok', role: 'parent', tv: 0 });

    const rOk = await call('POST', '/api/auth/bindStudent', {
      token: tokOk,
      body: { studentName: 'B7正常学员', phoneLast4: '8888' },
    });
    rec('S11 正常家长一次填对仍可绑定（合法流程未被破坏）',
      rOk.status === 200 && rOk.data && rOk.data.code === 0, `status=${rOk.status} body=${JSON.stringify(rOk.data)}`);
  }

  // ════════════════════════════════════════════════════════════
  // S12 — 默认口令强制改密（登录判定一次 → JWT claim mcp → 中间件收口）
  // ════════════════════════════════════════════════════════════
  // 本段必须显式打开 FORCE_PASSWORD_CHANGE：run-all.cjs 为保住其余 15 个套件
  // （夹具账号就是默认口令）统一把它置为 '0'，而 isForcePasswordChange() 是
  // **每请求读取**环境变量，故这里在自己的进程内临时置 '1' 即可覆盖该强制行为。
  console.log('\x1b[1m[S12] 默认口令强制改密闭环\x1b[0m');
  {
    const prevForce = process.env.FORCE_PASSWORD_CHANGE;
    process.env.FORCE_PASSWORD_CHANGE = '1';
    try {
      // 夹具管理员：phone 13800000001 / 默认口令 123456（见 db/seed.js）
      const login = await call('POST', '/api/auth/login', {
        body: { phone: '13800000001', password: '123456', role: 'admin' },
      });
      const mustChange = !!(login.data && login.data.data && login.data.data.mustChangePassword === true);
      const mcpToken = (login.data && login.data.data && login.data.data.token) || '';
      rec('S12 默认口令登录 → mustChangePassword=true 且下发 token',
        login.status === 200 && login.data.code === 0 && mustChange && !!mcpToken,
        `status=${login.status} body=${JSON.stringify(login.data)}`);

      // 普通受保护接口：应被 4031 拦下（走的是业务路由之外，前端跳转无法绕过）
      const blocked = await call('GET', '/api/schedules/today', { token: mcpToken });
      rec('S12 持默认口令 token 访问普通受保护接口 → 403 且 code=4031',
        blocked.status === 403 && blocked.data && blocked.data.code === 4031,
        `status=${blocked.status} body=${JSON.stringify(blocked.data)}`);

      // 改密所需的白名单端点必须仍可达，否则用户无法自救（死锁）
      const prof = await call('GET', '/api/auth/getProfile', { token: mcpToken });
      rec('S12 /api/auth/getProfile 不被 4031 拦截（白名单生效）',
        prof.status === 200 && prof.data && prof.data.code === 0,
        `status=${prof.status} body=${JSON.stringify(prof.data)}`);

      // 闭环：新密码不得仍是默认口令，否则用户会原地打转
      const same = await call('POST', '/api/auth/changePassword', {
        token: mcpToken, body: { oldPassword: '123456', newPassword: '123456' },
      });
      rec('S12 新密码仍为默认口令 → 被拒（闭环）',
        same.status === 200 && same.data && same.data.code !== 0,
        `status=${same.status} body=${JSON.stringify(same.data)}`);

      // 正常改密后，新 token 不再带 mcp，立即恢复正常访问
      const chg = await call('POST', '/api/auth/changePassword', {
        token: mcpToken, body: { oldPassword: '123456', newPassword: 'B7NewPass2026' },
      });
      const newToken = (chg.data && chg.data.data && chg.data.data.token) || '';
      rec('S12 改密成功并签发新 token',
        chg.status === 200 && chg.data.code === 0 && !!newToken,
        `status=${chg.status} body=${JSON.stringify(chg.data)}`);

      const after = await call('GET', '/api/schedules/today', { token: newToken });
      rec('S12 改密后新 token 访问同一接口 → 恢复正常（不再 4031）',
        after.status === 200 && after.data && after.data.code === 0,
        `status=${after.status} body=${JSON.stringify(after.data)}`);
    } finally {
      // 还原环境变量，避免影响本文件后续/其他断言的口径
      if (prevForce === undefined) delete process.env.FORCE_PASSWORD_CHANGE;
      else process.env.FORCE_PASSWORD_CHANGE = prevForce;
    }
  }

  db.close();
  console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常', e); process.exit(2); });
