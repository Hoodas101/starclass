/**
 * 回归套件 —— 订单发卡 / 发积分的「幂等」（orders.js grantOrderBenefits）
 *
 * 被验证的缺陷：
 *   grantOrderBenefits(order, paidAt) 负责「订单已 paid 后发会员卡 + 发购买积分」，
 *   修复前它**没有任何去重**：每次调用都无条件 INSERT INTO member_cards。
 *   而它的调用点有多个 —— settleOrder（建单即 paid、订单支付、批量导入都会走）、
 *   membership /activate、wxpay 支付回调（wxpay.js:121）—— 只要同一条已付订单
 *   被其中两条路径各碰一次，就会重复建卡，**学员课时资产凭空翻倍**，
 *   退款金额、退卡口径、续费预警随之全部失真。
 *
 * 修复方式（已完成，本套件只做验证，不改业务代码）：
 *   按「订单 + 卡种」计数补齐 —— 预扫本单每个卡种的明细条数 wanted（一单可合法
 *   包含同一卡种的多条明细），统计库里已为该 order_id + card_type_id 发过几张
 *   issued（**不按 status 过滤**：已退卡也算发过，不能自动补发），只补发
 *   wanted − issued 张；建卡与发积分整体包进 db.transaction()。
 *   关键约束：**不能对 order_id 加唯一约束** —— 一张订单合法地对应多张卡
 *   （多卡种 / 同卡种多份），故只能用计数补齐，不能用 UNIQUE 兜底。
 *
 * 判别力实测（不是推测 —— 已把 backend/ 整树复制到 /tmp 并用 git HEAD 版
 * routes/orders.js 跑过本套件，工作区文件未改动）：
 *   修复前：PASS 21 / FAIL 13      修复后：PASS 34 / FAIL 0
 *   13 条 FAIL 全部落在 T1/T2/T3/T4 的建卡计数与 T6 的原子性上（例如 T1 issued=2、
 *   T3 issued=4、T4 active=1、T6 cards=1 且 logs=1）。
 *
 * 判别力边界（据实标注，避免把「护栏」伪装成「判别项」）：
 *   · T5（购买积分去重）**不是**本次修复的判别项 —— 修复前 HEAD 版
 *     grantOrderBenefits 里就已经有 `reference_id` 去重查询，故 T5 的断言在修复
 *     前后结果相同（实测两边都 PASS）。它保留为**回归护栏**：防止计数补齐改造
 *     顺手把已有的积分去重逻辑弄丢。任务清单要求覆盖该场景，故保留并如实标注。
 *   · T6 的首条断言「异常向外抛出」同样是前置条件而非判别项（修复前没有事务包裹，
 *     异常本就会向外抛）。T6 真正的判别项是后 3 条：失败后 cards/logs/balance
 *     必须全为 0（修复前会留下 cards=1、logs=1、balance=30 的半截脏数据）。
 *   · T0 两条是前置条件：确认「重复调用入口存在」且「member_cards 无 order_id
 *     唯一约束」—— 若哪天有人给 order_id 加了 UNIQUE，重复调用会变成抛异常而非
 *     多发卡，本套件的判别前提即失效，故显式钉死。
 *
 * 判别性说明（每条核心断言都先证明「修复前会给出不同结果」）：
 *   本套件对「首次发放」走真实路由（POST /api/orders，status=paid → settleOrder），
 *   对「重复调用」直调 orders.js 导出的 grantOrderBenefits（即 wxpay 回调那条路径），
 *   这正是线上重复发卡的成因。member_cards 表上**没有** order_id 唯一索引
 *   （只有 student_id / status 普通索引），因此修复前重复调用确实会插出重复行，
 *   断言会真实失败，而不是被约束挡住变成「恰好相同」。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db）：
 *   node tests/order-benefits-idempotency-regression.cjs
 *   KEEP_TEST_DB=1 node tests/order-benefits-idempotency-regression.cjs   （保留临时库排查）
 *
 * 写法说明：建库/清理沿用 _bootstrap.cjs（seed 夹具 + 退出时删除临时库），
 * 直调路由处理器沿用 deduction-count-regression.cjs 的 getHandler/mockRes/mockReq
 * （不启 HTTP 服务，避免与线上占用的 3001 端口及并发套件冲突）。
 */
'use strict';

// ---- 隔离库（必须在 require('../db') 之前设置）----
const { bootstrap } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-order-benefits-idempotency');

const db = require('../db');
const { now } = require('../utils');
const ordersRouter = require('../routes/orders');

// 防呆：临时库必须落在 /tmp，绝不能是真实库 backend/db/data.db
if (!String(process.env.DB_PATH || '').startsWith('/tmp/')) {
  console.error('[致命] DB_PATH 不在 /tmp，拒绝运行以免污染真实库:', process.env.DB_PATH);
  process.exit(2);
}

// ---------- 直调路由处理器（与 deduction-count-regression.cjs 同款）----------
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
  ins('INSERT OR IGNORE INTO students (id, name) VALUES (?, ?)', id, name);
}
/** 会员卡「产品」（membership_cards 表；该表无 product_type 列，默认按 'membership' 处理） */
function mkCardType(id, name, o) {
  const { total = 10, days = 90, mode = 'count', reward = 0, price = 1000 } = o || {};
  ins(`INSERT OR IGNORE INTO membership_cards (id, name, total_classes, valid_days, billing_mode,
         points_reward, price, course_scope, transferable, refundable, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '全活动通用', 0, 1, 1, ?)`,
    id, name, total, days, mode, reward, price, t);
}

const CT_A = 'ct_idem_a';   // 次卡，赠送 30 积分（积分幂等用例的观测点）
const CT_B = 'ct_idem_b';   // 次卡，不送积分（多卡种用例）
const CT_FAIL = 'ct_idem_fail'; // 仅用于 T6：建卡时被触发器强制失败

/** 会员卡订单明细（itemType=membershipCard 才会被 grantOrderBenefits 视为发卡项） */
const cardItem = (typeId, name, price) => ({
  itemType: 'membershipCard', itemId: typeId, itemName: name, quantity: 1, unitPrice: price, totalPrice: price,
});

// ---------- 观测查询 ----------
/** 本单某卡种的建卡张数（**不按 status 过滤**，与业务侧 issued 口径一致） */
const issuedOf = (orderId, typeId) => db.prepare(
  'SELECT COUNT(*) AS c FROM member_cards WHERE order_id = ? AND card_type_id = ?'
).get(orderId, typeId).c;
/** 本单全部建卡张数 */
const cardsOfOrder = (orderId) => db.prepare(
  'SELECT COUNT(*) AS c FROM member_cards WHERE order_id = ?'
).get(orderId).c;
/** 本单某状态的建卡张数 */
const cardsOfOrderByStatus = (orderId, status) => db.prepare(
  'SELECT COUNT(*) AS c FROM member_cards WHERE order_id = ? AND status = ?'
).get(orderId, status).c;
/** 本单发出的课时资产总额 —— 「课时翻倍」的直接观测值 */
const classesOfOrder = (orderId) => db.prepare(
  'SELECT COALESCE(SUM(remaining_classes), 0) AS s FROM member_cards WHERE order_id = ?'
).get(orderId).s;
/** 本单购买赠送积分的流水条数 */
const pointLogsOfOrder = (orderId) => db.prepare(
  "SELECT COUNT(*) AS c FROM point_logs WHERE reference_id LIKE ?"
).get('order_' + orderId + '_%').c;
const pointBalance = (studentId) => {
  const row = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId);
  return row ? row.balance : 0;
};

// ---------- 路由调用封装 ----------
const asAdmin = (extra) => mockReq(Object.assign({ userRole: 'admin', openid: 'admin_idem' }, extra));

/**
 * POST /api/orders —— 建单。status='paid' 时路由内部走 settleOrder → 首次发放权益。
 * 返回 { orderId, res }。
 */
function createOrder(body) {
  const res = mockRes();
  getHandler(ordersRouter, 'post', '/')(asAdmin({
    body: Object.assign({ orderType: 'membership', status: 'paid', discountAmount: 0 }, body),
  }), res);
  const orderId = res.body && res.body.data && res.body.data.orderId;
  return { orderId, res };
}

/**
 * 重复发放：直调 grantOrderBenefits —— 这正是 wxpay 支付回调（wxpay.js:121）
 * 与 membership /activate 撞上同一张已付订单时走的路径，是「重复发卡」的成因。
 */
function grantAgain(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  ordersRouter.grantOrderBenefits(order, now());
}

console.log('\n\x1b[1m=== 订单发卡幂等回归测试（grantOrderBenefits 计数补齐）===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '（seed 夹具）\n');

// 夹具：3 个独立学员（互不共享积分账户）+ 3 个卡种产品
mkStudent('stu_idem1', '幂等T1学员');
mkStudent('stu_idem2', '幂等T2学员');
mkStudent('stu_idem3', '幂等T3学员');
mkStudent('stu_idem4', '幂等T4学员');
mkStudent('stu_idem5', '幂等T5学员');
mkStudent('stu_idem6', '幂等T6学员');
mkCardType(CT_A, '幂等次卡A', { total: 10, days: 90, mode: 'count', reward: 30, price: 1000 });
mkCardType(CT_B, '幂等次卡B', { total: 20, days: 180, mode: 'count', reward: 0, price: 2000 });
mkCardType(CT_FAIL, '幂等必败卡', { total: 5, days: 30, mode: 'count', reward: 0, price: 100 });

// ============================================================
// T0. 前置：待测函数必须可从路由导出（否则下面的「重复调用」根本调不到）
// ============================================================
console.log('\x1b[1m[T0] 前置条件\x1b[0m');
rec('orders 路由导出 grantOrderBenefits（重复调用路径的入口，wxpay 回调即用它）',
  typeof ordersRouter.grantOrderBenefits === 'function',
  `typeof=${typeof ordersRouter.grantOrderBenefits}`);
rec('member_cards 上不存在 order_id 唯一约束（一单合法对应多卡，故修复前重复调用会真的插出重复行）',
  !db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'member_cards' AND sql LIKE '%UNIQUE%order_id%'").get(),
  '存在 order_id 唯一索引 —— 本套件的判别性前提不成立');

// ============================================================
// T1. 一单一卡：首次 1 张；重复调用仍 1 张（修复前 2 张，课时资产翻倍）
// ============================================================
console.log('\n\x1b[1m[T1] 一单一卡 → 重复调用不得重复发卡\x1b[0m');
{
  const { orderId, res } = createOrder({ studentId: 'stu_idem1', cardTypeId: CT_A });
  rec('T1 建单即 paid 成功（settleOrder 已发首次权益）',
    !!orderId && res.body.code === 0, JSON.stringify(res.body));

  rec('T1 首次发卡 1 张',
    issuedOf(orderId, CT_A) === 1, `issued=${issuedOf(orderId, CT_A)}`);
  rec('T1 首次课时资产 10',
    classesOfOrder(orderId) === 10, `classes=${classesOfOrder(orderId)}`);

  grantAgain(orderId);

  // 判别力：修复前 issued = 2（无条件 INSERT），本条失败；修复后仍为 1。
  rec('T1 重复调用后仍为 1 张（修复前 2 张）',
    issuedOf(orderId, CT_A) === 1, `issued=${issuedOf(orderId, CT_A)}`);
  rec('T1 重复调用后课时资产仍 10（修复前翻倍为 20）',
    classesOfOrder(orderId) === 10, `classes=${classesOfOrder(orderId)}`);
  rec('T1 重复调用不产生第二张 active 卡',
    cardsOfOrderByStatus(orderId, 'active') === 1, `active=${cardsOfOrderByStatus(orderId, 'active')}`);
}

// ============================================================
// T2. 一单两张不同卡：首次 2 张；重复调用仍 2 张（修复前 4 张）
// ============================================================
console.log('\n\x1b[1m[T2] 一单两张不同卡 → 重复调用不得各再发一张\x1b[0m');
{
  const { orderId, res } = createOrder({
    studentId: 'stu_idem2',
    items: [cardItem(CT_A, '幂等次卡A', 1000), cardItem(CT_B, '幂等次卡B', 2000)],
  });
  rec('T2 双卡种订单建单即 paid 成功',
    !!orderId && res.body.code === 0, JSON.stringify(res.body));

  rec('T2 首次各发 1 张（合计 2 张）',
    issuedOf(orderId, CT_A) === 1 && issuedOf(orderId, CT_B) === 1,
    `A=${issuedOf(orderId, CT_A)} B=${issuedOf(orderId, CT_B)}`);

  grantAgain(orderId);

  // 判别力：修复前 A=2 且 B=2（合计 4 张）。
  rec('T2 重复调用后 A 仍 1 张（修复前 2 张）',
    issuedOf(orderId, CT_A) === 1, `A=${issuedOf(orderId, CT_A)}`);
  rec('T2 重复调用后 B 仍 1 张（修复前 2 张）',
    issuedOf(orderId, CT_B) === 1, `B=${issuedOf(orderId, CT_B)}`);
  rec('T2 重复调用后本单合计仍 2 张（修复前 4 张）',
    cardsOfOrder(orderId) === 2, `total=${cardsOfOrder(orderId)}`);
}

// ============================================================
// T3. 一单同一卡种两条明细：首次 2 张；重复调用仍 2 张
//     —— 计数补齐法的关键判别点：不能退化成「每卡种只发一张」
// ============================================================
console.log('\n\x1b[1m[T3] 一单同卡种两条明细 → 首发放 2 张，且重复调用后仍 2 张\x1b[0m');
{
  const { orderId, res } = createOrder({
    studentId: 'stu_idem3',
    items: [cardItem(CT_A, '幂等次卡A', 1000), cardItem(CT_A, '幂等次卡A', 1000)],
  });
  rec('T3 同卡种双明细订单建单即 paid 成功',
    !!orderId && res.body.code === 0, JSON.stringify(res.body));

  // 判别力（方向一）：若实现退化成「每卡种最多发一张」（例如用 SELECT DISTINCT
  // 或对卡种去重），首次只会发 1 张 —— 本条即失败。wanted 必须按**明细条数**累计。
  rec('T3 首次发 2 张（同一卡种两条明细必须各发一张，不能退化成每卡种一张）',
    issuedOf(orderId, CT_A) === 2, `issued=${issuedOf(orderId, CT_A)}`);
  rec('T3 首次课时资产 20（2 × 10 节）',
    classesOfOrder(orderId) === 20, `classes=${classesOfOrder(orderId)}`);

  grantAgain(orderId);

  // 判别力（方向二）：修复前会变成 4 张。
  rec('T3 重复调用后仍 2 张（修复前 4 张；退化成每卡种一张则是 1 张）',
    issuedOf(orderId, CT_A) === 2, `issued=${issuedOf(orderId, CT_A)}`);
  rec('T3 重复调用后课时资产仍 20（未翻倍为 40）',
    classesOfOrder(orderId) === 20, `classes=${classesOfOrder(orderId)}`);
}

// ============================================================
// T4. 已退卡（status=refunded）后重复调用：不得自动补发
//     —— issued 统计必须**不按 status 过滤**，否则退卡会被误判成「还没发过」
// ============================================================
console.log('\n\x1b[1m[T4] 已退卡后重复调用 → 不自动补发（issued 不按 status 过滤）\x1b[0m');
{
  const { orderId, res } = createOrder({ studentId: 'stu_idem4', cardTypeId: CT_A });
  rec('T4 建单即 paid 成功', !!orderId && res.body.code === 0, JSON.stringify(res.body));
  rec('T4 首次发卡 1 张且为 active',
    issuedOf(orderId, CT_A) === 1 && cardsOfOrderByStatus(orderId, 'active') === 1,
    `issued=${issuedOf(orderId, CT_A)} active=${cardsOfOrderByStatus(orderId, 'active')}`);

  // 模拟退卡：卡仍是「已发过」的事实，但不再有效
  db.prepare("UPDATE member_cards SET status = 'refunded' WHERE order_id = ? AND card_type_id = ?")
    .run(orderId, CT_A);
  rec('T4 夹具：该卡已置为 refunded（本单 active 归零）',
    cardsOfOrderByStatus(orderId, 'active') === 0 && issuedOf(orderId, CT_A) === 1,
    `active=${cardsOfOrderByStatus(orderId, 'active')} issued=${issuedOf(orderId, CT_A)}`);

  grantAgain(orderId);

  // 判别力：修复前会补出第 2 张（active 变 1）；若 issued 按 status='active' 过滤
  // 也会补出第 2 张（active 变 1）。两种错误实现都会被这两条断言捕获。
  rec('T4 重复调用后仍只有 1 张卡（未自动补发；修复前/按 status 过滤的实现都会变 2 张）',
    issuedOf(orderId, CT_A) === 1, `issued=${issuedOf(orderId, CT_A)}`);
  rec('T4 重复调用后 active 卡数为 0（退卡不会被幂等逻辑悄悄「复活」）',
    cardsOfOrderByStatus(orderId, 'active') === 0, `active=${cardsOfOrderByStatus(orderId, 'active')}`);
}

// ============================================================
// T5. 购买积分不重复发放：重复调用后流水仍 1 条、余额不变
//     【判别力边界】本段是**回归护栏**，不是本次修复的判别项 ——
//     实测修复前 HEAD 版 grantOrderBenefits 已有 `reference_id` 去重查询，
//     本段 5 条断言在修复前后**结果相同**（两边都 PASS）。
//     保留原因：任务清单要求覆盖该场景；且计数补齐改造把发积分逻辑整体挪进了
//     事务，需要一条断言钉住「改造没有顺手弄丢已有的积分去重」。
//     修复前确实会重复入账的情形只存在于「更早的、尚无 reference_id 去重的版本」，
//     那个版本已不可考，故不在此虚构判别性。
// ============================================================
console.log('\n\x1b[1m[T5] 购买赠送积分 → 重复调用不得重复入账（护栏：修复前后同结果）\x1b[0m');
{
  const { orderId, res } = createOrder({ studentId: 'stu_idem5', cardTypeId: CT_A });
  rec('T5 建单即 paid 成功', !!orderId && res.body.code === 0, JSON.stringify(res.body));

  rec('T5 首次发放积分流水 1 条（CT_A 赠送 30 分）',
    pointLogsOfOrder(orderId) === 1, `logs=${pointLogsOfOrder(orderId)}`);
  rec('T5 首次积分余额 30',
    pointBalance('stu_idem5') === 30, `balance=${pointBalance('stu_idem5')}`);

  grantAgain(orderId);

  rec('T5 重复调用后积分流水仍 1 条（护栏：改动前亦为 1 条）',
    pointLogsOfOrder(orderId) === 1, `logs=${pointLogsOfOrder(orderId)}`);
  rec('T5 重复调用后积分余额仍 30（护栏：改动前亦为 30）',
    pointBalance('stu_idem5') === 30, `balance=${pointBalance('stu_idem5')}`);
}

// ============================================================
// T6. 事务原子性：建卡中途失败 → 卡与积分都不落库
//     用临时触发器让「第二个卡种」的建卡必然失败，检验第一次循环写下的
//     卡与积分是否随事务一起回滚（修复前没有事务 → 会留下半截脏数据）。
// ============================================================
console.log('\n\x1b[1m[T6] 建卡中途失败 → 卡与积分整体回滚（db.transaction 原子性）\x1b[0m');
{
  // 建单但不结算（status=pending），以便下面手工触发一次发放
  const { orderId, res } = createOrder({
    studentId: 'stu_idem6',
    status: 'pending',
    items: [cardItem(CT_A, '幂等次卡A', 1000), cardItem(CT_FAIL, '幂等必败卡', 100)],
  });
  rec('T6 待结算订单建单成功（status=pending，尚未发卡）',
    !!orderId && res.body.code === 0 && cardsOfOrder(orderId) === 0, JSON.stringify(res.body));

  db.exec(`CREATE TRIGGER trg_idem_fail BEFORE INSERT ON member_cards
             WHEN NEW.card_type_id = '${CT_FAIL}'
             BEGIN SELECT RAISE(ABORT, '模拟建卡失败'); END`);
  let threw = null;
  try {
    grantAgain(orderId);
  } catch (e) {
    threw = e;
  }
  db.exec('DROP TRIGGER IF EXISTS trg_idem_fail');

  // 【前置条件，非判别项】修复前没有事务包裹，异常本就会向外抛，故本条两边同结果。
  // 保留为前置条件：下面 3 条「必须为 0」的断言只有在异常真的抛出、事务真的回滚时
  // 才有意义；若哪天有人给 grantOrderBenefits 加了 try/catch 把失败吞掉，
  // 本条会先失败，避免「回滚了但没人知道」被误读成「回滚正确」。
  rec('T6 [前置] 建卡失败时异常向外抛出（未把失败吞成「已发完」）',
    !!threw, 'grantOrderBenefits 未抛出 —— 失败被静默吞掉，调用方会误以为发放成功');

  // 判别力：修复前没有事务包裹，第一张卡（CT_A）与它的积分会留在库里，
  // 这里将得到 cards=1 / logs=1 —— 一条订单「发了一半」，比重复发卡更难排查。
  rec('T6 失败后本单建卡 0 张（第一张也随事务回滚，不留半截）',
    cardsOfOrder(orderId) === 0, `cards=${cardsOfOrder(orderId)}`);
  rec('T6 失败后本单积分流水 0 条（与建卡同处一个事务）',
    pointLogsOfOrder(orderId) === 0, `logs=${pointLogsOfOrder(orderId)}`);
  rec('T6 失败后学员积分余额未增加（积分账户一并回滚）',
    pointBalance('stu_idem6') === 0, `balance=${pointBalance('stu_idem6')}`);

  // 反向自证：去掉触发器后同样的订单能正常发放，说明 T6 的失败确实由触发器造成，
  // 而不是这个夹具本身有问题（否则上面几条断言可能是「恒真」的假绿）。
  const ok = createOrder({ studentId: 'stu_idem6', cardTypeId: CT_B });
  rec('T6 反向自证：无触发器时同一学员可正常发卡 1 张（证明上面的 0 张确因建卡失败回滚）',
    issuedOf(ok.orderId, CT_B) === 1, `issued=${issuedOf(ok.orderId, CT_B)}`);
}

// ============================================================
// 收尾：临时库由 _bootstrap.cjs 在进程退出时整目录删除
// ============================================================
console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
