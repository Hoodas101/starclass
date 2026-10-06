/**
 * 星课教务系统 — 后端全功能系统测试
 *
 * 运行方式（隔离测试库，每次运行前重建 seed 夹具，绝不污染真实数据）：
 *   PORT=3099 NODE_ENV=test node tests/full-system.test.js
 *
 * 覆盖：
 *   A. 401 鉴权闸门扫描（所有受保护路由无 token 必须 401；公开路径必须非 401）
 *   B. 角色越权 403 矩阵（admin / coach / sales / parent 四类身份交叉校验）
 *   C. 各集合 happy-path 列表/详情读取
 *   D. 核心实体完整 CRUD（学员 / 课程 / 会员卡类型）
 *   E. 关键业务流（排课→报名→冲突校验、签到→上课记录、课时汇总数学、会员扣课、订单创建→支付→退款预览→取消、请假申请→审批→撤销）
 *   F. 边界用例（缺参 / 404 / 非法输入 / 家长越权）
 *
 * 退出码：发现真实后端缺陷（fail）则非 0，便于 CI 阻断。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---- 隔离环境（必须在 require('./server') 之前设置）----
process.env.PORT = process.env.PORT || '3099';
// 唯一引导路径：每次运行都重建 seed 夹具库，与 CI 完全一致。
// 历史上此处有「本地有 data.db 则复制快照，否则自举夹具」双分支，导致本地与 CI
// 跑的不是同一套代码路径（教练权限集、teacher_id 均不同）—— 已收敛为夹具单路径。
const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test');

const BASE = `http://localhost:${process.env.PORT}`;
const { generateToken } = require('../utils');

// ---- 种子身份（夹具 openid 为 wx_ 前缀，服务器启动后从库中按角色解析）----
let IDS;

// ---- 测试结果收集 ----
const results = [];
let passed = 0, failed = 0, warned = 0;
function rec(group, name, ok, detail) {
  if (ok) passed++; else failed++;
  results.push({ group, name, status: ok ? 'PASS' : 'FAIL', detail: ok ? '' : detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${group} › ${name}${ok ? '' : '  -> ' + detail}`);
}
function recWarn(group, name, detail) {
  warned++;
  results.push({ group, name, status: 'WARN', detail });
  console.log(`  [\x1b[33mWARN\x1b[0m] ${group} › ${name}  -> ${detail}`);
}
const inner = (r) => (r.data && r.data.data) || null;

// ---- HTTP 助手 ----
async function call(method, p, { token, body, query } = {}) {
  let url = BASE + p;
  if (query) {
    const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* 可能非 JSON */ }
  return { status: res.status, data };
}

async function waitHealth(retries = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await call('GET', '/api/health');
      if (r.status === 200) return true;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ============================================================
// 路由清单（来自 routes/*.js grep 快照 + server.js 顶层）
// ============================================================
const ROUTES = [
  ['POST', '/api/auth/upload/avatar'], ['GET', '/api/auth/getProfile'],
  ['POST', '/api/auth/bindStudent'], ['POST', '/api/auth/unbindStudent'],
  ['POST', '/api/auth/updateProfile'], ['POST', '/api/auth/changePassword'],
  ['POST', '/api/students'], ['POST', '/api/students/import'], ['GET', '/api/students'], ['GET', '/api/students/options'],
  ['GET', '/api/students/my'], ['GET', '/api/students/home/data'],
  ['GET', '/api/students/ID1'], ['GET', '/api/students/ID1/timeline'],
  ['PUT', '/api/students/ID1'], ['DELETE', '/api/students/ID1'],
  ['GET', '/api/students/ID1/stats'], ['GET', '/api/students/ID1/activities'],
  ['POST', '/api/students/ID1/qrcode'],
  ['POST', '/api/schedules'], ['POST', '/api/schedules/recursive'], ['GET', '/api/schedules'], ['GET', '/api/schedules/options'],
  ['GET', '/api/schedules/my'], ['GET', '/api/schedules/today'], ['GET', '/api/schedules/coach'],
  ['GET', '/api/schedules/coach/classes'], ['GET', '/api/schedules/admin/coach-classes'],
  ['GET', '/api/schedules/coach/stats'], ['GET', '/api/schedules/admin/coach-stats'],
  ['POST', '/api/schedules/ID1/enroll'], ['DELETE', '/api/schedules/ID1/enroll'],
  ['GET', '/api/schedules/ID1'], ['PUT', '/api/schedules/ID1'], ['DELETE', '/api/schedules/ID1'],
  ['POST', '/api/schedules/conflict-check'],
  // 周期排课规则 CRUD（routes/schedules.js）：此前规则只增不减，本轮补全后必须同步本清单。
  ['GET', '/api/schedules/rules'], ['PUT', '/api/schedules/rules/ID1'], ['DELETE', '/api/schedules/rules/ID1'],
  ['POST', '/api/checkin/teacher'], ['POST', '/api/checkin/parent'], ['GET', '/api/checkin/records'],
  ['GET', '/api/checkin/today'], ['POST', '/api/checkin/auto-absent'],
  ['GET', '/api/attendances'], ['GET', '/api/attendances/student/STU1'], ['GET', '/api/attendances/summary'],
  // 体测模块（migrations/024 + routes/physical-tests.js）：新增受保护路由必须同步本清单，
  // 否则 A3-scan-coverage 的源码交叉校验会立刻报「未覆盖」。
  ['GET', '/api/physical-tests'], ['POST', '/api/physical-tests'],
  ['PUT', '/api/physical-tests/ID1'], ['DELETE', '/api/physical-tests/ID1'],
  ['POST', '/api/membership/pause'], ['POST', '/api/membership/resume'], ['POST', '/api/membership/card-type'],
  ['PUT', '/api/membership/card-type/ID1'], ['DELETE', '/api/membership/card-type/ID1'],
  ['POST', '/api/membership/activate'], ['GET', '/api/membership/my'], ['POST', '/api/membership/deduct'],
  ['POST', '/api/membership/refund'], ['GET', '/api/membership/deductions'], ['GET', '/api/membership/expiring'],
  // 会员卡实例列表 + 卡转让（migrations/026 + routes/membership.js）
  ['GET', '/api/membership/cards'], ['POST', '/api/membership/card/ID1/transfer'],
  ['POST', '/api/points/add'], ['POST', '/api/points/consume'], ['GET', '/api/points/balance'],
  ['GET', '/api/points/logs'], ['GET', '/api/points/ranking'], ['POST', '/api/points/share'], ['GET', '/api/points/rules'],
  ['POST', '/api/orders'], ['POST', '/api/orders/import'], ['GET', '/api/orders/my'],
  ['POST', '/api/orders/ID1/pay'], ['GET', '/api/orders/ID1/refund-preview'], ['POST', '/api/orders/ID1/refund'],
  ['PUT', '/api/orders/ID1'], ['POST', '/api/orders/ID1/cancel'], ['GET', '/api/orders/stats'], ['GET', '/api/orders'],
  ['GET', '/api/messages/list'], ['GET', '/api/messages/detail'], ['GET', '/api/messages/unread-count'],
  ['POST', '/api/messages/create'], ['POST', '/api/messages/generate-renewal'], ['POST', '/api/messages/read'],
  ['POST', '/api/messages/read-all'], ['GET', '/api/messages/group-notice'], ['POST', '/api/messages/send'],
  ['GET', '/api/messages/my'], ['PUT', '/api/messages/ID1/read'], ['PUT', '/api/messages/read-all'],
  ['GET', '/api/messages/admin/list'], ['DELETE', '/api/messages/ID1'],
  ['GET', '/api/admin/dashboard'], ['GET', '/api/admin/charts'], ['GET', '/api/admin/export'],
  ['GET', '/api/admin/audit-logs'],
  // 关注雷达聚合（dashboard 侧栏）
  ['GET', '/api/admin/attention'],
  ['GET', '/api/admin/suppressions'], ['POST', '/api/admin/suppressions'], ['DELETE', '/api/admin/suppressions/ID1'],
  ['GET', '/api/admin/teachers'], ['GET', '/api/admin/parents'], ['GET', '/api/admin/staff-options'],
  // 教师轻量选项（上课记录页教师筛选此前 404，本轮补别名路由）
  ['GET', '/api/admin/teachers/options'],
  // 存量脏数据体检 / 一次性清理（routes/admin.js）：新增受保护路由必须同步本清单
  ['GET', '/api/admin/data-health'], ['POST', '/api/admin/data-cleanup'],
  ['POST', '/api/admin/teachers'], ['PUT', '/api/admin/teachers/ID1'], ['DELETE', '/api/admin/teachers/ID1'],
  // 场地管理（此前只有 GET，本轮补 POST/PUT/DELETE）
  ['GET', '/api/admin/classrooms'], ['POST', '/api/admin/classrooms'],
  ['PUT', '/api/admin/classrooms/ID1'], ['DELETE', '/api/admin/classrooms/ID1'],
  ['GET', '/api/admin/courses'], ['GET', '/api/admin/courses/options'], ['POST', '/api/admin/courses'],
  ['PUT', '/api/admin/courses/ID1'], ['DELETE', '/api/admin/courses/ID1'],
  ['GET', '/api/admin/courses/ID1/members'], ['POST', '/api/admin/courses/ID1/members'],
  ['DELETE', '/api/admin/courses/ID1/members/STU1'], ['GET', '/api/admin/backup'],
  ['PUT', '/api/settings'], ['GET', '/api/settings/data-modules'], ['GET', '/api/settings/export'],
  ['POST', '/api/settings/import'], ['POST', '/api/settings/db-restore'], ['GET', '/api/settings/backups'],
  ['POST', '/api/settings/backups/create'], ['DELETE', '/api/settings/backups/ID1'],
  ['POST', '/api/leave/apply'], ['GET', '/api/leave/my'], ['GET', '/api/leave'], ['PUT', '/api/leave/ID1/approve'],
  ['POST', '/api/leave/ID1/cancel'],
  ['POST', '/api/feedback/apply'], ['GET', '/api/feedback/my'], ['GET', '/api/feedback'], ['PUT', '/api/feedback/ID1/status'],
  ['GET', '/api/growth/funnel'], ['GET', '/api/growth/leads'], ['POST', '/api/growth/leads'],
  ['PUT', '/api/growth/leads/ID1'], ['DELETE', '/api/growth/leads/ID1'], ['POST', '/api/growth/leads/ID1/convert'],
  ['POST', '/api/growth/leads/ID1/stage'], ['GET', '/api/growth/churn'], ['GET', '/api/growth/renewal'],
  ['GET', '/api/growth/low-classes'], ['GET', '/api/growth/referrals'], ['GET', '/api/growth/points/summary'],
  ['GET', '/api/growth/points/list'], ['GET', '/api/growth/points/logs'], ['POST', '/api/growth/points/adjust'],
  ['GET', '/api/growth/points/ranking'],
  ['POST', '/api/followups/generate'], ['GET', '/api/followups'], ['GET', '/api/followups/today'],
  ['POST', '/api/followups'], ['POST', '/api/followups/ID1/complete'], ['POST', '/api/followups/ID1/cancel'],
  ['GET', '/api/payroll/coaches'], ['GET', '/api/payroll/coach/ID1'], ['PUT', '/api/payroll/coach/ID1/rule'], ['GET', '/api/payroll/me'],
  ['POST', '/api/comments'], ['GET', '/api/comments'], ['GET', '/api/comments/my'],
  ['GET', '/api/makeup/eligible'], ['POST', '/api/makeup/assign'], ['POST', '/api/makeup/cancel'],
  ['GET', '/api/makeup/records'], ['POST', '/api/makeup/reschedule'],
  ['GET', '/api/finance/summary'], ['GET', '/api/finance/monthly'], ['GET', '/api/finance/by-product'], ['GET', '/api/finance/by-sales'],
  ['GET', '/api/trial/list'], ['GET', '/api/trial/ID1'], ['POST', '/api/trial/ID1/convert'], ['PUT', '/api/trial/ID1'],
  ['GET', '/api/wxpay/status'], ['POST', '/api/wxpay/create'],

  // ---- C7 补扫：以下 42 条此前完全不在扫描清单内，等于鉴权闸门对它们零覆盖 ----
  // 清单来源：把 backend/routes/*.js 的全部 router.<verb> 按 server.js 的挂载前缀
  // 展开，与上方清单做集合差得到。每一条都实测过「无 token → 401」，不是照抄路由表。
  // /api/classes/*（16 条）：课程模块整块此前靠注入 header 绕过 JWT，
  // 是本次补扫里最要紧的一组 —— 一个整体未被闸门覆盖的模块。
  ['POST', '/api/classes'], ['GET', '/api/classes'], ['GET', '/api/classes/ID1'],
  ['PUT', '/api/classes/ID1'], ['DELETE', '/api/classes/ID1'],
  ['GET', '/api/classes/ID1/members'], ['POST', '/api/classes/ID1/members'],
  ['PUT', '/api/classes/ID1/members/STU1'], ['DELETE', '/api/classes/ID1/members/STU1'],
  ['POST', '/api/classes/ID1/notify'], ['POST', '/api/classes/schedules/SCH1/request'],
  ['GET', '/api/classes/schedules/SCH1/requests/mine'], ['GET', '/api/classes/registration-requests'],
  ['GET', '/api/classes/ID1/registration-requests'],
  ['POST', '/api/classes/ID1/registration-requests/REQ1/approve'],
  ['POST', '/api/classes/ID1/registration-requests/REQ1/reject'],
  // /api/notifications/*（13 条）：server.js 把 messageRoutes 同时挂在 /api/notifications 上，
  // 此前只扫了 /api/messages/*，同一批处理器的另一个入口无人看守。
  ['GET', '/api/notifications/list'], ['GET', '/api/notifications/detail'],
  ['GET', '/api/notifications/unread-count'], ['POST', '/api/notifications/create'],
  ['POST', '/api/notifications/generate-renewal'], ['POST', '/api/notifications/read'],
  ['POST', '/api/notifications/read-all'], ['GET', '/api/notifications/group-notice'],
  ['POST', '/api/notifications/send'], ['GET', '/api/notifications/my'],
  ['PUT', '/api/notifications/ID1/read'], ['PUT', '/api/notifications/read-all'],
  ['GET', '/api/notifications/admin/list'], ['DELETE', '/api/notifications/ID1'],
  // 零覆盖端点：增长建议、薪资结算与流水、学员分班、反馈回复等
  ['GET', '/api/growth/suggestions'], ['GET', '/api/growth/leads/ID1/suggestion'],
  ['POST', '/api/payroll/settle'], ['GET', '/api/payroll/logs'], ['POST', '/api/payroll/logs/ID1/void'],
  ['GET', '/api/admin/students/STU1/classes'], ['POST', '/api/admin/students/STU1/classes'],
  ['GET', '/api/membership/card-types'], ['GET', '/api/membership/products'],
  ['GET', '/api/settings/terms'], ['GET', '/api/leave/rules'], ['PUT', '/api/feedback/ID1/reply'],
];
const PUBLIC = [
  ['POST', '/api/auth/login'], ['POST', '/api/auth/wx-login'], ['POST', '/api/auth/phone-login'],
  ['GET', '/api/health'], ['POST', '/api/trial/apply'], ['POST', '/api/wxpay/notify'],
  ['GET', '/api/terms'], ['GET', '/api/settings'],
];

// ---- Batch 9（C7）：补齐此前未纳入 401 扫描的端点 ----
// 缺口是逐路由 grep + 与上方 ROUTES 求差集算出来的（挂载点取自 server.js 的 app.use）。
// /api/classes/* 全部缺席，而它恰恰是历史上「注入 x-openid 头即可绕过 JWT」的那一批，
// 因此单独成组，供下方 A3 段做伪造头回归。
const CLASSES_ROUTES = [
  ['POST', '/api/classes'], ['GET', '/api/classes'],
  ['GET', '/api/classes/ID1'], ['PUT', '/api/classes/ID1'], ['DELETE', '/api/classes/ID1'],
  ['GET', '/api/classes/ID1/members'], ['POST', '/api/classes/ID1/members'],
  ['PUT', '/api/classes/ID1/members/STU1'], ['DELETE', '/api/classes/ID1/members/STU1'],
  ['POST', '/api/classes/ID1/notify'],
  ['POST', '/api/classes/schedules/SCH1/request'], ['GET', '/api/classes/schedules/SCH1/requests/mine'],
  ['GET', '/api/classes/registration-requests'], ['GET', '/api/classes/ID1/registration-requests'],
  ['POST', '/api/classes/ID1/registration-requests/REQ1/approve'],
  ['POST', '/api/classes/ID1/registration-requests/REQ1/reject'],
];
const ROUTES_EXTRA = [
  // 零覆盖端点（此前既不在 ROUTES 也不在任何用例中）
  ['GET', '/api/growth/suggestions'], ['GET', '/api/growth/leads/ID1/suggestion'],
  ['GET', '/api/leave/rules'],
  ['GET', '/api/membership/card-types'], ['GET', '/api/membership/products'],
  ['GET', '/api/payroll/logs'], ['POST', '/api/payroll/logs/ID1/void'], ['POST', '/api/payroll/settle'],
  ['GET', '/api/admin/students/ID1/classes'], ['POST', '/api/admin/students/ID1/classes'],
  ['GET', '/api/attendances/student/ID1'],
  ['PUT', '/api/feedback/ID1/reply'],
  // /api/notifications 是 messageRoutes 的第二个挂载点（server.js:222），与 /api/messages/* 同处理器
  ['GET', '/api/notifications/list'], ['GET', '/api/notifications/detail'],
  ['GET', '/api/notifications/unread-count'], ['POST', '/api/notifications/create'],
  ['POST', '/api/notifications/generate-renewal'], ['POST', '/api/notifications/read'],
  ['POST', '/api/notifications/read-all'], ['GET', '/api/notifications/group-notice'],
  ['POST', '/api/notifications/send'], ['GET', '/api/notifications/my'],
  ['PUT', '/api/notifications/ID1/read'], ['PUT', '/api/notifications/read-all'],
  ['GET', '/api/notifications/admin/list'], ['DELETE', '/api/notifications/ID1'],
];
// 三个来源存在重叠：C7 补扫时已把 classes 与「零覆盖端点」并入 ROUTES，
// CLASSES_ROUTES / ROUTES_EXTRA 保留下来是为了各自的用途（前者供下方 A3 伪造头用例遍历，
// 后者标注「此前零覆盖」的来源）。若直接拼接，同一端点会被扫描两次并产生重复断言 ——
// 断言数虚高，且失败时会刷两遍同样的红。故此处按「方法 + 归一化路径」去重。
// 归一化把 :param 与测试占位符（ID1/STU1/SCH1/REQ1…）视为同一段，
// 否则 /api/attendances/student/STU1 与 /api/attendances/student/ID1 会被当成两个端点。
const dedupeProtected = (list) => {
  const PLACEHOLDER = /^(?::.+|ID\d*|STU\d*|SCH\d*|REQ\d*|NO_SUCH_ID|NO_SUCH_STU|SCHED\d*)$/i;
  const norm = (p) => p.split('/').map((s) => (PLACEHOLDER.test(s) ? ':x' : s)).join('/');
  const seen = new Set();
  const out = [];
  for (const [m, p] of list) {
    const k = `${m} ${norm(p)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([m, p]);
  }
  return out;
};
const ALL_PROTECTED = dedupeProtected([...ROUTES, ...CLASSES_ROUTES, ...ROUTES_EXTRA]);

const ts = () => Date.now();
const pad = (n) => String(n).padStart(2, '0');
const futureDay = (days) => { const d = new Date(Date.now() + days * 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// ============================================================
async function main() {
  console.log('\n\x1b[1m=== 星课教务系统 全功能后端测试 ===\x1b[0m');
  await require('../server');
  const up = await waitHealth();
  if (!up) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '（测试库:', process.env.DB_PATH, '）\n');

  // token_version 吊销校验：自签 Token 需携带与库中一致的 tv（服务器启动时已跑迁移 012）
  const Database = require('better-sqlite3');
  const tvdb = new Database(process.env.DB_PATH);
  // 夹具身份 openid 是 wx_ 前缀，按角色动态解析；解析不到会直接失败（而非静默用不存在的身份）
  IDS = resolveStaffIdentities(tvdb);
  const tvOf = (openid) => (tvdb.prepare('SELECT token_version FROM users WHERE openid = ?').get(openid) || {}).token_version || 0;
  const tokens = {
    admin: generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) }),
    coach: generateToken({ openid: IDS.coach, role: 'coach', tv: tvOf(IDS.coach) }),
    sales: generateToken({ openid: IDS.sales, role: 'sales', tv: tvOf(IDS.sales) }),
  };
  tvdb.close();

  const tdb = new Database(process.env.DB_PATH, { readonly: true });
  const bound = tdb.prepare(`
    SELECT pb.parent_openid, pb.student_id, s.name AS stu_name, u.token_version AS tv
    FROM parent_bindings pb
    JOIN users u ON u.openid = pb.parent_openid AND u.role = 'parent'
    JOIN students s ON s.id = pb.student_id
    LIMIT 1
  `).get();
  tdb.close();
  let parentToken = null, parentStudentId = null;
  if (bound) {
    parentToken = generateToken({ openid: bound.parent_openid, role: 'parent', tv: bound.tv || 0 });
    parentStudentId = bound.student_id;
    console.log(`家长身份: ${bound.parent_openid} 绑定学员 ${bound.student_id}(${bound.stu_name})\n`);
  } else {
    // 夹具退化必须变红：seed 固定生成 12 组家长绑定（db/seed.js），解析不到说明夹具坏了，
    // 静默 WARN 会让「家长越权 / 请假流程」整块用例凭空消失而套件仍绿。
    rec('setup', '存在已绑定学员的家长账号（夹具完整性）', false,
      '夹具缺少 parent_bindings —— 家长相关用例无法执行，视为失败');
  }

  // ---------------- A. 401 扫描 ----------------
  console.log('\x1b[1m[A] 401 鉴权闸门扫描\x1b[0m');
  console.log(`  扫描受保护端点 ${ALL_PROTECTED.length} 个（去重前 ROUTES ${ROUTES.length} + classes ${CLASSES_ROUTES.length} + 补齐 ${ROUTES_EXTRA.length}）`);
  for (const [m, p] of ALL_PROTECTED) {
    const r = await call(m, p);
    rec('A-auth-gate', `${m} ${p}`, r.status === 401, `status=${r.status}`);
  }
  for (const [m, p] of PUBLIC) {
    const r = await call(m, p);
    rec('A-public', `${m} ${p}`, r.status !== 401, `status=${r.status}（期望非 401）`);
  }

  // ---------------- A2. P0-1：URL 大小写绕过鉴权 ----------------
  console.log('\x1b[1m[A2] P0-1 URL 大小写绕过鉴权\x1b[0m');
  // 受保护路由的大写形式，无 token 必须 401。修复前：Express 路由大小写不敏感会把
  // /API/schedules/ID1 解析到 /api/schedules/ID1 处理器，而鉴权守卫用大小写敏感的
  // startsWith('/api') 判定，导致大写路径跳过鉴权却仍命中受保护路由。
  const upperProtected = ['/API/schedules/ID1', '/API/students', '/API/orders', '/API/admin/dashboard', '/API/membership/deduct'];
  for (const p of upperProtected) {
    const r = await call('POST', p);
    rec('A2-case-bypass', `POST ${p}`, r.status === 401, `status=${r.status}（期望 401）`);
  }
  // 公开路由的大写形式仍应可达（非 401），证明大小写归一后公开路径未被误伤
  const rLogin = await call('POST', '/API/auth/login');
  rec('A2-case-public-login', 'POST /API/auth/login', rLogin.status !== 401, `status=${rLogin.status}（期望非 401）`);
  const rHealth = await call('GET', '/API/health');
  rec('A2-case-public-health', 'GET /API/health', rHealth.status !== 401, `status=${rHealth.status}（期望非 401）`);

  // ---------------- A3. 扫描清单自证（防漏网） ----------------
  // 上面的 ROUTES 是一份**手写**清单，手写清单的天敌是「新路由悄悄加进来、闸门没跟上」。
  // 这里用源码做交叉校验：把 routes/*.js 的路由按挂载前缀展开后，与 ROUTES 求差集。
  // 若有人新增了受保护路由却没同步清单，本用例立刻变红 —— 而不是等某天有人发现闸门形同虚设。
  {
    const fsx = require('fs');
    const MOUNTS = [
      ['/api/auth', 'auth.js'], ['/api/students', 'students.js'], ['/api/schedules', 'schedules.js'],
      ['/api/classes', 'classes.js'], ['/api/checkin', 'checkin.js'], ['/api/membership', 'membership.js'],
      ['/api/points', 'points.js'], ['/api/orders', 'orders.js'], ['/api/messages', 'messages.js'],
      ['/api/notifications', 'messages.js'], ['/api/admin', 'admin.js'], ['/api/settings', 'settings.js'],
      ['/api/leave', 'leave.js'], ['/api/feedback', 'feedback.js'], ['/api/growth', 'growth.js'],
      ['/api/followups', 'followups.js'], ['/api/payroll', 'payroll.js'], ['/api/comments', 'comments.js'],
      ['/api/makeup', 'makeup.js'], ['/api/finance', 'finance.js'], ['/api/attendances', 'attendances.js'],
      ['/api/trial', 'trial.js'], ['/api/wxpay', 'wxpay.js'],
      ['/api/physical-tests', 'physical-tests.js'],
    ];
    const PLACEHOLDER = /^(?::.+|ID\d*|STU\d*|SCH\d*|REQ\d*|NO_SUCH_ID|NO_SUCH_STU|SCHED\d*)$/i;
    const norm = (p) => p.split('/').map((s) => (PLACEHOLDER.test(s) ? ':x' : s)).join('/').replace(/\/+$/, '') || '/';
    const k = (m, p) => `${m} ${norm(p)}`;
    const declared = new Map();
    for (const [prefix, file] of MOUNTS) {
      const src = fsx.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
      const re = /router\.(get|post|put|delete|patch)\(\s*'([^']*)'/g;
      let m;
      while ((m = re.exec(src))) {
        const full = prefix + (m[2] === '/' ? '' : m[2]);
        declared.set(k(m[1].toUpperCase(), full), `${m[1].toUpperCase()} ${full}`);
      }
    }
    const covered = new Set([...ROUTES, ...PUBLIC].map(([m, p]) => k(m, p)));
    const uncovered = [...declared.entries()].filter(([key]) => !covered.has(key)).map(([, label]) => label);
    rec('A3-scan-coverage', `ROUTES 覆盖源码全部路由（未覆盖 ${uncovered.length} 条）`,
      uncovered.length === 0, `未覆盖：${uncovered.slice(0, 10).join(' | ')}`);

    // classes.js 是最容易被漏掉的一整块（历史上靠注入 header 绕过 JWT），单独钉死条数。
    const classesDeclared = [...declared.values()].filter((s) => s.includes('/api/classes')).length;
    const classesScanned = ROUTES.filter(([, p]) => p.startsWith('/api/classes')).length;
    rec('A3-scan-classes', `classes.js 的 ${classesDeclared} 条路由全部在扫描清单内`,
      classesDeclared === 16 && classesScanned === 16, `declared=${classesDeclared} scanned=${classesScanned}`);

    // 去重自证：ALL_PROTECTED 里不得有重复端点（否则断言数虚高，失败会刷两遍）。
    // 三个来源数组本身允许重叠，重复必须在 dedupeProtected 处被吸收 —— 这条钉死该不变量。
    const rawCount = ROUTES.length + CLASSES_ROUTES.length + ROUTES_EXTRA.length;
    rec('A3-scan-dedup', `扫描清单已去重（原始 ${rawCount} → 实际 ${ALL_PROTECTED.length}）`,
      ALL_PROTECTED.length <= rawCount && ALL_PROTECTED.length > 0,
      `raw=${rawCount} deduped=${ALL_PROTECTED.length}`);
  }

  // ---------------- A3. 注入身份头不得绕过 JWT ----------------
  // 身份的唯一可信来源是 Authorization: Bearer。客户端可自填的 x-openid / ?openid= /
  // body.openid 一律不得作为鉴权依据 —— /api/classes/* 历史上正是从 header 取身份，
  // 于是「不带 token + 伪造 x-openid」即可读写班级数据。此段逐端点钉死该回归。
  console.log('\x1b[1m[A3] 注入 x-openid 头绕过鉴权\x1b[0m');
  {
    const forgedHeaders = { 'Content-Type': 'application/json', 'x-openid': 'wx_admin_001' };
    for (const [m, p] of CLASSES_ROUTES) {
      const res = await fetch(BASE + p, { method: m, headers: forgedHeaders });
      rec('A3-forged-x-openid-classes', `${m} ${p}`, res.status === 401,
        `status=${res.status}（伪造 x-openid 后仍须 401）`);
    }
    // 管理端/财务端点同样不得凭伪造头通过
    for (const [m, p] of [['GET', '/api/admin/dashboard'], ['POST', '/api/payroll/settle'],
      ['GET', '/api/finance/summary'], ['GET', '/api/orders']]) {
      const res = await fetch(BASE + p, { method: m, headers: forgedHeaders });
      rec('A3-forged-x-openid-admin', `${m} ${p}`, res.status === 401,
        `status=${res.status}（伪造 x-openid 后仍须 401）`);
    }
  }

  // ---------------- B. 角色越权 403 矩阵 ----------------
  console.log('\n\x1b[1m[B] 角色越权矩阵\x1b[0m');
  const adminOnly = [
    ['POST', '/api/students'], ['PUT', '/api/settings'], ['GET', '/api/admin/export'],
    ['POST', '/api/admin/teachers'], ['DELETE', '/api/admin/teachers/ID1'],
    ['POST', '/api/admin/courses'], ['DELETE', '/api/admin/courses/ID1'],
    ['GET', '/api/admin/parents'], ['POST', '/api/settings/backups/create'],
  ];
  for (const role of ['coach', 'sales', 'parent']) {
    if (role === 'parent' && !parentToken) continue;
    for (const [m, p] of adminOnly) {
      const tk = role === 'parent' ? parentToken : tokens[role];
      const r = await call(m, p, { token: tk });
      rec(`B-403-adminOnly-vs-${role}`, `${m} ${p}`, r.status === 403, `status=${r.status}`);
    }
  }
  const coachOnly = [['POST', '/api/checkin/teacher'], ['PUT', '/api/leave/ID1/approve']];
  for (const role of ['sales', 'parent']) {
    if (role === 'parent' && !parentToken) continue;
    const tk = role === 'parent' ? parentToken : tokens[role];
    for (const [m, p] of coachOnly) {
      const r = await call(m, p, { token: tk });
      rec(`B-403-coachOnly-vs-${role}`, `${m} ${p}`, r.status === 403, `status=${r.status}`);
    }
  }
  if (parentToken) {
    const r = await call('GET', '/api/attendances', { token: parentToken });
    rec('B-403-staffOnly-vs-parent', 'GET /api/attendances', r.status === 403, `status=${r.status}`);
    // 积分排行榜含全机构学员姓名与积分，仅员工可见；家长调用必须 403 而非拿到名单
    const rRank = await call('GET', '/api/points/ranking', { token: parentToken });
    rec('B-403-staffOnly-vs-parent', 'GET /api/points/ranking', rRank.status === 403, `status=${rRank.status}`);
  }
  // 排课创建权限：教练可创建（isCoachReq），销售不可（仍 403）
  {
    const day = futureDay(5);
    const coachCreate = await call('POST', '/api/schedules', { token: tokens.coach, body: {
      courseName: '教练自建_' + ts(), date: day, startTime: '16:00', endTime: '17:00', teacherId: IDS.coach,
    }});
    const okCoach = coachCreate.status === 200 && coachCreate.data && coachCreate.data.code === 0 && inner(coachCreate) && inner(coachCreate).id;
    rec('B-schedule-coach-create', 'POST /api/schedules (教练可创建)', okCoach, okCoach ? '' : `status=${coachCreate.status} body=${JSON.stringify(coachCreate.data)}`);
    if (okCoach) await call('DELETE', `/api/schedules/${inner(coachCreate).id}`, { token: tokens.admin });
    const salesCreate = await call('POST', '/api/schedules', { token: tokens.sales, body: {
      courseName: '销售自建', date: day, startTime: '16:00', endTime: '17:00', teacherId: IDS.coach,
    }});
    rec('B-schedule-sales-blocked', 'POST /api/schedules (销售被拒)', salesCreate.status === 403, `status=${salesCreate.status}`);
  }

  // ---------------- C. happy-path 列表读取 ----------------
  console.log('\n\x1b[1m[C] 集合列表/详情 happy-path\x1b[0m');
  // [method, path, token, query]
  const lists = [
    ['GET', '/api/students', tokens.admin], ['GET', '/api/schedules', tokens.admin],
    ['GET', '/api/attendances', tokens.admin], ['GET', '/api/attendances/summary', tokens.admin],
    ['GET', '/api/admin/courses', tokens.admin], ['GET', '/api/admin/teachers', tokens.admin],
    ['GET', '/api/orders', tokens.admin], ['GET', '/api/orders/stats', tokens.admin],
    ['GET', '/api/finance/summary', tokens.admin], ['GET', '/api/growth/leads', tokens.admin],
    ['GET', '/api/leave', tokens.admin], ['GET', '/api/feedback', tokens.admin],
    ['GET', '/api/messages/admin/list', tokens.admin], ['GET', '/api/payroll/coaches', tokens.admin, { month: '2026-08' }],
    ['GET', '/api/payroll/me', tokens.coach],
    ['GET', '/api/membership/card-types', tokens.admin], ['GET', '/api/membership/products', tokens.admin],
    ['GET', '/api/points/ranking', tokens.admin], ['GET', '/api/followups', tokens.admin],
    ['GET', '/api/makeup/records', tokens.admin], ['GET', '/api/admin/dashboard', tokens.admin],
    ['GET', '/api/admin/charts', tokens.admin],
  ];
  for (const [m, p, tk, q] of lists) {
    const r = await call(m, p, { token: tk, query: q });
    // happy-path：返回 200 + code 0 + 有效 data 负载（不绑定各端点具体字段形状）
    const ok = r.status === 200 && r.data && r.data.code === 0 && inner(r) !== null;
    rec('C-list', `${m}${q ? '?' + Object.entries(q).map(([k, v]) => k + '=' + v).join('&') : ''}`, ok, ok ? '' : `status=${r.status} code=${r.data && r.data.code}`);
  }

  // ---------------- D. 核心实体 CRUD ----------------
  console.log('\n\x1b[1m[D] 核心实体完整 CRUD\x1b[0m');
  {
    const create = await call('POST', '/api/students', { token: tokens.admin, body: {
      name: '测试学员_' + ts(), gender: '男', phone: '139' + String(Math.floor(Math.random() * 90000000) + 10000000),
    }});
    const okCreate = create.status === 200 && create.data && create.data.code === 0 && inner(create) && inner(create).id;
    rec('D-students-create', 'POST /api/students', okCreate, okCreate ? '' : `status=${create.status} body=${JSON.stringify(create.data)}`);
    const newId = okCreate ? inner(create).id : 'ID1';
    const upd = await call('PUT', `/api/students/${newId}`, { token: tokens.admin, body: { name: '改名_测试', level: 'L1' } });
    rec('D-students-update', 'PUT /api/students/:id', upd.status === 200 && upd.data && upd.data.code === 0, `status=${upd.status}`);
    const del = await call('DELETE', `/api/students/${newId}`, { token: tokens.admin });
    rec('D-students-delete', 'DELETE /api/students/:id', del.status === 200 && del.data && del.data.code === 0, `status=${del.status}`);
  }
  {
    const create = await call('POST', '/api/admin/courses', { token: tokens.admin, body: {
      name: '测试课程_' + ts(), description: '自动化测试创建', color: '#3B82F6',
    }});
    const okCreate = create.status === 200 && create.data && create.data.code === 0 && inner(create) && inner(create).id;
    rec('D-courses-create', 'POST /api/admin/courses', okCreate, okCreate ? '' : `status=${create.status} body=${JSON.stringify(create.data)}`);
    const newId = okCreate ? inner(create).id : 'ID1';
    const upd = await call('PUT', `/api/admin/courses/${newId}`, { token: tokens.admin, body: { name: '改名课程' } });
    rec('D-courses-update', 'PUT /api/admin/courses/:id', upd.status === 200 && upd.data && upd.data.code === 0, `status=${upd.status}`);
    const del = await call('DELETE', `/api/admin/courses/${newId}`, { token: tokens.admin });
    rec('D-courses-delete', 'DELETE /api/admin/courses/:id', del.status === 200 && del.data && del.data.code === 0, `status=${del.status}`);
  }
  {
    const create = await call('POST', '/api/membership/card-type', { token: tokens.admin, body: {
      name: '测试卡种_' + ts(), billingMode: 'count', totalClasses: 10, price: 1000,
    }});
    const okCreate = create.status === 200 && create.data && create.data.code === 0 && inner(create) && inner(create).id;
    rec('D-cardtype-create', 'POST /api/membership/card-type', okCreate, okCreate ? '' : `status=${create.status} body=${JSON.stringify(create.data)}`);
    const newId = okCreate ? inner(create).id : 'ID1';
    const upd = await call('PUT', `/api/membership/card-type/${newId}`, { token: tokens.admin, body: { name: '改名卡种', price: 1200 } });
    rec('D-cardtype-update', 'PUT /api/membership/card-type/:id', upd.status === 200 && upd.data && upd.data.code === 0, `status=${upd.status}`);
    const del = await call('DELETE', `/api/membership/card-type/${newId}`, { token: tokens.admin });
    rec('D-cardtype-delete', 'DELETE /api/membership/card-type/:id', del.status === 200 && del.data && del.data.code === 0, `status=${del.status}`);
  }

  // ---------------- E. 关键业务流 ----------------
  console.log('\n\x1b[1m[E] 关键业务流\x1b[0m');
  // E1 排课 → 报名 → 冲突校验
  let schedIdE1 = 'ID1';
  {
    const day = futureDay(3);
    const sched = await call('POST', '/api/schedules', { token: tokens.admin, body: {
      courseName: '测试排课_' + ts(), date: day, startTime: '10:00', endTime: '11:00',
      teacherId: IDS.coach, maxStudents: 5,
    }});
    const okSched = sched.status === 200 && sched.data && sched.data.code === 0 && inner(sched) && inner(sched).id;
    rec('E-schedule-create', 'POST /api/schedules', okSched, okSched ? '' : `status=${sched.status} body=${JSON.stringify(sched.data)}`);
    schedIdE1 = okSched ? inner(sched).id : 'ID1';
    const enroll = await call('POST', `/api/schedules/${schedIdE1}/enroll`, { token: tokens.admin, body: { studentId: 'stu_001' } });
    rec('E-schedule-enroll', 'POST /api/schedules/:id/enroll', enroll.status === 200 && enroll.data && enroll.data.code === 0, `status=${enroll.status} body=${JSON.stringify(enroll.data)}`);
    const conflict = await call('POST', '/api/schedules/conflict-check', { token: tokens.admin, body: {
      teacherId: IDS.coach, date: day, startTime: '10:30', endTime: '11:30',
    }});
    rec('E-schedule-conflict-check', 'POST /api/schedules/conflict-check', conflict.status === 200 && conflict.data && conflict.data.code === 0, `status=${conflict.status}`);
    await call('DELETE', `/api/schedules/${schedIdE1}`, { token: tokens.admin });
  }
  // E2 签到 → 上课记录生成
  {
    const day = futureDay(1);
    const sched = await call('POST', '/api/schedules', { token: tokens.admin, body: {
      courseName: '签到测试_' + ts(), date: day, startTime: '09:00', endTime: '10:00',
      teacherId: IDS.coach, maxStudents: 5,
    }});
    const schedId = sched.data && inner(sched) ? inner(sched).id : 'ID1';
    await call('POST', `/api/schedules/${schedId}/enroll`, { token: tokens.admin, body: { studentId: 'stu_002' } });
    const ck = await call('POST', '/api/checkin/teacher', { token: tokens.coach, body: {
      scheduleId: schedId, attendances: [{ studentId: 'stu_002', status: 'present' }],
    }});
    const okCk = ck.status === 200 && ck.data && ck.data.code === 0;
    rec('E-checkin-teacher', 'POST /api/checkin/teacher', okCk, okCk ? '' : `status=${ck.status} body=${JSON.stringify(ck.data)}`);
    const att = await call('GET', '/api/attendances/student/stu_002', { token: tokens.admin, query: { pageSize: 500 } });
    const list = inner(att) && inner(att).list ? inner(att).list : [];
    const found = att.status === 200 && list.some((x) => x.scheduleId === schedId);
    rec('E-attendance-recorded', 'GET /api/attendances/student/stu_002 含签到', found, found ? '' : `status=${att.status} listLen=${list.length}`);
    const sum = await call('GET', '/api/attendances/summary', { token: tokens.admin, query: { pageSize: 500 } });
    const s = inner(sum) && inner(sum).summary;
    const okMath = sum.status === 200 && s && typeof s.totalSessions === 'number' && typeof s.attendanceRate === 'number';
    rec('E-summary-math', 'GET /api/attendances/summary 数值字段', okMath, okMath ? `totalSessions=${s.totalSessions} rate=${s.attendanceRate}` : `status=${sum.status}`);
    await call('DELETE', `/api/schedules/${schedId}`, { token: tokens.admin });
  }
  // E3 会员扣课：用确定性的计数卡断言「扣课链路真的落了扣课记录」
  // 旧实现取 `WHERE status='active' LIMIT 1` → 命中 seed 的时效卡（billing_mode='time'），
  // 于是走 recWarn 分支静默跳过扣课数学断言 —— 报告里「扣课链路已覆盖」的说法并不成立。
  // 现改为：显式锁定一张计数卡 → 扣课 → 断言 deduction_logs 的行数与卡余量。
  {
    const wdb = new Database(process.env.DB_PATH); // 可写连接（与 p2-fixes 同一做法）
    const cardId = 'mc_006';                       // seed 夹具中的计数卡（stu_006）
    const stuId = 'stu_006';
    const schId = 'sch_deduct_' + ts();
    // 显式重置为已知余量，避免断言与 seed 数值耦合
    wdb.prepare("UPDATE member_cards SET remaining_classes = 10, used_classes = 0, status = 'active' WHERE id = ?").run(cardId);
    const seeded = wdb.prepare('SELECT id, student_id, remaining_classes, billing_mode FROM member_cards WHERE id = ?').get(cardId);
    // 夹具退化必须变红：拿不到计数卡就无法验证扣课，不能再静默跳过
    rec('E-membership-deduct-setup', !!seeded && seeded.billing_mode === 'count' && seeded.remaining_classes === 10,
      `card=${JSON.stringify(seeded)}（需要一张 remaining=10 的 count 计费卡）`);

    const before = seeded.remaining_classes;
    const deduct = await call('POST', '/api/membership/deduct', { token: tokens.admin, body: {
      scheduleId: schId, studentId: stuId, classes: 1, reason: '批次9 扣课计数',
    }});
    const okDeduct = deduct.status === 200 && deduct.data && deduct.data.code === 0;
    rec('E-membership-deduct', 'POST /api/membership/deduct', okDeduct,
      okDeduct ? '' : `status=${deduct.status} body=${JSON.stringify(deduct.data)}`);

    // 判别性核心：扣课必须在 deduction_logs 留下**恰好一条**记录，且指向被扣的卡。
    // 旧断言只看 remaining 的加减（且在 time 卡上被跳过），发现不了「扣了课却不记账」。
    const rows = wdb.prepare('SELECT card_id FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').all(schId, stuId);
    rec('E-membership-deduct-log', 'deduction_logs 恰好 1 行（扣课链路留痕）', rows.length === 1,
      `rows=${rows.length}（期望 1）`);
    rec('E-membership-deduct-log-card', '扣课记录指向被扣的卡',
      rows.length === 1 && rows[0].card_id === cardId,
      `card_id=${rows[0] && rows[0].card_id} 期望=${cardId}`);
    const after = wdb.prepare('SELECT remaining_classes FROM member_cards WHERE id = ?').get(cardId).remaining_classes;
    rec('E-membership-deduct-math', `count 模式 remaining ${before} → ${before - 1}`, after === before - 1,
      `${before} -> ${after}`);
    // 响应体契约：扣课数与剩余量必须与库内一致（防止只改库不改响应，或反之）
    const d = deduct.data && deduct.data.data;
    rec('E-membership-deduct-response', '响应回显 deducted=1 与 remainingClasses=库内值',
      !!d && d.deducted === 1 && d.remainingClasses === after,
      `body=${JSON.stringify(d)} db.remaining=${after}`);

    // 幂等：同 (schedule, student) 再扣一次 → 业务失败码，且不产生第二条记录、不再扣减
    const deduct2 = await call('POST', '/api/membership/deduct', { token: tokens.admin, body: {
      scheduleId: schId, studentId: stuId, classes: 1, reason: '批次9 重复扣课',
    }});
    const rows2 = wdb.prepare('SELECT COUNT(*) c FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').get(schId, stuId).c;
    const after2 = wdb.prepare('SELECT remaining_classes FROM member_cards WHERE id = ?').get(cardId).remaining_classes;
    rec('E-membership-deduct-idempotent', '重复扣课被拒且不二次扣减',
      rows2 === 1 && after2 === after && deduct2.data && deduct2.data.code !== 0,
      `rows=${rows2} remaining=${after2} code=${deduct2.data && deduct2.data.code}`);

    // 收尾：清掉本轮扣课痕迹，避免影响其他用例
    wdb.prepare('DELETE FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').run(schId, stuId);
    wdb.prepare('UPDATE member_cards SET remaining_classes = 7, used_classes = 3 WHERE id = ?').run(cardId);
    wdb.close();
  }
  // E4 订单：创建 → 支付 → 退款预览 → 取消
  {
    const create = await call('POST', '/api/orders', { token: tokens.admin, body: {
      studentId: 'stu_003', items: [{ itemName: '测试商品', unitPrice: 100, quantity: 1 }],
      discountAmount: 0, orderType: 'retail', status: 'pending',
    }});
    const okCreate = create.status === 200 && create.data && create.data.code === 0 && inner(create) && inner(create).orderId;
    rec('E-order-create', 'POST /api/orders', okCreate, okCreate ? '' : `status=${create.status} body=${JSON.stringify(create.data)}`);
    const oid = okCreate ? inner(create).orderId : 'ID1';
    const pay = await call('POST', `/api/orders/${oid}/pay`, { token: tokens.admin, body: { payMethod: 'cash' } });
    rec('E-order-pay', 'POST /api/orders/:id/pay', pay.status === 200 && pay.data && pay.data.code === 0, `status=${pay.status} body=${JSON.stringify(pay.data)}`);
    const preview = await call('GET', `/api/orders/${oid}/refund-preview`, { token: tokens.admin });
    rec('E-order-refund-preview', 'GET /api/orders/:id/refund-preview', preview.status === 200 && preview.data && preview.data.code === 0, `status=${preview.status}`);
    const cancel = await call('POST', `/api/orders/${oid}/cancel`, { token: tokens.admin, body: {} });
    rec('E-order-cancel', 'POST /api/orders/:id/cancel', cancel.status === 200 && cancel.data && cancel.data.code === 0, `status=${cancel.status}`);
  }
  // E5 请假：家长申请 → 教练审批；另测家长撤销待审批
  if (parentToken) {
    // 流程一：家长申请 → 教练审批（独立排期 A）
    const dayA = futureDay(2);
    const schedA = await call('POST', '/api/schedules', { token: tokens.admin, body: {
      courseName: '请假测试A_' + ts(), date: dayA, startTime: '14:00', endTime: '15:00', teacherId: IDS.coach, maxStudents: 5,
    }});
    const schedIdA = schedA.data && inner(schedA) ? inner(schedA).id : 'ID1';
    await call('POST', `/api/schedules/${schedIdA}/enroll`, { token: tokens.admin, body: { studentId: parentStudentId } });
    const apply = await call('POST', '/api/leave/apply', { token: parentToken, body: {
      scheduleId: schedIdA, studentId: parentStudentId, reason: '测试请假',
    }});
    const okApply = apply.status === 200 && apply.data && apply.data.code === 0 && inner(apply) && inner(apply).id;
    rec('E-leave-apply', 'POST /api/leave/apply (家长)', okApply, okApply ? '' : `status=${apply.status} body=${JSON.stringify(apply.data)}`);
    const lid = okApply ? inner(apply).id : 'ID1';
    const approve = await call('PUT', `/api/leave/${lid}/approve`, { token: tokens.coach, body: { action: 'approve', note: '测试通过' } });
    rec('E-leave-approve', 'PUT /api/leave/:id/approve (教练)', approve.status === 200 && approve.data && approve.data.code === 0, `status=${approve.status} body=${JSON.stringify(approve.data)}`);
    await call('DELETE', `/api/schedules/${schedIdA}`, { token: tokens.admin });
    // 流程二：家长申请后立即撤销（独立排期 B，避免同排期重复请假被拒）
    const dayB = futureDay(4);
    const schedB = await call('POST', '/api/schedules', { token: tokens.admin, body: {
      courseName: '请假测试B_' + ts(), date: dayB, startTime: '14:00', endTime: '15:00', teacherId: IDS.coach, maxStudents: 5,
    }});
    const schedIdB = schedB.data && inner(schedB) ? inner(schedB).id : 'ID1';
    await call('POST', `/api/schedules/${schedIdB}/enroll`, { token: tokens.admin, body: { studentId: parentStudentId } });
    const apply2 = await call('POST', '/api/leave/apply', { token: parentToken, body: {
      scheduleId: schedIdB, studentId: parentStudentId, reason: '测试撤销',
    }});
    const lid2 = apply2.data && inner(apply2) ? inner(apply2).id : 'ID1';
    const cancel = await call('POST', `/api/leave/${lid2}/cancel`, { token: parentToken, body: {} });
    rec('E-leave-cancel', 'POST /api/leave/:id/cancel (家长撤销)', cancel.status === 200 && cancel.data && cancel.data.code === 0, `status=${cancel.status} body=${JSON.stringify(cancel.data)}`);
    await call('DELETE', `/api/schedules/${schedIdB}`, { token: tokens.admin });
  } else {
    // 同上：无家长身份时不能再静默跳过，否则请假链路（E5）会整块消失而套件仍绿
    rec('E-leave', '家长身份可用（夹具完整性）', false, '无家长 token —— 请假流程用例无法执行，视为失败');
  }

  // ---------------- F. 边界用例 ----------------
  console.log('\n\x1b[1m[F] 边界用例\x1b[0m');
  {
    const r = await call('POST', '/api/students', { token: tokens.admin, body: { gender: '男' } });
    rec('F-students-missing-name', 'POST /api/students 无姓名 → 业务失败码', r.status === 200 && r.data && r.data.code !== 0, `status=${r.status} code=${r.data && r.data.code}`);
  }
  {
    const r = await call('GET', '/api/students/NO_SUCH_ID', { token: tokens.admin });
    rec('F-students-404', 'GET /api/students/不存在', r.status === 404 || (r.data && r.data.code !== 0), `status=${r.status} code=${r.data && r.data.code}`);
  }
  {
    const r = await call('GET', '/api/attendances/student/NO_SUCH_STU', { token: tokens.admin });
    rec('F-attendance-404', 'GET /api/attendances/student/不存在', r.status === 404, `status=${r.status}`);
  }
  {
    const res = await fetch(BASE + '/api/students', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens.admin }, body: '{bad json' });
    // 断言精确到 400：body-parser 解析失败是**客户端**错误。
    // 旧断言为 `400 || 500 || 200`，对任何结果恒真 —— 实测当时后端回的就是 500，
    // 即「非法 JSON 被当作服务端故障」，用例却报 PASS（假绿）。
    rec('F-invalid-json', '非法 JSON body → 400（非 500）', res.status === 400, `status=${res.status}`);
    const alive = await call('GET', '/api/health');
    rec('F-invalid-json', '非法 JSON 后进程仍存活', alive.status === 200, `status=${alive.status}`);
  }
  if (parentToken && bound) {
    const qdb = new Database(process.env.DB_PATH, { readonly: true });
    // 必须选「该家长未绑定」的学员：同班/同孩双家长场景下 <>parent 不够（父母都绑同一学员）
    const other = qdb.prepare(
      'SELECT student_id FROM parent_bindings WHERE parent_openid <> ? AND student_id NOT IN (SELECT student_id FROM parent_bindings WHERE parent_openid = ?) LIMIT 1'
    ).get(bound.parent_openid, bound.parent_openid);
    qdb.close();
    if (other) {
      const r = await call('GET', `/api/attendances/student/${other.student_id}`, { token: parentToken });
      rec('F-parent-cross-view', '家长查看他人学员 → 403', r.status === 403, `status=${r.status}`);
    } else {
      // 夹具有多名学员且家长各不相同，取不到「他人学员」说明夹具退化，不得静默跳过
      rec('F-parent-cross-view', '存在可测的他人学员（夹具完整性）', false,
        '未找到其他绑定学员 —— 家长越权用例无法执行，视为失败');
    }
  }

  // ---------------- G. 自助改密与会话连续性（P1-15） ----------------
  // 后端 /auth/changePassword 一直支持 admin/coach/sales，但承载表单的系统设置页仅
  // 管理员可进，教练/销售拿不到任何改密入口；且改密返回的新 Token 前端未落盘，
  // 下一次请求即 401 被登出。此处锁定后端契约：改密成功返回的 Token 必须可直接使用，
  // 旧 Token 必须立即失效 —— 这正是前端必须替换本地 Token 的依据。
  // 注意：本段会 bump 该身份的 token_version，使其既有 Token 全部失效，故必须放在最后。
  console.log('\x1b[1m[G] 自助改密（P1-15）\x1b[0m');
  {
    const OLD_PWD = '123456';        // seed 夹具的初始密码
    const NEW_PWD = 'starclass-15';
    const changePwd = (token, oldPassword, newPassword) =>
      call('POST', '/api/auth/changePassword', { token, body: { oldPassword, newPassword } });

    const wrong = await changePwd(tokens.sales, 'not-the-password', NEW_PWD);
    rec('G-change-pwd-wrong-old', '原密码错误 → 403', wrong.status === 403, `status=${wrong.status}`);

    const tooShort = await changePwd(tokens.sales, OLD_PWD, '123');
    rec('G-change-pwd-too-short', '新密码过短 → 400', tooShort.status === 400, `status=${tooShort.status}`);

    const ok = await changePwd(tokens.sales, OLD_PWD, NEW_PWD);
    const fresh = ok.data?.data?.token;
    // 销售此前被后端漏掉（只判 admin/coach），此处同时守住「销售也能改密」这一契约
    rec('G-change-pwd-ok', '销售可自助改密（非管理员角色未被拦）', ok.status === 200 && !!fresh, `status=${ok.status} token=${!!fresh}`);

    // 判别性核心：返回的新 Token 必须真的可用，否则前端即使落盘也无效
    const withNew = await call('GET', '/api/auth/getProfile', { token: fresh });
    rec('G-new-token-usable', '改密返回的新 Token 可直接访问受保护接口', withNew.status === 200, `status=${withNew.status}`);

    const withOld = await call('GET', '/api/auth/getProfile', { token: tokens.sales });
    rec('G-old-token-revoked', '改密后旧 Token 立即失效 → 401', withOld.status === 401, `status=${withOld.status}`);
  }

  // ---------------- 零 WARN 总闸 ----------------
  // 全部 recWarn 跳过点均已改为硬断言（夹具退化 → FAIL）。此处再加一道总闸：
  // 只要本次运行还有任何 WARN，套件即判失败 —— 防止将来重新引入「静默跳过」，
  // 让「报告里声称已覆盖、实际被跳过」的情况无法再伪装成绿灯。
  rec('W-zero-warn', '本次运行零 WARN（无静默跳过）', warned === 0, `warned=${warned}`);

  // ---------------- 汇总 ----------------
  console.log('\n\x1b[1m=== 测试结果汇总 ===\x1b[0m');
  console.log(`\x1b[32mPASS ${passed}\x1b[0m  \x1b[31mFAIL ${failed}\x1b[0m  \x1b[33mWARN ${warned}\x1b[0m  (共 ${results.length})`);
  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, `report-${ts()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ passed, failed, warned, total: results.length, results, at: new Date().toISOString() }, null, 2));
  console.log('明细已写入:', reportPath);

  const fails = results.filter((r) => r.status === 'FAIL');
  if (fails.length) {
    console.log('\n\x1b[31m失败项明细:\x1b[0m');
    for (const f of fails) console.log(`  - ${f.group} › ${f.name}: ${f.detail}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试运行异常:', e); process.exit(3); });
