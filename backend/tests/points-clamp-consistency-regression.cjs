/**
 * 回归套件 —— 积分「回收 / 作废」四路径的余额与流水一致性（clamp 口径）
 *
 * 被验证的缺陷（四处同一毛病：`MAX(0, …)` 截断余额，扣减量却按全额算）：
 *   积分可兑换、属有价资产，故 **账户余额的变动必须等于积分流水的净变动**。
 *   但四条回收路径都写成「余额按 MAX(0, balance − x) 截断、流水却按全额 x 计」：
 *   余额只有 30 而要回收 100 时，余额被截断到 0（实扣 30），流水侧却记了 100，
 *   从此两者永久相差 70，**且没有任何自愈机制**（前端只读 points.balance，
 *   对账只读流水，两个数字再也不会相等）。
 *   四处：orders.js 全额退款回收 / orders.js 取消订单回收 / membership.js 退卡回收 /
 *   admin.js 删除活动按净额回滚。
 *
 * 与历史结论的出入（据实记录）：commit 9c48bcb 的提交信息曾写「退款/取消/退卡/删课这 4 处
 * 回收积分并不把金额写进流水（翻转或删除流水行），不满足该错配，故不改」。该结论只对
 * 「实扣 3 却记 −10」这一具体形态成立；本套件实测证明：这四处**同样**破坏
 * 「余额变动 == 流水净变动」这一不变量（前三条根本不给回收记金额，Δ 流水恒为 0；
 * 第四条按全额删除，Δ 流水恒为 −a.total），只是形态不同（0 或 −全额，而非 −请求量）。
 * 故仍应修复。
 *
 * 四条路径的「流水侧」写法各不相同，故修法也不同（这是本套件最需要注意的一点）：
 *   · 前三条（退款/取消/退卡）：把 `type='earn'` 的行**翻转**成 `'refund'`
 *     （amount 不变）。翻转本身不改变 SUM(amount)，因此旧实现的流水净变动是 **0**，
 *     而余额减了 min(x, balance) —— 不是「流水记 −100」，而是「流水什么都没记」。
 *     修法：保留翻转（它同时是重复调用时的幂等保护），另补一条 `amount = −actual`
 *     的 'refund' 流水，使净变动恰为 −actual。
 *   · 第四条（删活动）：`DELETE FROM point_logs` 把整批行**删掉**，净变动 −a.total，
 *     而余额只减 min(a.total, balance)。修法：仍按契约整批清理（finance-payroll 套件
 *     断言 `reference_id` 行数归零），对追不回的部分（a.total − actual）补记一笔，
 *     使净变动恰为 −actual。
 *
 * 业务语义不变：余额不足时仍是「扣到 0 为止、不报失败」。
 *
 * 判别力实测（不是推测 —— 已把 backend/ 整树 rsync 到 /tmp/edu-head-clamp（排除
 * node_modules 并软链回工作区依赖），用 `git show HEAD:backend/routes/orders.js`、
 * `…/membership.js`、`…/admin.js` **只覆盖这三个文件**，其余（含 db/、utils/、tests/）
 * 保持工作区版本，在副本上跑本套件；工作区业务代码改动后另跑一次）：
 *   修复前：PASS 26 / FAIL 17      修复后：PASS 43 / FAIL 0
 *   17 条 FAIL 全部落在标 [判别] 的条目上，一处不多一处不少：
 *     · T1/T2/T3 各 4 条（total_earned 归 0、Δ 流水 = 0、净额 30 ≠ 余额 0、
 *       没有 −30 的回收流水）—— 三条路径共 12 条
 *     · T4 3 条（total_earned 归 0、Δ 流水 = −100、净额 −70 ≠ 余额 0）
 *     · T5a 2 条（Δ 流水 = 0、净额 100 ≠ 余额 0）
 *   其余 26 条（T0 前置 5 + T1~T3 前置/护栏 3×3 + T4 前置 1 + T4 护栏 1 +
 *   T5a 护栏 2 + T5b 4）在修复前后结果相同，均已在下方标注为「前置」或「护栏」。
 *
 * 判别力边界（据实标注，避免把「护栏」伪装成「判别项」）：
 *   · T0 五条是**前置条件**：证明四个接口确实直达业务逻辑（不存在的 id 返回业务失败
 *     而非 403），且 signedSum 口径本身正确（seed 账户本就满足「流水净额 == 余额」）。
 *     否则下面所有「修复后相等」都可能是「压根没进业务逻辑」的假绿。
 *   · T1~T3 的「夹具余额 30 / 净额 == 余额」与「调用成功」是**前置**：
 *     若夹具造错或调用被拒，后面的判别项测的不是修复本身。
 *   · 「余额归零且不为负」在四条路径上修复前后**同结果**（旧实现余额也归 0），
 *     故是**护栏**，不是判别项 —— 它钉死的是「修完之后不许把余额扣成负数」。
 *   · T4 的「积分流水仍被整批清理」是**护栏**（旧实现本就删除），
 *     作用是钉死「为了对齐流水净额而破坏既有的清理契约」（finance-payroll 套件
 *     亦断言 reference_id 行数归零）。
 *   · T5b（余额充足 + 删活动）整段是**护栏**：该路径的流水侧是 DELETE，
 *     足额回收时净变动本就是 −100 = −actual，修复前后同结果。
 *   · T5a（余额充足 + 订单退款）**不是纯护栏**：其中「Δ = −100」「净额 == 余额」
 *     两条在旧实现下同样失败（旧实现只翻转、不记金额），故标为 [判别]。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db）：
 *   node tests/points-clamp-consistency-regression.cjs
 *   KEEP_TEST_DB=1 node tests/points-clamp-consistency-regression.cjs   （保留临时库排查）
 *
 * 写法说明：建库/清理沿用 _bootstrap.cjs；直调路由处理器沿用
 * deleted-student-exclusion-regression.cjs 的 getHandler/mockRes/mockReq
 * （不启 HTTP 服务，避免与线上占用的 3001 端口及并发套件冲突）。
 */
'use strict';

// ---- 隔离库（必须在 require('../db') 之前设置）----
const { bootstrap } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-points-clamp');

const db = require('../db');
const { now, formatDate } = require('../utils');
const ordersRouter = require('../routes/orders');
const membershipRouter = require('../routes/membership');
const adminRouter = require('../routes/admin');

// 防呆：临时库必须落在 /tmp，绝不能是真实库 backend/db/data.db
if (!String(process.env.DB_PATH || '').startsWith('/tmp/')) {
  console.error('[致命] DB_PATH 不在 /tmp，拒绝运行以免污染真实库:', process.env.DB_PATH);
  process.exit(2);
}

// ---------- 直调路由处理器（与 deleted-student-exclusion-regression.cjs 同款）----------
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
const today = formatDate(t);
const DAY = 86400000;
const ins = (sql, ...p) => db.prepare(sql).run(...p);
const asAdmin = (extra) => mockReq(Object.assign({ userRole: 'admin', openid: 'admin_clamp' }, extra));

function mkStudent(id, name) {
  ins("INSERT OR IGNORE INTO students (id, name, status, archived, created_at, updated_at) VALUES (?, ?, 'active', 0, ?, ?)",
    id, name, t, t);
}
/** 会员卡「产品」（membership_cards）。refundable 显式给 1，否则退卡接口按卡类型设置拒绝。 */
function mkCardType(id, name, o) {
  const { total = 24, days = 200, mode = 'count', price = 2400 } = o || {};
  ins(`INSERT OR IGNORE INTO membership_cards (id, name, total_classes, valid_days, billing_mode,
         price, course_scope, transferable, refundable, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '全活动通用', 0, 1, 1, ?)`,
    id, name, total, days, mode, price, t);
}
function mkPaidOrder(id, orderNo, studentId, typeId, typeName, amount) {
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, student_name, order_type, items,
         payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'membership', ?, ?, 0, 0, ?, 'paid', ?, ?, ?)`,
    id, orderNo, studentId, studentId + '名',
    JSON.stringify([{ itemType: 'membershipCard', itemId: typeId, itemName: typeName, quantity: 1, unitPrice: amount, totalPrice: amount }]),
    amount, amount, t, t, t);
}
function mkCard(id, typeId, typeName, studentId, orderId) {
  ins(`INSERT OR IGNORE INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id,
         student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at,
         status, order_id, created_at, updated_at)
       VALUES (?, ?, ?, 'count', ?, ?, 24, 18, 6, ?, ?, 'active', ?, ?, ?)`,
    id, typeId, typeName, studentId, studentId + '名', t - 100 * DAY, t + 100 * DAY, orderId, t, t);
}
function mkCourse(id, name) {
  ins("INSERT OR IGNORE INTO courses (id, name, category, consume_classes, is_active, created_at) VALUES (?, ?, 'training', 1, 1, ?)",
    id, name, t);
}
function mkSchedule(id, courseId, courseName) {
  ins(`INSERT OR IGNORE INTO schedules (id, course_id, course_name, teacher_id, teacher_name,
         date, start_time, end_time, status, enrolled_count, created_at, updated_at)
       VALUES (?, ?, ?, 'teacher_clamp', '一致性教练', ?, '09:00', '10:00', 'scheduled', 0, ?, ?)`,
    id, courseId, courseName, today, t, t);
}

/**
 * 造一个「已被兑换掉一部分」的积分账户，这是本套件的核心夹具：
 *   · 先发一笔 earned 分的 earn 流水（reference_id = earnedRef，type 由 earnedType 指定），
 *   · 再记一笔 consumed 分的 consume 流水（模拟已兑换），
 *   · 余额 = earned − consumed。
 * 这样 **夹具自身就满足「流水净额 == 余额」**（signedSum 口径），
 * 否则「修复后两者相等」可能是夹具造假的假绿。
 *
 * 注意：consume 流水的 amount 在本项目里存**正数**（points.js:130），
 * 扣减体现在 type 上，故净额口径为
 *   SUM(CASE WHEN type='consume' THEN -amount ELSE amount END)。
 */
function mkPointsAccount(studentId, studentName, earnedRef, earned, consumed, earnedType) {
  const balance = earned - consumed;
  ins(`INSERT OR IGNORE INTO points (id, student_id, student_name, total_earned, total_consumed, balance, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'pts_' + studentId, studentId, studentName, earned, consumed, balance, t);
  ins(`INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, created_at)
       VALUES (?, ?, ?, ?, ?, '夹具发放', ?, '夹具', ?)`,
    'plog_e_' + studentId, studentId, earnedType || 'earn', earned, earned, earnedRef, t);
  if (consumed > 0) {
    ins(`INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, created_at)
         VALUES (?, ?, 'consume', ?, ?, '夹具兑换', ?, '夹具', ?)`,
      'plog_c_' + studentId, studentId, consumed, balance, 'consume_' + studentId, t);
  }
}

// ---------- 观测封装 ----------
const ptsOf = (stu) => db.prepare('SELECT total_earned, balance FROM points WHERE student_id = ?').get(stu);
/** 流水金额的**原样合计**（不看 type，与 team-lead 断言口径一致） */
const rawSum = (stu) => db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM point_logs WHERE student_id = ?').get(stu).s;
/** 流水金额的**净额**（consume 记负）—— 与 points.balance 应当恒等 */
const signedSum = (stu) => db.prepare(
  "SELECT COALESCE(SUM(CASE WHEN type = 'consume' THEN -amount ELSE amount END), 0) AS s FROM point_logs WHERE student_id = ?"
).get(stu).s;
const logsOf = (stu) => db.prepare('SELECT id, type, amount, reference_id FROM point_logs WHERE student_id = ? ORDER BY created_at').all(stu);
const refCount = (ref) => db.prepare('SELECT COUNT(*) AS c FROM point_logs WHERE reference_id = ?').get(ref).c;

function orderRefund(orderId, body) {
  const res = mockRes();
  getHandler(ordersRouter, 'post', '/:id/refund')(asAdmin({ params: { id: orderId }, body: body || {} }), res);
  return res;
}
function orderCancel(orderId) {
  const res = mockRes();
  getHandler(ordersRouter, 'post', '/:id/cancel')(asAdmin({ params: { id: orderId } }), res);
  return res;
}
function cardRefund(cardId, studentId) {
  const res = mockRes();
  getHandler(membershipRouter, 'post', '/refund')(asAdmin({ body: { cardId, studentId, reason: '一致性回归-退卡' } }), res);
  return res;
}
function deleteCourse(courseId) {
  const res = mockRes();
  getHandler(adminRouter, 'delete', '/courses/:id')(asAdmin({ params: { id: courseId } }), res);
  return res;
}

/**
 * 一条回收路径的**统一断言组**（四条路径共用，避免各写一份口径漂移）。
 * @param {string} tag 用例前缀
 * @param {string} stu 学员 id
 * @param {number} beforeRaw 调用前的「流水原样合计」
 * @param {number} earned 夹具发放的积分数
 * @param {number} consumed 夹具已兑换数（余额 = earned − consumed）
 */
function assertClamp(tag, stu, beforeRaw, earned, consumed) {
  const balanceBefore = earned - consumed;
  const actual = Math.min(earned, balanceBefore); // 期望的实际生效量
  const p = ptsOf(stu);
  rec(`${tag} [判别] 余额归零且不为负（期望 0，旧实现亦为 0 但原因不同）`,
    !!p && p.balance === 0, JSON.stringify(p));
  rec(`${tag} [判别] total_earned 按实际生效量扣（期望 ${earned - actual}，旧实现归 0）`,
    !!p && p.total_earned === earned - actual, JSON.stringify(p));
  rec(`${tag} [判别] 流水原样合计的变动量 === ${-actual}（旧实现为 0 或 −${earned}）`,
    rawSum(stu) - beforeRaw === -actual, `delta=${rawSum(stu) - beforeRaw}`);
  rec(`${tag} [判别] 流水净额 === 余额（账实相符）`,
    signedSum(stu) === (p && p.balance), `signed=${signedSum(stu)} balance=${p && p.balance}`);
}

console.log('\n\x1b[1m=== 积分回收 clamp 一致性回归（退款/取消/退卡/删活动 四路径）===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '（seed 夹具 + 本套件夹具）\n');

// ============================================================
// T0. 前置条件：四条路径都能直达处理器（否则后面全是假绿）
// ============================================================
console.log('\x1b[1m[T0] 前置条件：鉴权放行 + 夹具自证\x1b[0m');
{
  const a = orderRefund('ord_clamp_never', { refundAmount: 1, confirmOverride: true });
  rec('T0 POST /orders/:id/refund 未被 403 拦下（不存在的单返回业务失败）',
    a.statusCode !== 403 && a.body && a.body.code === 1, `status=${a.statusCode} body=${JSON.stringify(a.body)}`);

  const b = orderCancel('ord_clamp_never');
  rec('T0 POST /orders/:id/cancel 未被 403 拦下（不存在的单返回业务失败）',
    b.statusCode !== 403 && b.body && b.body.code === 1, `status=${b.statusCode} body=${JSON.stringify(b.body)}`);

  const c = cardRefund('mc_clamp_never', 'stu_clamp_never');
  rec('T0 POST /membership/refund 未被 403 拦下（不存在的卡返回业务失败）',
    c.statusCode !== 403 && c.body && c.body.code === 1, `status=${c.statusCode} body=${JSON.stringify(c.body)}`);

  const d = deleteCourse('crs_clamp_never');
  rec('T0 DELETE /admin/courses/:id 未被拦下（不存在的活动返回业务失败）',
    d.statusCode !== 403 && d.body && d.body.code === 1, `status=${d.statusCode} body=${JSON.stringify(d.body)}`);

  // 夹具自证：seed 里那些账户的「流水净额 == 余额」本就成立（证明 signedSum 口径正确）
  const probe = db.prepare('SELECT student_id, balance FROM points ORDER BY student_id LIMIT 1').get();
  rec('T0 夹具自证：seed 账户满足「流水净额 == 余额」（signedSum 口径正确）',
    !!probe && signedSum(probe.student_id) === probe.balance,
    `stu=${probe && probe.student_id} signed=${probe && signedSum(probe.student_id)} balance=${probe && probe.balance}`);
}

// ============================================================
// T1. orders.js 全额退款回收赠送积分（流水侧：翻转 earn → refund）
// ============================================================
console.log('\n\x1b[1m[T1] 订单全额退款回收积分（orders.js）\x1b[0m');
{
  const S = 'stu_clamp1';
  const O = 'ord_clamp1';
  const CT = 'ct_clamp1';
  mkStudent(S, '退款回收学员');
  mkCardType(CT, '退款回收卡');
  mkPaidOrder(O, 'OCLAMP1', S, CT, '退款回收卡', 1000);
  mkCard('mc_clamp1', CT, '退款回收卡', S, O);
  mkPointsAccount(S, '退款回收学员', 'order_' + O + '_' + CT, 100, 70, 'earn');

  const p0 = ptsOf(S);
  rec('T1 前置：夹具余额 30、total_earned 100',
    !!p0 && p0.balance === 30 && p0.total_earned === 100, JSON.stringify(p0));
  rec('T1 前置：夹具的流水净额 == 余额（回收前账本就相符）',
    signedSum(S) === p0.balance, `signed=${signedSum(S)} balance=${p0.balance}`);

  const beforeRaw = rawSum(S);
  const res = orderRefund(O, { refundAmount: 1000, confirmOverride: true });
  rec('T1 退款成功且为全额（full === true，才会走回收分支）',
    res.body && res.body.code === 0 && res.body.data && res.body.data.full === true,
    `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  assertClamp('T1', S, beforeRaw, 100, 70);
  rec('T1 [判别] 确实补记了一条 −30 的回收流水（旧实现只翻转、不记金额）',
    logsOf(S).some((l) => l.type === 'refund' && l.amount === -30),
    JSON.stringify(logsOf(S)));
}

// ============================================================
// T2. orders.js 取消订单回收赠送积分（流水侧：翻转 earn → refund）
// ============================================================
console.log('\n\x1b[1m[T2] 取消已支付订单回收积分（orders.js）\x1b[0m');
{
  const S = 'stu_clamp2';
  const O = 'ord_clamp2';
  const CT = 'ct_clamp2';
  mkStudent(S, '取消回收学员');
  mkCardType(CT, '取消回收卡');
  mkPaidOrder(O, 'OCLAMP2', S, CT, '取消回收卡', 1000);
  mkPointsAccount(S, '取消回收学员', 'order_' + O + '_' + CT, 100, 70, 'earn');

  const p0 = ptsOf(S);
  rec('T2 前置：夹具余额 30、流水净额 == 余额',
    !!p0 && p0.balance === 30 && signedSum(S) === 30, `balance=${p0 && p0.balance} signed=${signedSum(S)}`);

  const beforeRaw = rawSum(S);
  const res = orderCancel(O);
  rec('T2 取消成功', res.body && res.body.code === 0, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  assertClamp('T2', S, beforeRaw, 100, 70);
  rec('T2 [判别] 补记了一条 −30 的回收流水', logsOf(S).some((l) => l.type === 'refund' && l.amount === -30),
    JSON.stringify(logsOf(S)));
}

// ============================================================
// T3. membership.js 退卡回收赠送积分（流水侧：翻转 earn → refund）
// ============================================================
console.log('\n\x1b[1m[T3] 退卡回收赠送积分（membership.js）\x1b[0m');
{
  const S = 'stu_clamp3';
  const O = 'ord_clamp3';
  const CT = 'ct_clamp3';
  mkStudent(S, '退卡回收学员');
  mkCardType(CT, '退卡回收卡');
  mkPaidOrder(O, 'OCLAMP3', S, CT, '退卡回收卡', 1000);
  mkCard('mc_clamp3', CT, '退卡回收卡', S, O);
  mkPointsAccount(S, '退卡回收学员', 'order_' + O + '_' + CT, 100, 70, 'earn');

  const p0 = ptsOf(S);
  rec('T3 前置：夹具余额 30、流水净额 == 余额',
    !!p0 && p0.balance === 30 && signedSum(S) === 30, `balance=${p0 && p0.balance} signed=${signedSum(S)}`);

  const beforeRaw = rawSum(S);
  const res = cardRefund('mc_clamp3', S);
  rec('T3 退卡成功', res.body && res.body.code === 0, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  assertClamp('T3', S, beforeRaw, 100, 70);
  rec('T3 [判别] 补记了一条 −30 的回收流水', logsOf(S).some((l) => l.type === 'refund' && l.amount === -30),
    JSON.stringify(logsOf(S)));
}

// ============================================================
// T4. admin.js 删除活动按净额回滚积分（流水侧：整批 DELETE）
// ============================================================
console.log('\n\x1b[1m[T4] 删除活动回滚签到积分（admin.js，流水侧是 DELETE）\x1b[0m');
{
  const S = 'stu_clamp4';
  const CRS = 'crs_clamp4';
  const SCH = 'sch_clamp4';
  mkStudent(S, '删课回滚学员');
  mkCourse(CRS, '删课回滚活动');
  mkSchedule(SCH, CRS, '删课回滚活动');
  // 签到净发放 100（type='checkin'，reference_id = 排期 id），已兑换 70 → 余额 30
  mkPointsAccount(S, '删课回滚学员', SCH, 100, 70, 'checkin');

  const p0 = ptsOf(S);
  rec('T4 前置：夹具余额 30、流水净额 == 余额',
    !!p0 && p0.balance === 30 && signedSum(S) === 30, `balance=${p0 && p0.balance} signed=${signedSum(S)}`);

  const beforeRaw = rawSum(S);
  const res = deleteCourse(CRS);
  rec('T4 删除活动成功', res.body && res.body.code === 0, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  assertClamp('T4', S, beforeRaw, 100, 70);
  // 护栏：流水清理契约不得被破坏（finance-payroll 套件亦断言此项）
  rec('T4 [护栏] 该活动的积分流水仍被整批清理（reference_id 行数归零）',
    refCount(SCH) === 0, `count=${refCount(SCH)}`);
}

// ============================================================
// T5. 余额充足时行为不变
//     判别力边界（据实标注）：
//       · T5a 的「Δ = −100」「流水净额 == 余额」两条**是判别项**，不是护栏 ——
//         前三条路径的流水侧是「翻转 earn→refund、不写金额」，故即便余额充足
//         （无截断），旧实现的流水净变动仍是 0，净额 100 ≠ 余额 0，账实照样不符。
//         这说明前三处的问题**不止于截断**：旧实现根本没把回收额记进流水。
//       · T5a 的「余额归零 / total_earned 归零」与 T5b 整段在修复前后同结果 → 护栏。
// ============================================================
console.log('\n\x1b[1m[T5] 余额充足时的回收（护栏 + 两条判别项）\x1b[0m');
{
  // T5a 订单全额退款：余额 100，回收 100 → 应全额回收
  const S = 'stu_clamp5';
  const O = 'ord_clamp5';
  const CT = 'ct_clamp5';
  mkStudent(S, '足额回收学员');
  mkCardType(CT, '足额回收卡');
  mkPaidOrder(O, 'OCLAMP5', S, CT, '足额回收卡', 1000);
  mkCard('mc_clamp5', CT, '足额回收卡', S, O);
  mkPointsAccount(S, '足额回收学员', 'order_' + O + '_' + CT, 100, 0, 'earn');

  const beforeRaw = rawSum(S);
  const res = orderRefund(O, { refundAmount: 1000, confirmOverride: true });
  rec('T5a 退款成功且为全额', res.body && res.body.code === 0 && res.body.data.full === true,
    JSON.stringify(res.body));
  const p = ptsOf(S);
  rec('T5a [护栏] 余额归零', !!p && p.balance === 0, JSON.stringify(p));
  rec('T5a [护栏] total_earned 归零（足额回收时与旧实现一致）', !!p && p.total_earned === 0, JSON.stringify(p));
  rec('T5a [判别] 流水原样合计的变动量 === −100（余额充足、无截断；旧实现仍为 0）',
    rawSum(S) - beforeRaw === -100, `delta=${rawSum(S) - beforeRaw}`);
  rec('T5a [判别] 流水净额 === 余额（旧实现 100 ≠ 0：回收额根本没记进流水）',
    signedSum(S) === (p && p.balance), `signed=${signedSum(S)} balance=${p && p.balance}`);

  // T5b 删活动：余额 100，回滚 100 → 应全额回滚且不补记差额行
  const S2 = 'stu_clamp6';
  const CRS = 'crs_clamp6';
  const SCH = 'sch_clamp6';
  mkStudent(S2, '足额删课学员');
  mkCourse(CRS, '足额删课活动');
  mkSchedule(SCH, CRS, '足额删课活动');
  mkPointsAccount(S2, '足额删课学员', SCH, 100, 0, 'checkin');

  const beforeRaw2 = rawSum(S2);
  const res2 = deleteCourse(CRS);
  rec('T5b 删除活动成功', res2.body && res2.body.code === 0, JSON.stringify(res2.body));
  const p2 = ptsOf(S2);
  rec('T5b [护栏] 余额归零、total_earned 归零', !!p2 && p2.balance === 0 && p2.total_earned === 0, JSON.stringify(p2));
  rec('T5b [护栏] 流水原样合计的变动量 === −100（足额回滚，未补记差额）',
    rawSum(S2) - beforeRaw2 === -100, `delta=${rawSum(S2) - beforeRaw2}`);
  rec('T5b [护栏] 该活动的积分流水已整批清理', refCount(SCH) === 0, `count=${refCount(SCH)}`);
}

// ============================================================
// 收尾：临时库由 _bootstrap.cjs 在进程退出时整目录删除
// ============================================================
console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
