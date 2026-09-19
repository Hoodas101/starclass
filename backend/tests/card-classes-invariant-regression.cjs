/**
 * 回归套件 —— 会员卡课时三列恒等式 `total = remaining + used`（两条「交出权益」路径）
 *
 * 被验证的缺陷：
 *   member_cards 用三列描述课时：total_classes / remaining_classes / used_classes，
 *   业务语义要求恒等式 **total = remaining + used** 永远成立。
 *   正常路径都是成对增减的，本来就自洽：
 *     · 扣课   membership.js:544  remaining -= n, used += n
 *     · 请假扣课 leave.js:70      remaining -= n, used += n
 *     · 签到回滚 checkin.js:168   remaining += back, used -= back（back 取自迁移 019 的 count）
 *   但两条「交出权益」的路径会破坏它：
 *     1) orders.js:548 订单退款回收卡内剩余课时 —— 修复前是
 *        `UPDATE member_cards SET remaining_classes = 0`，**只置 remaining 不加 used**。
 *        例：24 节课用了 6 节，退后变成 24 = 0 + 6，不成立。
 *     2) membership.js:705 退卡 —— 修复前只 `SET status='refunded'`，课时三列原样留着
 *        → 一张已退掉的卡仍显示「剩余 18 节」，且卡本身再也答不出「一共消耗了多少课时」。
 *
 * 修复方式（已完成，本套件只做验证，不改业务代码）：
 *   · orders.js:548 改为
 *     `SET used_classes = used_classes + remaining_classes, remaining_classes = 0`（次数卡）。
 *   · membership.js:705 次数卡同样成对回收并置 status='refunded'；时效卡只置 status
 *     （时效卡不消耗课时，不动课时三列是有意设计）。
 *   恒等式一破就无法从卡本身回答「这张卡一共消耗了多少课时」，且**没有任何自愈机制**，
 *   故本套件把它作为**跨路径不变量**逐条断言，而不是只测某一条路径的返回值。
 *
 * 判别力实测（不是推测 —— 已把 backend/ 整树 rsync 到 /tmp/head-backend-probe（排除
 * node_modules 并软链回工作区依赖），用 `git show HEAD:backend/routes/orders.js` 与
 * `git show HEAD:backend/routes/membership.js` **只覆盖这两个文件**，其余（含 db/、
 * utils/、tests/）保持工作区版本，在副本上跑本套件；工作区业务代码未改动）：
 *   修复前：PASS 31 / FAIL 6      修复后：PASS 37 / FAIL 0
 *   6 条 FAIL 全部落在标 [判别] 的条目上，一处不多一处不少：
 *     · T1 [判别] used_classes === 24（HEAD 版实测 6，回收的 18 节没计入已用）
 *     · T1 [判别] 恒等式成立（HEAD 版实测 24 ≠ 0 + 6）
 *     · T1 [判别] used === 回收前 (used + remaining)（HEAD 版实测 6，课时凭空蒸发 18 节）
 *     · T2 [判别] remaining_classes === 0（HEAD 版实测 18，已退卡仍显示剩余 18 节）
 *     · T2 [判别] used_classes === 24（HEAD 版实测 6）
 *     · T5 [判别] 全表恒等式扫描 0 张违例卡（HEAD 版实测 1 张违例 —— 即 T1 那张 mc_ci1）
 *   其余 31 条（T0 前置/自证 9 + T1 非判别 5〔3 条前置 + 2 条护栏〕+ T2 非判别 4
 *   〔1 条成功 + 2 条护栏 + 1 条自证〕+ T3 非判别 6 + T4 非判别 6 + T5 护栏 1）
 *   在修复前后结果相同，均已在下方逐条标注为「护栏」或「前置」。
 *   注：T1 的 `total_classes === remaining + used` 与 `used === 回收前 used + remaining`
 *   两条在修复后结果相同（都为真），但判别口径不同 —— 前者是跨路径不变量，后者用
 *   操作前快照断言课时守恒，可额外捕获「回收被应用两次」「used 被硬写成 total」等错误实现。
 *   另：初版曾写过一条 `累计消耗 = total − remaining` 的断言，实测在 HEAD 版下也 PASS
 *   （HEAD 版 remaining 归零后该式恰好也等于 24），属**假判别项**，已删除并换成上面的快照式断言。
 *
 * 判别力边界（据实标注，避免把「护栏」伪装成「判别项」）：
 *   · **T2 的恒等式断言在本对照中是「护栏」而非判别项**：HEAD 版退卡只改 status、
 *     课时三列原样不动，24 = 18 + 6 本来就成立。退卡路径真正的判别项是
 *     `remaining_classes === 0` 与 `used_classes === 24`（HEAD 版为 18 / 6）。
 *     恒等式在此的作用是钉住「回收动作必须成对，不能只归零 remaining」。
 *   · **T3（时效卡退卡）整段在本对照中都是「护栏」**：HEAD 版本就只置 status、
 *     不动课时列，与本套件的期望一致，故该段 6 条断言修复前后同结果。
 *     它的判别力针对的是**过度套用修复**（把次数卡的成对回收无条件套到时效卡上），
 *     不是针对 HEAD 版；故如实标为护栏，不粉饰成判别项。
 *   · **T4（正常路径扣课 + 回滚）整段是「护栏」**：HEAD 版扣课与回滚本就成对增减，
 *     该段 6 条断言修复前后同结果。保留原因：任务清单要求覆盖，且它钉死「不许为了让
 *     恒等式好看而把正常扣课改坏（例如扣课只减 remaining 不加 used）」。
 *   · T0 的三条探针（不存在的订单 / 卡 / 卡）是**前置条件**：证明三个接口的调用确实
 *     没被 403 拦下。否则下面所有断言都可能是「压根没进业务逻辑」的假绿。
 *     探针刻意全部传不存在的 id（尤其扣课必须传不存在的 cardId）—— 扣课路由不校验
 *     排期存在性、只按 cardId 查卡，传真实卡会真的扣掉 1 节并污染 T1 夹具（初版即踩此坑，
 *     故额外补了 2 条「探针未污染夹具」的自证断言）。
 *   · T0 的三条夹具自证（三张探针卡操作前均满足恒等式）同样是前置条件。
 *   · T0 的最后一条（member_cards 上无 CHECK 约束强制恒等式）也是前置条件：
 *     若哪天有人加了 CHECK(total = remaining + used)，本套件里「破坏恒等式」的
 *     写入会直接抛异常而非写坏数据，断言形态随之改变，故显式钉死这一前提。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db）：
 *   node tests/card-classes-invariant-regression.cjs
 *   KEEP_TEST_DB=1 node tests/card-classes-invariant-regression.cjs   （保留临时库排查）
 *
 * 写法说明：建库/清理沿用 _bootstrap.cjs（seed 夹具 + 退出时删除临时库）；
 * 直调路由处理器沿用 order-benefits-idempotency-regression.cjs 的
 * getHandler/mockRes/mockReq（不启 HTTP 服务，避免与线上占用的 3001 端口及并发套件冲突）；
 * 「扣课 + 清除签到回滚」的夹具沿用 deduction-count-regression.cjs 的同款写法。
 */
'use strict';

// ---- 隔离库（必须在 require('../db') 之前设置）----
const { bootstrap } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-card-classes-invariant');

const db = require('../db');
const { now, formatDate } = require('../utils');
const ordersRouter = require('../routes/orders');
const membershipRouter = require('../routes/membership');
const checkinRouter = require('../routes/checkin');

// 防呆：临时库必须落在 /tmp，绝不能是真实库 backend/db/data.db
if (!String(process.env.DB_PATH || '').startsWith('/tmp/')) {
  console.error('[致命] DB_PATH 不在 /tmp，拒绝运行以免污染真实库:', process.env.DB_PATH);
  process.exit(2);
}

// ---------- 直调路由处理器（与 order-benefits-idempotency-regression.cjs 同款）----------
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

function mkStudent(id, name) {
  ins('INSERT OR IGNORE INTO students (id, name, status) VALUES (?, ?, \'active\')', id, name);
}
/** 会员卡「产品」（membership_cards）。refundable 显式给 1，否则退卡接口按卡类型设置拒绝。 */
function mkCardType(id, name, o) {
  const { total = 0, days = 200, mode = 'count', price = 2400 } = o || {};
  ins(`INSERT OR IGNORE INTO membership_cards (id, name, total_classes, valid_days, billing_mode,
         price, course_scope, transferable, refundable, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '全活动通用', 0, 1, 1, ?)`,
    id, name, total, days, mode, price, t);
}
/** 已支付订单（单明细 = 本卡商品，无折扣 → 折后成交价 = payable） */
function mkPaidOrder(id, orderNo, studentId, typeId, typeName, amount) {
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, items, payable_amount,
         discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, 'membership', ?, ?, 0, 0, ?, 'paid', ?, ?, ?)`,
    id, orderNo, studentId,
    JSON.stringify([{ itemType: 'membershipCard', itemId: typeId, itemName: typeName, quantity: 1, unitPrice: amount, totalPrice: amount }]),
    amount, amount, t, t, t);
}
/**
 * 建会员卡实例。total/remaining/used 三个值**由调用方显式给出且必须满足恒等式** ——
 * 夹具自身先自证正确（T0），否则后面「修复后恒等式成立」可能是夹具造假的假绿。
 */
function mkCard(id, typeId, typeName, studentId, studentName, o) {
  const { mode = 'count', total = 24, remaining = 18, used = 6, orderId = null } = o || {};
  ins(`INSERT OR IGNORE INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id,
         student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at,
         status, order_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    id, typeId, typeName, mode, studentId, studentName, total, remaining, used,
    t - 100 * DAY, t + 100 * DAY, orderId, t, t);
}
function mkCourse(id, name, consume) {
  ins(`INSERT OR IGNORE INTO courses (id, name, category, consume_classes, is_active, created_at)
       VALUES (?, ?, 'training', ?, 1, ?)`, id, name, consume, t);
}
function mkSchedule(id, courseId, courseName) {
  ins(`INSERT OR IGNORE INTO schedules (id, course_id, course_name, teacher_id, teacher_name,
         date, start_time, end_time, status, enrolled_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?)`,
    id, courseId, courseName, 'teacher_ci', '恒等式教练', today, '09:00', '10:00', t, t);
}
/** 清除签到回滚路径要求 attendances 里存在记录，否则直接短路返回。 */
function mkAttendance(scheduleId, studentId, studentName, courseId, courseName, status) {
  ins(`INSERT OR IGNORE INTO attendances (id, schedule_id, student_id, student_name, course_id,
         course_name, status, checkin_method, date, points_earned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'teacher', ?, 0, ?, ?)`,
    `att_${scheduleId}`, scheduleId, studentId, studentName, courseId, courseName, status, today, t, t);
}

// ---------- 观测封装 ----------
/** 卡的全部课时列 + 状态（断言一律基于重新读库，不信任路由返回值） */
const cardOf = (id) => db.prepare(
  'SELECT id, billing_mode, total_classes, remaining_classes, used_classes, status FROM member_cards WHERE id = ?'
).get(id);
/** 恒等式判据：total = remaining + used */
const identityHolds = (c) => !!c
  && Number(c.total_classes) === Number(c.remaining_classes) + Number(c.used_classes);
const idText = (c) => (c
  ? `total=${c.total_classes} remaining=${c.remaining_classes} used=${c.used_classes}`
  : 'undefined');
/** 全表违例卡（不含任何 status 过滤：已退卡同样必须满足恒等式） */
const violatingCards = () => db.prepare(
  'SELECT id, total_classes, remaining_classes, used_classes FROM member_cards WHERE total_classes <> remaining_classes + used_classes'
).all();

// ---------- 路由调用封装（统一以管理员身份）----------
// orders/:id/refund 与 membership/refund 都走 isAdminReq(req)，userRole='admin' 即通过。
const asAdmin = (extra) => mockReq(Object.assign({ userRole: 'admin', openid: 'admin_ci' }, extra));

/** POST /api/orders/:id/refund —— 省略 refundAmount 即「按规则建议值退款」 */
function orderRefund(orderId, body) {
  const res = mockRes();
  getHandler(ordersRouter, 'post', '/:id/refund')(asAdmin({
    params: { id: orderId }, body: body || { reason: '恒等式回归-订单退款' },
  }), res);
  return res;
}
/** POST /api/membership/refund —— 退卡 */
function cardRefund(cardId, studentId) {
  const res = mockRes();
  getHandler(membershipRouter, 'post', '/refund')(asAdmin({
    body: { cardId, studentId, reason: '恒等式回归-退卡' },
  }), res);
  return res;
}
/** POST /api/membership/deduct —— 扣课 */
function deduct(body) {
  const res = mockRes();
  getHandler(membershipRouter, 'post', '/deduct')(asAdmin({ body }), res);
  return res;
}
/** POST /api/checkin/teacher —— 单学员点名（status='clear' 即回滚扣课） */
function checkin(scheduleId, studentId, status) {
  const res = mockRes();
  getHandler(checkinRouter, 'post', '/teacher')(asAdmin({
    body: { scheduleId, attendances: [{ studentId, status }] },
  }), res);
  return res;
}

console.log('\n\x1b[1m=== 会员卡课时恒等式回归测试（total = remaining + used）===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '（seed 夹具 + 本套件夹具）\n');

// ---------- 夹具：三条互不干扰的「交出权益」场景 + 一条正常路径场景 ----------
// T1：订单退款回收课时（partial 退款，命中 orders.js:533 的 custom + cardId 分支）
const CT1 = 'ct_ci_refund';
mkStudent('stu_ci1', '恒等式T1学员');
mkCardType(CT1, '恒等式次卡', { total: 24, days: 200, mode: 'count', price: 2400 });
mkPaidOrder('ord_ci1', 'OCI001', 'stu_ci1', CT1, '恒等式次卡', 2400);
mkCard('mc_ci1', CT1, '恒等式次卡', 'stu_ci1', '恒等式T1学员', { mode: 'count', total: 24, remaining: 18, used: 6, orderId: 'ord_ci1' });

// T2：退卡（次数卡）
const CT2 = 'ct_ci_cancel_count';
mkStudent('stu_ci2', '恒等式T2学员');
mkCardType(CT2, '恒等式次卡2', { total: 24, days: 200, mode: 'count', price: 2400 });
mkPaidOrder('ord_ci2', 'OCI002', 'stu_ci2', CT2, '恒等式次卡2', 2400);
mkCard('mc_ci2', CT2, '恒等式次卡2', 'stu_ci2', '恒等式T2学员', { mode: 'count', total: 24, remaining: 18, used: 6, orderId: 'ord_ci2' });

// T3：退卡（时效卡）—— 课时三列刻意给非零值，使「未被归零」成为可证伪的断言
// （真实时效卡这三列通常都是 0，全 0 时「保持不变」是恒真的假绿）
const CT3 = 'ct_ci_cancel_time';
mkStudent('stu_ci3', '恒等式T3学员');
mkCardType(CT3, '恒等式时效卡', { total: 0, days: 200, mode: 'time', price: 2400 });
mkPaidOrder('ord_ci3', 'OCI003', 'stu_ci3', CT3, '恒等式时效卡', 2400);
mkCard('mc_ci3', CT3, '恒等式时效卡', 'stu_ci3', '恒等式T3学员', { mode: 'time', total: 12, remaining: 5, used: 7, orderId: 'ord_ci3' });

// T4：正常路径（扣课 + 清除签到回滚）
const CT4 = 'ct_ci_normal';
mkStudent('stu_ci4', '恒等式T4学员');
mkCardType(CT4, '恒等式次卡3', { total: 24, days: 200, mode: 'count', price: 2400 });
mkCard('mc_ci4', CT4, '恒等式次卡3', 'stu_ci4', '恒等式T4学员', { mode: 'count', total: 24, remaining: 18, used: 6 });
mkCourse('crs_ci4', '恒等式单课时课', 1);
mkSchedule('sch_ci4', 'crs_ci4', '恒等式单课时课');
mkAttendance('sch_ci4', 'stu_ci4', '恒等式T4学员', 'crs_ci4', '恒等式单课时课', 'present');

// ============================================================
// T0. 前置条件：鉴权放行 + 夹具自证 + 无 CHECK 兜底
// ============================================================
console.log('\x1b[1m[T0] 前置条件\x1b[0m');
{
  // 不存在的订单：能走到 fail('订单不存在') 说明鉴权没把它拦在 403
  const o = orderRefund('ord_ci_never_exists');
  rec('T0 POST /api/orders/:id/refund 未被 403 拦下（管理员身份生效，不存在的单返回业务失败）',
    o.statusCode !== 403 && o.body && o.body.code === 1 && /不存在/.test(o.body.message || ''),
    `status=${o.statusCode} body=${JSON.stringify(o.body)}`);

  // 不存在的卡：同上
  const c = cardRefund('mc_ci_never_exists', 'stu_ci1');
  rec('T0 POST /api/membership/refund 未被 403 拦下（不存在的卡返回业务失败）',
    c.statusCode !== 403 && c.body && c.body.code === 1 && /不存在/.test(c.body.message || ''),
    `status=${c.statusCode} body=${JSON.stringify(c.body)}`);

  // 必须传一个**不存在的 cardId**：扣课路由不校验排期是否存在，只按 cardId 查卡；
  // 若此处传真实卡，探针会真的扣掉 1 节，把 T1 的夹具污染成 17/7（本套件初版即踩此坑）。
  const d = deduct({ scheduleId: 'sch_ci_never_exists', studentId: 'stu_ci1', cardId: 'mc_ci_never_exists', classes: 1 });
  rec('T0 POST /api/membership/deduct 未被 403 拦下（不存在的卡返回业务失败）',
    d.statusCode !== 403 && d.body && d.body.code === 1,
    `status=${d.statusCode} body=${JSON.stringify(d.body)}`);

  // 夹具自证：三张探针卡在**任何操作之前**都必须满足恒等式。
  // 若夹具本身造错了，下面所有「修复后恒等式成立」都是假的。
  const c1 = cardOf('mc_ci1'), c2 = cardOf('mc_ci2'), c3 = cardOf('mc_ci3');
  rec('T0 夹具自证：T1 探针卡 24 = 18 + 6（操作前恒等式成立）',
    identityHolds(c1) && c1.total_classes === 24, idText(c1));
  rec('T0 夹具自证：T2 探针卡 24 = 18 + 6',
    identityHolds(c2) && c2.total_classes === 24, idText(c2));
  rec('T0 夹具自证：T3 时效卡 12 = 5 + 7（课时列刻意非零，使「未被归零」可证伪）',
    identityHolds(c3) && c3.total_classes === 12, idText(c3));

  // 前置：没有 CHECK 约束兜底，否则「破坏恒等式」的写入会抛异常而非写坏数据
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'member_cards'").get();
  rec('T0 前置：member_cards 上无 CHECK 约束强制恒等式（故修复前真的会写坏数据而非报错）',
    !!ddl && !/CHECK/i.test(ddl.sql || ''), ddl && ddl.sql);

  // 自证：上面三次探针调用**都没有改动任何课时**（否则 T1/T2 的夹具会带着脏状态进场景，
  // 断言即便通过也不是在验证修复本身）。
  const p1 = cardOf('mc_ci1'), p2 = cardOf('mc_ci2'), p3 = cardOf('mc_ci3');
  rec('T0 自证：T0 的三次探针调用未污染夹具（mc_ci1 仍 24 = 18 + 6）',
    !!p1 && p1.total_classes === 24 && p1.remaining_classes === 18 && p1.used_classes === 6,
    idText(p1));
  rec('T0 自证：mc_ci2 / mc_ci3 亦未被探针改动',
    !!p2 && p2.remaining_classes === 18 && p2.used_classes === 6
      && !!p3 && p3.total_classes === 12 && p3.remaining_classes === 5 && p3.used_classes === 7,
    `${idText(p2)} | ${idText(p3)}`);
}

// ============================================================
// T1. 订单退款回收课时（次数卡）—— 核心判别项
//     命中 orders.js:533 的 `appliedSuggestion && started && (custom|ratio) && cardId` 分支
// ============================================================
console.log('\n\x1b[1m[T1] 订单退款回收剩余课时 → 必须计入 used（orders.js:548）\x1b[0m');
{
  const before = cardOf('mc_ci1'); // 回收前快照：24 = 18 + 6
  const res = orderRefund('ord_ci1');
  const d = res.body && res.body.data;
  rec('T1 按规则建议值退款成功（未 403、未 500）',
    res.statusCode === 200 && res.body && res.body.code === 0, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);
  // 前置：必须落在 partial（非全额）分支，否则会走「全额退款置 status」那条路，测不到 clawback
  rec('T1 前置：本次为部分退款（full === false），确实进入了权益回收分支',
    !!d && d.full === false, JSON.stringify(d));
  rec('T1 前置：路由回报 clawback 非空（证明回收分支被执行，而非静默跳过）',
    !!d && !!d.clawback, JSON.stringify(d));

  const c = cardOf('mc_ci1');
  // 护栏：remaining 归零在 HEAD 版也是对的（HEAD 版就是 SET remaining = 0）
  rec('T1 [护栏] remaining_classes === 0（HEAD 版本亦为 0）',
    !!c && c.remaining_classes === 0, idText(c));
  // 判别力：HEAD 版只置 remaining，回收的 18 节凭空消失，used 仍是 6。
  rec('T1 [判别] used_classes === 24（HEAD 版实测 6：回收的 18 节未计入已用）',
    !!c && c.used_classes === 24, idText(c));
  rec('T1 [判别] total_classes === remaining + used（HEAD 版实测 24 ≠ 0 + 6）',
    identityHolds(c), idText(c));
  // 判别力：以「操作前的快照」为准，断言课时守恒 —— used 必须等于「原 used + 原 remaining」。
  // 用快照而非硬编码 24，可额外捕获「回收动作被应用两次」（used=42）或「used 被硬写成 total」
  // 这类错误实现；也避免把 total − remaining 这种「绕过 used 的反推」误当成本条要验证的口径。
  rec('T1 [判别] used_classes === 回收前 (used + remaining) = 6 + 18（HEAD 版实测 6，课时凭空蒸发 18 节）',
    !!c && c.used_classes === before.used_classes + before.remaining_classes,
    `回收前 ${idText(before)} → 回收后 ${idText(c)}`);
  // 护栏：部分退款不改卡状态（只有全额退款才置 refunded）
  rec('T1 [护栏] 部分退款不改卡状态（仍为 active，权益只是被回收不是被作废）',
    !!c && c.status === 'active', `status=${c && c.status}`);
}

// ============================================================
// T2. 退卡（次数卡）—— 核心判别项
// ============================================================
console.log('\n\x1b[1m[T2] 退卡（次数卡）→ 必须回收课时并计入 used（membership.js:705）\x1b[0m');
{
  const res = cardRefund('mc_ci2', 'stu_ci2');
  rec('T2 退卡成功（未 403、未 500）',
    res.statusCode === 200 && res.body && res.body.code === 0, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  const c = cardOf('mc_ci2');
  // 判别力：HEAD 版只置 status，remaining 原样留着 → 已退卡仍显示「剩余 18 节」。
  rec('T2 [判别] remaining_classes === 0（HEAD 版实测 18：已退掉的卡仍显示剩余 18 节）',
    !!c && c.remaining_classes === 0, idText(c));
  rec('T2 [判别] used_classes === 24（HEAD 版实测 6）',
    !!c && c.used_classes === 24, idText(c));
  // 护栏（据实标注）：HEAD 版不动课时列，24 = 18 + 6 本来就成立，故本条不是判别项。
  // 它的作用是钉住「回收动作必须成对 —— 不能只把 remaining 归零而不加 used」。
  rec('T2 [护栏] 恒等式仍成立（HEAD 版亦成立；本条防的是「只归零 remaining」的半截实现）',
    identityHolds(c), idText(c));
  // 护栏：HEAD 版本就置 status='refunded'
  rec('T2 [护栏] status === "refunded"（HEAD 版本亦如此）',
    !!c && c.status === 'refunded', `status=${c && c.status}`);

  // 自证：退卡确实产生了资金流水（避免「卡被改坏但其实没走退卡逻辑」）
  const rfnd = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE order_type = 'refund' AND student_id = 'stu_ci2'").get();
  rec('T2 自证：退卡确实落了一条 order_type=refund 的流水（退卡逻辑真的跑过）',
    rfnd.c === 1, `refund orders=${rfnd.c}`);
}

// ============================================================
// T3. 退卡（时效卡）—— 课时三列**有意保持原样**
//     【整段为护栏，非判别项】HEAD 版本就只置 status、不动课时列，与本套件期望一致，
//     故 4 条断言修复前后同结果。它的判别力针对的是「把次数卡的成对回收无条件套到
//     时效卡上」这种**过度套用修复**的错误实现，不是针对 HEAD 版。
// ============================================================
console.log('\n\x1b[1m[T3] 退卡（时效卡）→ 只置 status，课时三列不得被归零（护栏）\x1b[0m');
{
  const res = cardRefund('mc_ci3', 'stu_ci3');
  rec('T3 时效卡退卡成功（未 403、未 500）',
    res.statusCode === 200 && res.body && res.body.code === 0, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  const c = cardOf('mc_ci3');
  rec('T3 [护栏] status === "refunded"',
    !!c && c.status === 'refunded', `status=${c && c.status}`);
  // 判别力（针对过度套用修复，非针对 HEAD）：若把次数卡分支无条件套上来，
  // remaining 会变 0、used 会变 12 —— 这三条会立刻变红。
  rec('T3 [护栏] remaining_classes 保持 5（未被归零）',
    !!c && c.remaining_classes === 5, idText(c));
  rec('T3 [护栏] used_classes 保持 7（未被回收动作追加）',
    !!c && c.used_classes === 7, idText(c));
  rec('T3 [护栏] total_classes 保持 12',
    !!c && c.total_classes === 12, idText(c));
  rec('T3 [护栏] 恒等式依然成立（12 = 5 + 7）',
    identityHolds(c), idText(c));
}

// ============================================================
// T4. 正常路径护栏：扣一次课 → 清除签到回滚，恒等式全程成立
//     【整段为护栏，非判别项】HEAD 版扣课与回滚本就成对增减，4 条断言修复前后同结果。
//     保留原因：任务清单要求覆盖；且它钉死「不许为了让恒等式好看而把正常扣课改坏」
//     （例如把扣课改成只减 remaining 不加 used —— 那样 T4 会立刻变红）。
// ============================================================
console.log('\n\x1b[1m[T4] 正常路径护栏：扣课 + 清除签到回滚，恒等式全程成立（护栏）\x1b[0m');
{
  const r1 = deduct({ scheduleId: 'sch_ci4', studentId: 'stu_ci4', cardId: 'mc_ci4', classes: 1 });
  const d1 = r1.body && r1.body.data;
  rec('T4 扣课 1 节成功',
    !!d1 && d1.deducted === 1, `status=${r1.statusCode} body=${JSON.stringify(r1.body)}`);

  const afterDeduct = cardOf('mc_ci4');
  rec('T4 [护栏] 扣课后 remaining=17 / used=7（成对增减）',
    !!afterDeduct && afterDeduct.remaining_classes === 17 && afterDeduct.used_classes === 7,
    idText(afterDeduct));
  rec('T4 [护栏] 扣课后恒等式成立（24 = 17 + 7；若扣课只减 remaining 不加 used 则为 24 ≠ 17 + 6）',
    identityHolds(afterDeduct), idText(afterDeduct));

  const r2 = checkin('sch_ci4', 'stu_ci4', 'clear');
  rec('T4 清除签到（回滚扣课）成功',
    r2.statusCode === 200 && r2.body && r2.body.code === 0, `status=${r2.statusCode} body=${JSON.stringify(r2.body)}`);

  const afterRollback = cardOf('mc_ci4');
  rec('T4 [护栏] 回滚后 remaining=18 / used=6（回到扣课前，未凭空增减）',
    !!afterRollback && afterRollback.remaining_classes === 18 && afterRollback.used_classes === 6,
    idText(afterRollback));
  rec('T4 [护栏] 回滚后恒等式成立（24 = 18 + 6）',
    identityHolds(afterRollback), idText(afterRollback));
}

// ============================================================
// T5. 跨路径不变量：全表扫描，任何一张卡都不得破坏恒等式
//     [判别]（间接）：HEAD 版下 T1 那张卡会被写坏，本段即报 1 张违例。
// ============================================================
console.log('\n\x1b[1m[T5] 跨路径不变量：全表恒等式扫描\x1b[0m');
{
  const bad = violatingCards();
  // 判别力：HEAD 版实测 1 张违例（mc_ci1：24 = 0 + 6）。
  rec('T5 [判别] 全表无违例卡（HEAD 版实测 1 张违例 —— T1 的订单退款回收卡）',
    bad.length === 0, `违例=${JSON.stringify(bad)}`);
  // 护栏：证明本套件确实造了足够多的卡来扫描，否则「0 张违例」可能是表为空的假绿。
  const total = db.prepare('SELECT COUNT(*) AS c FROM member_cards').get().c;
  rec('T5 [护栏] 扫描覆盖面：表内卡数 ≥ 9（seed 6 张 + 本套件 4 张，防止空表假绿）',
    total >= 9, `total=${total}`);
}

// ============================================================
// 收尾：临时库由 _bootstrap.cjs 在进程退出时整目录删除
// ============================================================
console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
