/**
 * 财务口径 + 退卡金额回归校验（离线，隔离库）
 * 覆盖 2026-09-14 复审修复的三个资金正确性问题：
 *   1. summary 双扣：全额退款订单（status 翻转为 refunded）收入不入 gross、
 *      refunded_amount 又照减 → 净收入凭空多扣一次
 *   2. RFND 退款流水行（order_type='refund'）混入收入聚合
 *   3. membership/refund：按标价（不折减整单折扣）退款超退；
 *      且未受「订单剩余额退额度」硬上限约束
 *
 * 运行：node tests/finance-refund-regression.cjs
 */
process.env.DB_PATH = '/tmp/finance_refund_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/finance_refund_test.db', '/tmp/finance_refund_test.db-wal', '/tmp/finance_refund_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
const financeRouter = require('../routes/finance');
const membershipRouter = require('../routes/membership');

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

const t = now();
const d = new Date(t);
const pad = (n) => String(n).padStart(2, '0');
const dayStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
const startDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
const endDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(lastDay)}`;

// ---------- 种子数据 ----------
const seed = db.transaction(() => {
  const ins = (sql, ...params) => db.prepare(sql).run(...params);
  ins("INSERT OR IGNORE INTO users (id, openid, role, password, nickname) VALUES (?,?,?,?,?)",
    'u_admin', 'admin_openid', 'admin', 'x', 'Admin');
  ins("INSERT OR IGNORE INTO students (id, name) VALUES (?,?)", 'stu_r1', '退款学员');

  // 本月支付、随后被全额退款（status 已翻转）——旧口径下 gross 漏它、refunded 又扣它
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_full_refund', 'OF001', 'stu_r1', 'membership', 1000, 0, 1000, 1000, 'refunded', t, t, t);
  // 本月正常收入
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_paid', 'OP001', 'stu_r1', 'membership', 500, 0, 0, 500, 'paid', t, t, t);
  // RFND 退款流水行（正常 paid_at 为 NULL）
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, payable_amount, total_amount, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    'ord_rfnd_null', 'RF001', 'stu_r1', 'refund', 1000, 1000, 'refunded', t, t);
  // 脏数据：手工/历史 RFND 行带 paid_at 且落在本月 —— 必须被 order_type != 'refund' 谓词挡在收入外；
  // 另一行 created_at 也在过去月，双保险验证时间窗与类型谓词都生效
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, payable_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    'ord_rfnd_dirty', 'RF002', 'stu_r1', 'refund', 777, 777, 'refunded', t, t - 400 * 86400000, t - 400 * 86400000);
  // 负向对照：未支付订单（status='pending'）绝不应计入收入。
  // paid_at 刻意设为本月 —— 若实现只按时间窗过滤而漏掉 status 谓词，本行会立刻混入
  // summary.gross 与 by-product（多出一个「未付产品」行），下面两条断言随即变红。
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, items, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_pending', 'OPEND1', 'stu_r1', 'membership',
    JSON.stringify([{ itemType: 'membershipCard', itemId: 'ct_addon', itemName: '未付产品', quantity: 1, unitPrice: 9999, totalPrice: 9999 }]),
    9999, 0, 0, 9999, 'pending', t, t, t);
  ins(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, price, created_at)
       VALUES ('ct_disc', '折扣季卡', 0, 200, 'time', 600, ?)`, t);
  ins(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, price, created_at)
       VALUES ('ct_addon', '搭售小课包', 0, 100, 'time', 400, ?)`, t);
  // 多明细订单带折扣：原价 1000、实付 800（本卡标价 600，折后 480）
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, items, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_disc', 'OD001', 'stu_r1', 'membership',
    JSON.stringify([
      { itemType: 'membershipCard', itemId: 'ct_disc', itemName: '折扣季卡', quantity: 1, unitPrice: 600, totalPrice: 600 },
      { itemType: 'membershipCard', itemId: 'ct_addon', itemName: '搭售小课包', quantity: 1, unitPrice: 400, totalPrice: 400 },
    ]),
    800, 200, 0, 1000, 'paid', t, t, t);
  // 卡：已用一半有效期 → 修复前按标价退 round(600*0.5)=300，修复后按折后价退 round(480*0.5)=240
  ins(`INSERT OR IGNORE INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'mc_disc', 'ct_disc', '折扣季卡', 'time', 'stu_r1', '退款学员', 0, 0, 0,
    t - 100 * 86400000, t + 100 * 86400000, 'active', 'ord_disc', t, t);
  // 上限场景：订单已退 90/100，新卡按时间比例计算额 300 → 必须截到剩余额度 10
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, items, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_room', 'OR001', 'stu_r1', 'membership',
    JSON.stringify([{ itemType: 'membershipCard', itemId: 'ct_disc', itemName: '折扣季卡', quantity: 1, unitPrice: 600, totalPrice: 600 }]),
    100, 0, 90, 100, 'paid', t, t, t);
  ins(`INSERT OR IGNORE INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'mc_room', 'ct_disc', '折扣季卡', 'time', 'stu_r1', '退款学员', 0, 0, 0,
    t - 100 * 86400000, t + 100 * 86400000, 'active', 'ord_room', t, t);
});
seed();

// ---------- 断言 ----------
let failures = 0;
const results = [];
function expect(condition, label, detail) {
  results.push(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`);
  if (!condition) failures++;
}

// A. summary：双扣修复
{
  const h = getHandler(financeRouter, 'get', '/summary');
  const res = mockRes();
  h(mockReq({ userRole: 'admin', query: { startDate, endDate } }), res);
  const body = res.body && res.body.data;
  expect(!!body, 'summary 返回数据', res.body && res.body.message);
  if (body) {
    // gross = 1000(全额退单) + 500(在付) + 800(折扣单) + 100(额度单)；两条 RFND 不入收入
    expect(body.revenue.gross === 2400, 'gross=2400（全额退款单收入回归，RFND 行不入收入）', `got ${body.revenue.gross}`);
    // 负向对照（判别性）：库中存在一张 paid_at 落在本月、金额 ¥9999 的 pending 订单。
    // 收入聚合一旦漏掉 status 谓词，gross 会立刻变成 12399 —— 这条断言随即变红。
    expect(body.revenue.gross === 2400 && body.revenue.gross !== 12399,
      '未支付订单（pending ¥9999）不计入 gross', `got ${body.revenue.gross}（若含未付款应为 12399）`);
    // refunded = 1000(全额) + 90(额度单历史部分退)
    expect(body.revenue.refunded === 1090, 'refunded=1090', `got ${body.revenue.refunded}`);
    expect(body.revenue.net === 1310, 'net=1310（不再双扣为负）', `got ${body.revenue.net}`);
    // 口径不变量：net 必须恒等于 gross - refunded（防止某个分支单独改了 net 而不改 gross）
    expect(body.revenue.net === body.revenue.gross - body.revenue.refunded,
      'net 恒等于 gross - refunded（口径自洽）', `${body.revenue.net} vs ${body.revenue.gross - body.revenue.refunded}`);
    expect(body.orders.paid === 3 && body.orders.refunded === 2, '订单数：在付 3 / 有退 2', JSON.stringify(body.orders));
    const member = (body.byType || []).find((x) => x.type === 'membership');
    expect(!!member && member.revenue === 2400, 'byType 不含 RFND 流水', member && String(member.revenue));
  }
}

// B. monthly：与 summary 同口径（收入含 refunded 行且同月冲减）
{
  const h = getHandler(financeRouter, 'get', '/monthly');
  const res = mockRes();
  h(mockReq({ userRole: 'admin', query: { year: String(d.getFullYear()) } }), res);
  const body = res.body && res.body.data;
  expect(!!body, 'monthly 返回数据');
  if (body) {
    const mm = pad(d.getMonth() + 1);
    const row = body.months.find((x) => x.month === mm);
    expect(!!row, `monthly 命中 ${mm} 月`);
    if (row) {
      // 与 summary 同口径：2400 收入 / 1090 退款 / 在付 3 单
      expect(row.revenue === 2400, 'monthly revenue 同口径', `got ${row.revenue}`);
      expect(row.refunded === 1090, 'monthly refunded 同月冲减', `got ${row.refunded}`);
      expect(row.netRevenue === 1310, 'monthly net=1310', `got ${row.netRevenue}`);
      expect(row.orderCount === 3, 'monthly orderCount 只计在付', `got ${row.orderCount}`);
    }
    const totalNet = body.totals.revenue - body.totals.refunded;
    expect(totalNet === body.totals.netRevenue, 'totals 自洽');
  }
}

// C. by-product / by-sales：order_type 守卫（脏 RFND 行 777 不得混入）
{
  const hp = getHandler(financeRouter, 'get', '/by-product');
  const res = mockRes();
  hp(mockReq({ userRole: 'admin', query: { startDate, endDate } }), res);
  const list = (res.body && res.body.data.list) || [];
  const sum = list.reduce((s, x) => s + x.revenue, 0);
  // 仅两张多/单明细卡订单可解析 items：800 + 100
  expect(sum === 900, 'by-product 收入合计不含 RFND 脏行', `got ${sum}`);

  // 逐产品具体值（判别性）：按「单项标价 / 订单标价合计」比例分摊实付额。
  //   ord_disc：实付 800，标价合计 1000 → 折扣季卡 800×600/1000=480、搭售小课包 800×400/1000=320
  //   ord_room：实付 100，标价合计 600 → 折扣季卡 100×600/600=100，且该单已退 90 全额落到折扣季卡
  // 于是：折扣季卡 revenue=580 / refunded=90 / net=490 / count=2；搭售小课包 320 / 0 / 320 / 1
  expect(list.length === 2, 'by-product 恰好 2 个产品行（未支付订单不产生产品行）', `got ${list.length}`);
  const disc = list.find((x) => x.name === '折扣季卡');
  const addon = list.find((x) => x.name === '搭售小课包');
  expect(!!disc && disc.revenue === 580 && disc.refunded === 90 && disc.net === 490 && disc.count === 2,
    '折扣季卡 revenue=580 / refunded=90 / net=490 / count=2', JSON.stringify(disc));
  expect(!!addon && addon.revenue === 320 && addon.refunded === 0 && addon.net === 320 && addon.count === 1,
    '搭售小课包 revenue=320 / refunded=0 / net=320 / count=1', JSON.stringify(addon));
  // 负向对照：未支付订单的 items 里有一个标价 ¥9999 的「未付产品」，绝不应出现在报表中
  expect(!list.some((x) => x.name === '未付产品'),
    '未支付订单的产品不出现在 by-product', `names=${JSON.stringify(list.map((x) => x.name))}`);
  // 行级不变量：每一行都必须满足 net = revenue - refunded
  expect(list.every((x) => x.net === x.revenue - x.refunded),
    'by-product 每行满足 net = revenue - refunded', JSON.stringify(list.map((x) => ({ n: x.name, net: x.net, r: x.revenue, f: x.refunded }))));

  const hs = getHandler(financeRouter, 'get', '/by-sales');
  const res2 = mockRes();
  hs(mockReq({ userRole: 'admin', query: { startDate, endDate } }), res2);
  const slist = (res2.body && res2.body.data.list) || [];
  const ssum = slist.reduce((s, x) => s + x.revenue, 0);
  expect(ssum === 2400, 'by-sales 收入合计不含 RFND 脏行', `got ${ssum}`);
}

// D. 退卡：折扣折减 + 剩余额度上限
{
  const h = getHandler(membershipRouter, 'post', '/refund');
  const r1 = mockRes();
  h(mockReq({ userRole: 'admin', body: { cardId: 'mc_disc', studentId: 'stu_r1', reason: '回归测试-折扣折减' } }), r1);
  const d1 = r1.body && r1.body.data;
  expect(!!d1, '退卡(折扣单)成功', r1.body && r1.body.message);
  // 折后 480 × 剩余 50% = 240（修复前 300）
  expect(d1 && d1.refundAmount === 240, '退款按折后价计算 240', d1 && String(d1.refundAmount));

  const r2 = mockRes();
  h(mockReq({ userRole: 'admin', body: { cardId: 'mc_room', studentId: 'stu_r1', reason: '回归测试-额度上限' } }), r2);
  const d2 = r2.body && r2.body.data;
  expect(!!d2, '退卡(上限单)成功', r2.body && r2.body.message);
  // 计算额 300（600×剩余50%）→ 截到剩余额度 100-90=10
  expect(d2 && d2.refundAmount === 10, '退款不超过订单剩余额退度 10', d2 && String(d2.refundAmount));
  const ord = db.prepare("SELECT refunded_amount, status FROM orders WHERE id = 'ord_room'").get();
  expect(ord.refunded_amount === 100 && ord.status === 'refunded', '主单累计封顶并翻转状态', `${ord.refunded_amount}/${ord.status}`);
  const rfnd = db.prepare("SELECT payable_amount FROM orders WHERE order_type = 'refund' AND student_id = 'stu_r1' AND id != 'ord_rfnd_null' AND id != 'ord_rfnd_dirty'").all();
  expect(rfnd.length === 2 && rfnd.every((x) => x.payable_amount <= 240), 'RFND 流水金额均受限', JSON.stringify(rfnd));
}

// E. 退卡（F6）：双重编码明细必须按真实成交价退，不得回退卡类型标价
// 判别性：订单明细里第 1 条是**双重编码**（数组元素本身是 JSON 字符串），
// 旧实现 items.find(i => i.itemId === card.card_type_id) 因元素是字符串必然落空
// → 回退 cardType.price（600，且不打折）→ 600×5/10 = 300，多退 60。
// 注：上方 seed 事务里的 ins 是闭包局部变量，此处需要模块级同名工具
const ins = (sql, ...a) => db.prepare(sql).run(...a);
{
  ins(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, price, created_at)
       VALUES ('ct_f6', 'F6季卡', 10, 200, 'count', 600, ?)`, t);
  // 多明细：本卡标价行小计 600 + 搭售件 400 = 1000 标价，整单实付 800（8 折）
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, items, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_f6', 'OF6001', 'stu_r1', 'membership',
    JSON.stringify([
      JSON.stringify({ itemType: 'membershipCard', itemId: 'ct_f6', itemName: 'F6季卡', quantity: 1, unitPrice: 600, totalPrice: 600 }),
      { itemType: 'product', itemName: 'F6搭售件', quantity: 1, unitPrice: 400, totalPrice: 400 },
    ]),
    800, 200, 0, 1000, 'paid', t, t, t);
  ins(`INSERT OR IGNORE INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'mc_f6', 'ct_f6', 'F6季卡', 'count', 'stu_r1', '退款学员', 10, 5, 5,
    t - 10 * 86400000, t + 100 * 86400000, 'active', 'ord_f6', t, t);

  // 自证：旧口径的读取方式（直接 JSON.parse 后按 itemId 找）确实找不到本卡明细
  const rawItems = JSON.parse(db.prepare("SELECT items FROM orders WHERE id = 'ord_f6'").get().items);
  const oldFound = rawItems.find((i) => i.itemId === 'ct_f6');
  expect(oldFound === undefined, '自证：旧口径 items.find 对双重编码元素取不到 itemId（回退标价）', JSON.stringify(oldFound));

  const h = getHandler(membershipRouter, 'post', '/refund');
  const r = mockRes();
  h(mockReq({ userRole: 'admin', body: { cardId: 'mc_f6', studentId: 'stu_r1', reason: '回归-双重编码退卡' } }), r);
  const d = r.body && r.body.data;
  expect(!!d, 'F6 双重编码多明细单退卡成功', r.body && r.body.message);
  // 正确：600 × 800/1000 = 480（折后本卡成交价）→ 剩余 5/10 → 退 240
  expect(d && d.refundAmount === 240,
    'F6 双重编码多明细单按折后实付退 240（旧实现回退卡类型标价退 300）', d && String(d.refundAmount));
}

// F. 财务报表 by-product（F7）：双重编码明细按真实价格结构分摊，不得退化成均分
// 判别性：旧实现用 it.type='object' 判定，双重编码元素被判否 → unit_price=0 → gross=0
// → 整单落进「按项数均分」分支，两条明细各分 400 且都记在「未命名」下。
{
  const uniq = Math.random().toString(36).slice(2, 6);
  const bigName = `F7高价卡_${uniq}`;
  const smallName = `F7搭售件_${uniq}`;
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, items, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_f7', 'OF7001', 'stu_r1', 'membership',
    JSON.stringify([
      JSON.stringify({ itemType: 'membershipCard', itemId: 'ct_f7', itemName: bigName, quantity: 1, unitPrice: 600, totalPrice: 600 }),
      JSON.stringify({ itemType: 'product', itemId: 'p_f7', itemName: smallName, quantity: 1, unitPrice: 400, totalPrice: 400 }),
    ]),
    800, 200, 0, 1000, 'paid', t, t, t);
  // 非法元素（裸字符串）不得让接口 500
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, items, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_f7b', 'OF7002', 'stu_r1', 'membership', JSON.stringify(['篮球季卡']),
    300, 0, 0, 300, 'paid', t, t, t);

  const hp = getHandler(financeRouter, 'get', '/by-product');
  const res = mockRes();
  hp(mockReq({ userRole: 'admin', query: { startDate, endDate } }), res);
  expect(res.statusCode === 200, 'F7 items 含裸字符串元素时 /by-product 仍返回 200', `status=${res.statusCode}`);
  const list = (res.body && res.body.data && res.body.data.list) || [];
  const big = list.find((x) => x.name === bigName);
  const small = list.find((x) => x.name === smallName);
  // 正确：800 × 600/1000 = 480、800 × 400/1000 = 320
  expect(!!big && big.revenue === 480, 'F7 双重编码高价卡按真实价格分摊 480（旧实现均分 400）', JSON.stringify(big));
  expect(!!small && small.revenue === 320, 'F7 双重编码搭售件按真实价格分摊 320（旧实现均分 400）', JSON.stringify(small));
  expect((big ? big.revenue : 0) + (small ? small.revenue : 0) === 800,
    'F7 两行分摊合计恒等于整单实付 800', `sum=${(big ? big.revenue : 0) + (small ? small.revenue : 0)}`);
  // 「未命名」桶里只应剩裸字符串元素订单的 300（该单 gross=0 → 按项数均分给唯一一项）。
  // 双重编码订单的 800 必须全部落到两个真实项目名下 —— 旧实现会把整单 800 归入「未命名」。
  const unnamed = list.find((x) => x.name === '未命名');
  expect(!!unnamed && unnamed.revenue === 300,
    'F7 双重编码订单不再落入「未命名」（该桶只剩裸字符串订单的 300，旧实现为 800+300）',
    JSON.stringify(unnamed));
}

// ---------- 输出 ----------
console.log(results.join('\n'));
if (failures) {
  console.log(`\n${failures} FAILED / ${results.length} total`);
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} passed ✅`);
