/**
 * 回归套件 —— 家长身份接管（parent_bindings 越权）的两道闸门
 *
 * 被验证的缺陷（高危越权：任意已登录家长可接管别人孩子的家长身份）：
 *   攻击链两步，全程不需要验证码：
 *   1) POST /api/auth/updateProfile 允许任意改手机号，而占用检查**只查 users 表**。
 *      系统里大量家长根本没有 users 账号 —— 他们的手机号只存在于
 *      parent_bindings.parent_phone。于是攻击者可把自己的手机号改成这类家长的号码。
 *   2) 登录时（routes/auth.js）按手机号**批量**改写绑定：
 *      UPDATE parent_bindings SET parent_openid = ? WHERE parent_phone = ? AND parent_openid != ?
 *      用「受害家长手机号 + 攻击者自己的密码」登录成功后，users 里命中的仍是他自己那行、
 *      密码也是自己的 → 认证通过，随后受害学员的绑定行被改写成攻击者的 openid。
 *   攻击者由此拿到该学员的课表 / 订单 / 积分 / 请假全部数据（并绕过 bindStudent 的手机后四位校验）。
 *
 * 修复（两处，均在 backend/routes/auth.js）：
 *   · 改动1（核心阻断，updateProfile 内 db.transaction() 之前）：
 *       SELECT 1 FROM parent_bindings WHERE parent_phone = ? AND parent_openid IS NOT ? LIMIT 1
 *     命中则 400「该手机号已被其他学员的家长使用」。用 IS NOT 而非 != 是 NULL 安全的，
 *     顺带把 parent_openid 为 NULL 的「无主」绑定也算作冲突。
 *   · 改动2（纵深防御，login 内的绑定迁移）：
 *       迁移条件追加 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.openid = parent_bindings.parent_openid)，
 *       即不抢占「已名花有主」的绑定。用 NOT EXISTS 而非 NOT IN（users.openid 可为 NULL，
 *       NOT IN 遇 NULL 三值逻辑会静默失效）。
 *
 * ⚠ 已知残留风险（据实断言，见 T2）：改动2 **拦不住典型攻击形态**。
 *   典型形态下受害绑定的 parent_openid 本就没有对应的 users 行（正是攻击者能利用它的原因），
 *   于是 NOT EXISTS 为真、迁移照常发生 → 仍会接管。所以**核心防线是改动1**，
 *   本套件的判别力主要锁在 T1 / T1b 上。T2 据实断言「当前会接管」并显式标注为残留风险，
 *   不为让测试变绿而写错断言；T2b 则钉死改动2 在它真正能生效的那种形态（绑定已有 users 行）下确实生效。
 *
 * 判别力边界（避免把「护栏」伪装成「判别项」）：
 *   · T0 是**前置**：证明夹具自洽（受害绑定确实无 users 行）且两个处理器确实直达业务逻辑。
 *   · T1 / T1b 是**判别项**：移除改动1 后必须失败（T1 被 200 放行、T1b 无主绑定被抢占）。
 *   · T3 / T4 / T5 是**护栏（不误伤）**：改动1 前后同结果，钉死「修完之后不许把正常改号判成冲突」。
 *   · T2b 是**判别项**（针对改动2）：移除改动2 后该绑定会被改写。
 *   · T2 是**残留风险记录**：断言的是「当前仍会接管」，移除改动2 后结果不变，故它不是改动2 的判别项。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db）：
 *   node tests/parent-binding-takeover-regression.cjs
 *   KEEP_TEST_DB=1 node tests/parent-binding-takeover-regression.cjs   （保留临时库排查）
 *
 * 写法说明：建库/清理沿用 _bootstrap.cjs；直调路由处理器沿用
 * points-clamp-consistency-regression.cjs 的 getHandler/mockRes/mockReq
 * （不启 HTTP 服务，避免与线上占用的 3001 端口及并发套件冲突）。
 */
'use strict';

// ---- 隔离库（必须在 require('../db') 之前设置）----
const { bootstrap } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-parent-binding-takeover');

const db = require('../db');
const { now, hashPassword } = require('../utils');
const authRouter = require('../routes/auth');

// 防呆：临时库必须落在 /tmp，绝不能是真实库 backend/db/data.db
if (!String(process.env.DB_PATH || '').startsWith('/tmp/')) {
  console.error('[致命] DB_PATH 不在 /tmp，拒绝运行以免污染真实库:', process.env.DB_PATH);
  process.exit(2);
}

// ---------- 直调路由处理器（与 points-clamp-consistency-regression.cjs 同款）----------
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

// ---------- 断言记录 ----------
let passed = 0, failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${ok ? '' : '  -> ' + detail}`);
}

// ---------- 夹具 ----------
const t = now();
const ins = (sql, ...p) => db.prepare(sql).run(...p);

function mkStudent(id, name) {
  ins("INSERT OR IGNORE INTO students (id, name, status, archived, created_at, updated_at) VALUES (?, ?, 'active', 0, ?, ?)",
    id, name, t, t);
}
/**
 * 家长绑定行：parent_phone 是受害家长的号码，parent_openid 可能是 NULL（无主）或某个 openid。
 * 注意 parent_bindings.id 是 INTEGER PRIMARY KEY AUTOINCREMENT，必须由 SQLite 自增，
 * 传字符串会触发 SQLITE_MISMATCH。
 */
function mkBinding(studentId, studentName, parentPhone, parentOpenid) {
  ins(`INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at)
       VALUES (?, ?, ?, ?, ?, '母亲', 1, ?)`,
    studentId, studentName, studentName + '家长', parentOpenid, parentPhone, t);
}
/** 攻击者 / 家长账号（users 行）。phone 可为 null。 */
function mkUser(id, openid, phone, nickname, password) {
  ins(`INSERT INTO users (id, openid, phone, nickname, avatar, role, password, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'parent', ?, 'active', ?, ?)`,
    id, openid, phone, nickname, password ? hashPassword(password) : null, t, t);
}

// ---------- 观测封装 ----------
const bindingRows = (studentId) =>
  db.prepare('SELECT id, student_id, parent_openid, parent_phone FROM parent_bindings WHERE student_id = ? ORDER BY id').all(studentId);
const userRow = (id) => db.prepare('SELECT id, openid, phone FROM users WHERE id = ?').get(id);
const hasUsersForOpenid = (openid) =>
  !!db.prepare('SELECT 1 FROM users WHERE openid = ?').get(openid);

function updateProfile(openid, body) {
  const res = mockRes();
  getHandler(authRouter, 'post', '/updateProfile')(mockReq({ openid, body }), res);
  return res;
}
function login(body) {
  const res = mockRes();
  getHandler(authRouter, 'post', '/login')(mockReq({ body }), res);
  return res;
}

console.log('\n\x1b[1m=== 家长身份接管回归（parent_bindings 越权 / 两道闸门）===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '（seed 夹具 + 本套件夹具）\n');

// ============================================================
// T0. 前置条件：夹具自洽 + 处理器可达（否则后面全是假绿）
// ============================================================
console.log('\x1b[1m[T0] 前置条件：处理器可达 + 夹具自洽\x1b[0m');
{
  const r = updateProfile('openid_never_exists_xyz', { phone: '13500009999' });
  rec('T0 POST /updateProfile 未被 401 拦下（不存在的用户返回 404 业务失败）',
    r.statusCode === 404, `status=${r.statusCode} body=${JSON.stringify(r.body)}`);

  const l = login({ phone: '13500009998', password: 'no-such-password', role: 'parent' });
  rec('T0 POST /login 未被拦下（不存在的凭证返回 403 业务失败）',
    l.statusCode === 403, `status=${l.statusCode} body=${JSON.stringify(l.body)}`);

  // 夹具自洽：本套件依赖「受害家长的 openid 在 users 表里查不到」这一前提
  rec('T0 夹具自洽：seed 库中 users 表未持有 wx_victim_* 前缀账号（典型形态成立）',
    !db.prepare("SELECT 1 FROM users WHERE openid LIKE 'wx_victim_%'").get(),
    'seed 库意外存在 wx_victim_ 账号');
}

// ============================================================
// T1. 核心攻击链 —— 改动1 必须把它拦在 400
// ============================================================
console.log('\n\x1b[1m[T1] 核心攻击链：改号占用检查必须覆盖 parent_bindings（改动1）\x1b[0m');
{
  const P_VICTIM = '13500000001';   // 受害家长手机号：只存在于 parent_bindings
  mkStudent('stu_takeover_x', '受害学员X');
  mkBinding('stu_takeover_x', '受害学员X', P_VICTIM, 'wx_victim_parent_x');
  mkUser('user_atk1', 'phone_13500000002', '13500000002', '攻击者A', 'atk-pass-123');

  rec('T1 前置：受害绑定 parent_openid 在 users 表中无对应行（users 表占用检查查不到）',
    !hasUsersForOpenid('wx_victim_parent_x'), 'users 表意外存在 wx_victim_parent_x');
  rec('T1 前置：受害手机号在 users 表中确实不存在（确保命中的是 parent_bindings 冲突）',
    !db.prepare('SELECT 1 FROM users WHERE phone = ?').get(P_VICTIM), 'users 表意外存在该手机号');

  const res = updateProfile('phone_13500000002', { phone: P_VICTIM });
  rec('T1 [判别] 改号被 400 拒绝（移除改动1 后此处返回 200 放行）',
    res.statusCode === 400, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);
  rec('T1 [判别] 拒绝文案指向「其他学员的家长」（证明命中 parent_bindings 冲突而非 users 冲突）',
    !!(res.body && String(res.body.message || '').includes('其他学员的家长')),
    JSON.stringify(res.body));

  const rows = bindingRows('stu_takeover_x');
  rec('T1 [判别] 受害学员的 parent_openid 未被改写（仍是 wx_victim_parent_x）',
    rows.length === 1 && rows[0].parent_openid === 'wx_victim_parent_x', JSON.stringify(rows));
  rec('T1 [判别] 受害绑定的 parent_phone 未被改写', rows.length === 1 && rows[0].parent_phone === P_VICTIM,
    JSON.stringify(rows));

  const a = userRow('user_atk1');
  rec('T1 [判别] 攻击者自己的手机号 / openid 未被改动（拒绝不产生副作用）',
    !!a && a.phone === '13500000002' && a.openid === 'phone_13500000002', JSON.stringify(a));
}

// ============================================================
// T1b. NULL 安全：parent_openid 为 NULL 的「无主」绑定同样算冲突
//      （改动1 用 IS NOT 而非 != 的意义所在）
// ============================================================
console.log('\n\x1b[1m[T1b] NULL 安全：无主绑定（parent_openid IS NULL）不得被抢占\x1b[0m');
{
  const P_ORPHAN = '13500000013';
  mkStudent('stu_takeover_o', '无主绑定学员');
  mkBinding('stu_takeover_o', '无主绑定学员', P_ORPHAN, null);
  mkUser('user_atk1b', 'phone_13500000014', '13500000014', '攻击者A2', 'atk-pass-123');

  const res = updateProfile('phone_13500000014', { phone: P_ORPHAN });
  rec('T1b [判别] 抢占无主绑定被 400 拒绝（若用 != 则 NULL 比较为 NULL、条件失效而放行）',
    res.statusCode === 400, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);
  const rows = bindingRows('stu_takeover_o');
  rec('T1b [判别] 无主绑定的 parent_openid 仍为 NULL', rows.length === 1 && rows[0].parent_openid === null,
    JSON.stringify(rows));
}

// ============================================================
// T2. 端到端接管 —— 模拟「改动1 被绕过」后走登录流程
//     ⚠ 已知残留风险：改动2 拦不住典型形态（受害绑定无对应 users 行）
// ============================================================
console.log('\n\x1b[1m[T2] 端到端接管（改动1 被绕过 → 登录迁移）：据实断言当前行为\x1b[0m');
{
  const P_VICTIM = '13500000003';
  mkStudent('stu_takeover_y', '受害学员Y');
  mkBinding('stu_takeover_y', '受害学员Y', P_VICTIM, 'wx_victim_parent_y');
  mkUser('user_atk2', 'phone_13500000004', '13500000004', '攻击者B', 'atk-pass-456');

  rec('T2 前置：受害绑定 parent_openid 无对应 users 行（NOT EXISTS 为真 → 迁移不会被改动2 拦下）',
    !hasUsersForOpenid('wx_victim_parent_y'), 'users 表意外存在 wx_victim_parent_y');
  rec('T2 前置：受害手机号在 users 表中确实不存在（否则改库会撞 users.phone 唯一约束）',
    !db.prepare('SELECT 1 FROM users WHERE phone = ?').get(P_VICTIM), 'users 表意外存在该手机号');

  // 模拟改动1 被绕过：直接改库，把攻击者的手机号设成受害家长的号码
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(P_VICTIM, 'user_atk2');

  const res = login({ phone: P_VICTIM, password: 'atk-pass-456', role: 'parent' });
  rec('T2 前置：用「受害家长手机号 + 攻击者自己的密码」登录成功（认证确实通过）',
    res.statusCode === 200 && res.body && res.body.code === 0,
    `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  const rows = bindingRows('stu_takeover_y');
  const hijacked = rows.length === 1 && rows[0].parent_openid !== 'wx_victim_parent_y';
  // 据实断言：当前实现下这里**会**被接管。这不是「期望的安全行为」，而是已确认的残留风险。
  rec('T2 [残留风险] 登录后受害绑定的 parent_openid 被改写成攻击者（改动2 拦不住典型形态，核心防线只有改动1）',
    hijacked, JSON.stringify(rows));
  rec('T2 [残留风险] 改写后的 parent_openid 恰为攻击者登录后的 openid',
    rows.length === 1 && rows[0].parent_openid === 'phone_' + P_VICTIM, JSON.stringify(rows));
}

// ============================================================
// T2b. 改动2 真正生效的形态：绑定已有 users 行 → 迁移必须被 NOT EXISTS 拦下
// ============================================================
console.log('\n\x1b[1m[T2b] 纵深防御生效形态：绑定已名花有主（parent_openid 有 users 行）\x1b[0m');
{
  const P_VICTIM = '13500000005';
  const OWNER_OPENID = 'phone_13500000006';
  mkStudent('stu_takeover_z', '名花有主学员');
  mkBinding('stu_takeover_z', '名花有主学员', P_VICTIM, OWNER_OPENID);
  mkUser('user_owner_z', OWNER_OPENID, '13500000006', '真实家长Z', 'owner-pass-789');
  mkUser('user_atk3', 'phone_13500000007', '13500000007', '攻击者C', 'atk-pass-789');

  rec('T2b 前置：受害绑定 parent_openid 确有对应 users 行（NOT EXISTS 为假 → 应被拦下）',
    hasUsersForOpenid(OWNER_OPENID), 'users 表缺少 ' + OWNER_OPENID);

  // 模拟改动1 被绕过：把攻击者手机号设成受害家长的号码
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(P_VICTIM, 'user_atk3');
  const res = login({ phone: P_VICTIM, password: 'atk-pass-789', role: 'parent' });
  rec('T2b 前置：攻击者登录成功', res.statusCode === 200 && res.body && res.body.code === 0,
    `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  const rows = bindingRows('stu_takeover_z');
  rec('T2b [判别] 绑定未被改写（移除改动2 后此处会被改成攻击者的 openid）',
    rows.length === 1 && rows[0].parent_openid === OWNER_OPENID, JSON.stringify(rows));
}

// ============================================================
// T3. 不误伤：兄弟姐妹共用同一家长号码（同 parent_openid）→ 改号必须成功
//     这是「不误伤」的护栏：IS NOT 排除了属于自己的绑定行，不会把自家号码判成冲突。
// ============================================================
console.log('\n\x1b[1m[T3] 不误伤·兄弟姐妹同号：同一家长的两个孩子共用号码 → 改号成功\x1b[0m');
{
  const P_FAMILY = '13500000021';
  const PARENT_OPENID = 'phone_13500000020';
  mkStudent('stu_sib_a', '兄弟姐妹甲');
  mkStudent('stu_sib_b', '兄弟姐妹乙');
  // 两条绑定行 parent_openid 完全相同（都是这位家长），只是 phone 未同步到 users.phone
  mkBinding('stu_sib_a', '兄弟姐妹甲', P_FAMILY, PARENT_OPENID);
  mkBinding('stu_sib_b', '兄弟姐妹乙', P_FAMILY, PARENT_OPENID);
  mkUser('user_sib', PARENT_OPENID, null, '二胎家长', 'sib-pass-123');

  const res = updateProfile(PARENT_OPENID, { phone: P_FAMILY });
  rec('T3 [护栏] 自家号码（兄弟姐妹共用）不被判为冲突，改号成功（200 且 code=0）',
    res.statusCode === 200 && res.body && res.body.code === 0,
    `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  const a = bindingRows('stu_sib_a');
  const b = bindingRows('stu_sib_b');
  rec('T3 [护栏] 两个孩子的绑定都仍在，且 parent_phone 指向该家长号码',
    a.length === 1 && b.length === 1 && a[0].parent_phone === P_FAMILY && b[0].parent_phone === P_FAMILY,
    JSON.stringify({ a, b }));
  rec('T3 [护栏] 两条绑定的 parent_openid 仍相同（仍归属同一位家长，未被拆散）',
    a.length === 1 && b.length === 1 && a[0].parent_openid === b[0].parent_openid,
    JSON.stringify({ a, b }));
  const u = userRow('user_sib');
  rec('T3 [护栏] 家长账号手机号已更新为新号', !!u && u.phone === P_FAMILY, JSON.stringify(u));
}

// ============================================================
// T4. 不误伤：改成「自己绑定行已在用的号」→ 成功
//     直接检验改动1 的排除子句 `parent_openid IS NOT ?` 不会把自家绑定误判为他人占用。
// ============================================================
console.log('\n\x1b[1m[T4] 不误伤·改成自己绑定已在用的号：不得判为冲突\x1b[0m');
{
  const OLD_PHONE = '13500000009';
  const BOUND_PHONE = '13500000010';
  const PARENT_OPENID = 'phone_' + OLD_PHONE;
  mkStudent('stu_self', '自家号码学员');
  mkBinding('stu_self', '自家号码学员', BOUND_PHONE, PARENT_OPENID);
  mkUser('user_self', PARENT_OPENID, OLD_PHONE, '自家号码家长', 'self-pass-123');

  const res = updateProfile(PARENT_OPENID, { phone: BOUND_PHONE });
  rec('T4 [护栏] 改成自己绑定行已在用的号：成功（200 且 code=0）',
    res.statusCode === 200 && res.body && res.body.code === 0,
    `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  const u = userRow('user_self');
  rec('T4 [护栏] users.phone / openid 已随改号迁移',
    !!u && u.phone === BOUND_PHONE && u.openid === 'phone_' + BOUND_PHONE, JSON.stringify(u));
  const rows = bindingRows('stu_self');
  rec('T4 [护栏] 绑定仍归属该家长（parent_openid 已迁移为新 openid）',
    rows.length === 1 && rows[0].parent_openid === 'phone_' + BOUND_PHONE && rows[0].parent_phone === BOUND_PHONE,
    JSON.stringify(rows));
}

// ============================================================
// T5. 不误伤：改成全新未占用的号 → 成功且绑定同步迁移
// ============================================================
console.log('\n\x1b[1m[T5] 不误伤·改成全新未占用的号：成功且绑定同步迁移\x1b[0m');
{
  const OLD_PHONE = '13500000011';
  const NEW_PHONE = '13500000012';
  const PARENT_OPENID = 'phone_' + OLD_PHONE;
  mkStudent('stu_fresh', '全新号码学员');
  mkBinding('stu_fresh', '全新号码学员', OLD_PHONE, PARENT_OPENID);
  mkUser('user_fresh', PARENT_OPENID, OLD_PHONE, '全新号码家长', 'fresh-pass-123');

  rec('T5 前置：新号在 users / parent_bindings 中均未被占用',
    !db.prepare('SELECT 1 FROM users WHERE phone = ?').get(NEW_PHONE)
    && !db.prepare('SELECT 1 FROM parent_bindings WHERE parent_phone = ?').get(NEW_PHONE),
    '新号意外已被占用');

  const res = updateProfile(PARENT_OPENID, { phone: NEW_PHONE });
  rec('T5 [护栏] 改成全新号码成功（200 且 code=0）',
    res.statusCode === 200 && res.body && res.body.code === 0,
    `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  const u = userRow('user_fresh');
  rec('T5 [护栏] users.phone / openid 已迁移到新号',
    !!u && u.phone === NEW_PHONE && u.openid === 'phone_' + NEW_PHONE, JSON.stringify(u));
  const rows = bindingRows('stu_fresh');
  rec('T5 [护栏] 自己的绑定行 parent_phone / parent_openid 同步迁移到新号（未丢失）',
    rows.length === 1 && rows[0].parent_phone === NEW_PHONE && rows[0].parent_openid === 'phone_' + NEW_PHONE,
    JSON.stringify(rows));
}

// ============================================================
// 收尾：临时库由 _bootstrap.cjs 在进程退出时整目录删除
// ============================================================
console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
