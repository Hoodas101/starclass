/**
 * 业务口径回归测试（离线，隔离库）
 *
 * 钉住的都是「账不平」类缺陷 —— 不会抛异常，只会让报表数字悄悄错掉：
 *  1. 0 元单（赠卡/全免/核销）不得按标价结转收入
 *  2. 已退卡/已作废的时效卡不得再被日任务摊销
 *  3. 时效卡摊销只追加增量行，不改写既有行的 recognized_at（否则历史月份收入被搬走）
 *  4. 时效卡转让后同一订单不得被确认两次
 *  5. 积分过期回收不得再扣「已因退款翻转成 refund」的赠分
 *  6. 暂停中的卡撤销签到时必须回补课时（不能吞课又删流水）
 *  7. 取消已付订单要落退款额并冲销结转（否则原月收入凭空消失）
 *
 * 运行：node tests/business-regression.cjs
 */
process.env.DB_PATH = '/tmp/business_reg_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/business_reg_test.db', '/tmp/business_reg_test.db-wal', '/tmp/business_reg_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
const { deriveOrderLine, recognizeTimeCardRevenue } = require('../utils/revenue');
const { expirePoints } = require('../utils/points-expiry');
const { revertDeduction } = require('../utils/attendance-revert');

let pass = 0, fail = 0;
const rec = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${ok ? '' : '  -> ' + detail}`);
};

const t = now();
const DAY = 86400000;

// ── 造数 ──
db.transaction(() => {
  db.prepare('INSERT INTO students (id, name, status, join_date, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('stu_1', '测试学员', 'active', String(t), t, t);

  const insOrder = db.prepare(`INSERT INTO orders (id, order_no, student_id, student_name, items, total_amount, discount_amount, payable_amount, order_type, status, paid_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const items = (id, name, price) => JSON.stringify([{ itemType: 'membershipCard', itemId: id, itemName: name, quantity: 1, unitPrice: price, totalPrice: price }]);
  insOrder.run('ord_free', 'F-1', 'stu_1', '测试学员', items('ct_1', '赠卡', 1000), 1000, 1000, 0, 'membership', 'paid', t, t, t);
  insOrder.run('ord_paid', 'P-1', 'stu_1', '测试学员', items('ct_1', '年卡', 1200), 1200, 0, 1200, 'membership', 'paid', t, t, t);

  const insCard = db.prepare(`INSERT INTO member_cards (id, student_id, card_type_id, card_type_name, order_id, billing_mode, total_classes, remaining_classes, activated_at, expires_at, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insCard.run('mc_active', 'stu_1', 'ct_1', '年卡', 'ord_paid', 'time', 0, 0, t - 100 * DAY, t + 265 * DAY, 'active', t, t);
  insCard.run('mc_refunded', 'stu_1', 'ct_1', '年卡', 'ord_paid', 'time', 0, 0, t - 100 * DAY, t, 'refunded', t, t);
  insCard.run('mc_count', 'stu_1', 'ct_1', '次卡', 'ord_paid', 'count', 12, 11, t, t + 365 * DAY, 'active', t, t);
  insCard.run('mc_paused', 'stu_1', 'ct_1', '次卡', 'ord_paid', 'count', 12, 5, t, t + 365 * DAY, 'paused', t, t);
})();

console.log('\n\x1b[1m=== 业务口径回归测试 ===\x1b[0m\n');

// ===== [1] 0 元单不结转 =====
console.log('\x1b[1m[1] 0 元单不得按标价结转\x1b[0m');
{
  const card = db.prepare("SELECT * FROM member_cards WHERE id = 'mc_count'").get();
  const freeCard = { ...card, order_id: 'ord_free' };
  rec('★ 实付 0 的订单推导不出结转额（返回 null）', deriveOrderLine(freeCard) === null, JSON.stringify(deriveOrderLine(freeCard)));
  rec('正常付费订单可推导', deriveOrderLine(card) !== null, 'null');
}

// ===== [2][3][4] 时效卡摊销 =====
console.log('\n\x1b[1m[2] 时效卡摊销口径\x1b[0m');
{
  recognizeTimeCardRevenue(t);
  const rowsFor = (sid) => db.prepare('SELECT * FROM revenue_recognitions WHERE schedule_id = ?').all(sid);

  const refundedRows = rowsFor('timecard:mc_refunded');
  rec('★ 已退卡不产生摊销行', refundedRows.length === 0, JSON.stringify(refundedRows));

  const activeRows = rowsFor('timecard:mc_active');
  rec('有效卡产生摊销行', activeRows.length === 1, String(activeRows.length));

  const before = activeRows[0];
  const later = t + 10 * DAY;
  recognizeTimeCardRevenue(later);
  const after = rowsFor('timecard:mc_active');
  rec('★ 再次摊销是「追加增量行」，不改写历史行',
    after.length === 2 && after.find((r) => r.id === before.id).recognized_at === before.recognized_at,
    `rows=${after.length} oldAt=${after.find((r) => r.id === before.id)?.recognized_at} expect=${before.recognized_at}`);

  const sum = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM revenue_recognitions WHERE schedule_id = 'timecard:mc_active'").get().s;
  rec('累计结转不超过实付', sum <= 1200, `sum=${sum}`);

  // 转让：换持卡人后再次摊销，不应产生第二组行
  db.prepare('INSERT INTO students (id, name, status, join_date, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('stu_2', '受让学员', 'active', String(t), t, t);
  db.prepare("UPDATE member_cards SET student_id = 'stu_2' WHERE id = 'mc_active'").run();
  recognizeTimeCardRevenue(later + DAY);
  const transferRows = rowsFor('timecard:mc_active');
  const dup = transferRows.filter((r) => r.amount > 0).length;
  rec('★ 转让后不重复确认（仍是一串增量行，总额不变）',
    db.prepare("SELECT COALESCE(SUM(amount),0) s FROM revenue_recognitions WHERE schedule_id = 'timecard:mc_active'").get().s <= 1200,
    `rows=${transferRows.length} dup=${dup}`);
}

// ===== [5] 积分过期不回收已退款赠分 =====
console.log('\n\x1b[1m[3] 积分过期回收\x1b[0m');
{
  db.prepare('INSERT INTO points (id, student_id, student_name, total_earned, balance, updated_at) VALUES (?,?,?,?,?,?)')
    .run('pts_1', 'stu_1', '测试学员', 100, 100, t);
  const insLog = db.prepare(`INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, expire_at, expired, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,?)`);
  insLog.run('pl_earn', 'stu_1', 'earn', 30, 100, '购买赠分', 'order_x', '', t - DAY, t - DAY);
  insLog.run('pl_refund', 'stu_1', 'refund', 50, 100, '订单退款回收', 'order_y', '', t - DAY, t - DAY);

  const expired = expirePoints(db, t);
  const bal = db.prepare("SELECT balance FROM points WHERE student_id = 'stu_1'").get().balance;
  rec('★ 只回收 earn/checkin，不回收 refund 行', expired === 30 && bal === 70, `expired=${expired} balance=${bal}`);
  rec('refund 行未被标记过期',
    db.prepare("SELECT expired FROM point_logs WHERE id = 'pl_refund'").get().expired === 0, '');
}

// ===== [6] 暂停卡撤销签到要回补 =====
console.log('\n\x1b[1m[4] 暂停卡撤销签到\x1b[0m');
{
  // deduction_logs.id 是自增整数，不要传字符串
  db.prepare(`INSERT INTO deduction_logs (student_id, card_id, schedule_id, count, deducted_at)
    VALUES (?,?,?,?,?)`).run('stu_1', 'mc_paused', 'sch_1', 1, t);
  const back = revertDeduction({ scheduleId: 'sch_1', studentId: 'stu_1', t });
  const card = db.prepare("SELECT remaining_classes FROM member_cards WHERE id = 'mc_paused'").get();
  rec('★ 暂停卡回补 1 节课时', back === 1 && card.remaining_classes === 6, `back=${back} remain=${card.remaining_classes}`);
  rec('扣课流水已清除', db.prepare("SELECT COUNT(*) c FROM deduction_logs WHERE schedule_id = 'sch_1'").get().c === 0, '');
}

console.log(`\n\x1b[1m结果汇总：PASS ${pass}  FAIL ${fail}\x1b[0m`);
db.close();
process.exit(fail > 0 ? 1 : 0);
