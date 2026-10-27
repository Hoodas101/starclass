/**
 * 简易退费口径回归：验证「直接填数字」的计算结果与高级公式模式互不干扰。
 * 全程包在事务里，结束回滚 —— 不污染真实数据。
 */
const db = require('../db');
const { computeRefundSuggestion } = require('../utils/refund');

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
}

function setRules(refund) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('card_rules', ?)")
    .run(JSON.stringify({ refund }));
}

try {
  // 外键在事务内改不动，需先关；样例数据只用于计算验证，结束后整体回滚
  db.pragma('foreign_keys = OFF');
  db.exec('BEGIN');

  // 造数据：一张 10 次卡，已用 4 次 → 未消耗 60%；订单实付 1000
  const studentId = 900001, orderId = 900001, cardId = 900001;
  db.prepare("INSERT OR REPLACE INTO students (id, name, status, join_date) VALUES (?, ?, ?, ?)")
    .run(studentId, '退费回归样例', 'active', '2026-10-26');
  db.prepare("INSERT OR REPLACE INTO orders (id, order_no, user_id, payable_amount, refunded_amount, status, created_at) VALUES (?, ?, ?, ?, 0, 'paid', ?)")
    .run(orderId, 'RF-TEST-001', studentId, 1000, Date.now());
  db.prepare(`INSERT OR REPLACE INTO member_cards
    (id, student_id, order_id, card_type_id, billing_mode, total_classes, used_classes, remaining_classes, activated_at, status)
    VALUES (?, ?, ?, ?, 'count', 10, 4, 6, ?, 'active')`)
    .run(cardId, studentId, orderId, 1, Date.now());

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  // 1) 纯默认（base=unused, 0%/0元）：基数 1000×60% = 600
  setRules({ mode: 'simple', base: 'unused', deductPercent: 0, minFee: 0, formula: '', allowPartial: true });
  let r = computeRefundSuggestion(order);
  check('默认简易：未消耗60% → 600', r.amount, 600);

  // 2) 只填手续费比例 20：600 × 0.8 = 480
  setRules({ mode: 'simple', base: 'unused', deductPercent: 20, minFee: 0, formula: '', allowPartial: true });
  r = computeRefundSuggestion(order);
  check('手续费20% → 480', r.amount, 480);

  // 3) 基数改为整单剩余额 1000，手续费 10% → 900
  setRules({ mode: 'simple', base: 'remain', deductPercent: 10, minFee: 0, formula: '', allowPartial: true });
  r = computeRefundSuggestion(order);
  check('基数=整单剩余额,手续费10% → 900', r.amount, 900);

  // 4) 最低手续费 500（基数 600）：min(600, 600-500)=100 → 100
  setRules({ mode: 'simple', base: 'unused', deductPercent: 0, minFee: 500, formula: '', allowPartial: true });
  r = computeRefundSuggestion(order);
  check('最低手续费500封顶 → 100', r.amount, 100);

  // 5) 最低手续费 50：min(600, 550)=550 → 550
  setRules({ mode: 'simple', base: 'unused', deductPercent: 0, minFee: 50, formula: '', allowPartial: true });
  r = computeRefundSuggestion(order);
  check('最低手续费50 → 550', r.amount, 550);

  // 6) 手续费100% → 0，且不为负
  setRules({ mode: 'simple', base: 'unused', deductPercent: 100, minFee: 0, formula: '', allowPartial: true });
  r = computeRefundSuggestion(order);
  check('手续费100% → 0', r.amount, 0);

  // 7) 非法值（负数/超范围）应被丢弃保默认，不得算出负数
  setRules({ mode: 'simple', base: 'unused', deductPercent: -50, minFee: -999, formula: '', allowPartial: true });
  r = computeRefundSuggestion(order);
  check('非法负数被丢弃 → 600', r.amount, 600);

  // 8) 高级模式仍生效：公式 remain * 0.5 = 500
  setRules({ mode: 'formula', base: 'unused', deductPercent: 20, minFee: 0, formula: 'round(remain * 0.5)', allowPartial: true });
  r = computeRefundSuggestion(order);
  check('高级公式生效 → 500（数字被忽略）', r.amount, 500);

  // 9) 简易模式必须忽略卡种/全局公式（避免数字与表达式打架）
  setRules({ mode: 'simple', base: 'remain', deductPercent: 0, minFee: 0, formula: 'round(remain * 0.1)', allowPartial: true });
  r = computeRefundSuggestion(order);
  check('简易模式忽略公式 → 1000', r.amount, 1000);

  // 10) 退款基数与说明可解释
  setRules({ mode: 'simple', base: 'unused', deductPercent: 20, minFee: 0, formula: '', allowPartial: true });
  r = computeRefundSuggestion(order);
  check('说明含数字口径', /× \(1 − 20%\)/.test(r.reason) && /未消耗 60%/.test(r.reason), true);
} finally {
  db.exec('ROLLBACK');
  db.pragma('foreign_keys = ON');
}

let pass = 0, fail = 0;
for (const t of results) {
  if (t.ok) { pass++; console.log(`  PASS  ${t.name}`); }
  else { fail++; console.log(`  FAIL  ${t.name} → 实际 ${JSON.stringify(t.actual)} / 期望 ${JSON.stringify(t.expected)}`); }
}
console.log(`\n简易退费回归：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
