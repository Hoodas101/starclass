/**
 * P1-8 回归测试 —— 会员卡过期状态流转 + 低课时提醒排除过期卡
 *
 * 运行（隔离库，每次运行前重建 seed 夹具，绝不污染真实数据）：
 *   NODE_ENV=test node tests/card-expiry-regression.cjs
 *
 * 说明：旧版直接复制真实库快照，故能顺带打印「快照中已过期却仍 active 的卡数」作为缺陷现场。
 * 收敛为夹具单路径后该数字恒为 0，缺陷现场改由用例内 mkCard() 自行构造 ——
 * 断言本身一直是自足的（不依赖库中既有过期卡），因此收敛不损失覆盖。
 *
 * 覆盖的原始缺陷：
 *   1. `member_cards.status` 从不流转为 'expired'（全库只有 leave.js 一处会写），
 *      于是所有只按 `status = 'active'` 过滤的查询把过期卡当作有效卡。
 *   2. 低课时提醒未排除已过期卡，家长会同时收到「课时即将用尽请续费」与卡已过期的事实。
 *
 * 判别性说明（每条断言都先证明旧代码给出不同结果）：
 *   - 过期流转：旧代码无此函数，卡永远停在 'active'。
 *   - 提醒过滤：用例内直接跑「旧口径查询」证明它**会**命中该过期卡，
 *     从而证明新查询的过滤是有效约束，而不是恒不命中的空断言。
 */
'use strict';

// ---- 隔离库（必须在 require('../db') 之前设置）----
// 唯一引导路径：每次运行都重建 seed 夹具库（详见 _bootstrap.cjs 说明）。
const { bootstrap } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-cardexp');

const db = require('../db');
const { expireOverdueCards } = require('../utils/card-lifecycle');
const { generateLowClassReminders } = require('../utils/reminders');

let passed = 0, failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${ok ? '' : '  -> ' + detail}`);
}

const DAY = 86400000;
const gen = (p) => p + Math.random().toString(36).slice(2, 10);
const created = []; // 用例自建卡 id，收尾清理

/**
 * 插入一张受控的会员卡。
 * @param {{expiresAt:number|null, status?:string, remaining?:number, total?:number, billing?:string}} o
 */
function mkCard(o) {
  const { expiresAt = Date.now() + DAY, status = 'active', remaining = 2, total = 10, billing = 'count' } = o;
  const bind = db.prepare('SELECT parent_openid, student_id FROM parent_bindings WHERE is_main = 1 LIMIT 1').get()
    || db.prepare('SELECT parent_openid, student_id FROM parent_bindings LIMIT 1').get();
  const id = gen('CARD_EXP_');
  const ts = Date.now();
  db.prepare(`
    INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name,
      total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id,
      pause_total_ms, created_at, updated_at)
    VALUES (?, 'ct_exp_probe', '过期流转探针卡', ?, ?, '探针学员', ?, ?, ?, ?, ?, ?, '', 0, ?, ?)
  `).run(id, billing, bind.student_id, total, remaining, total - remaining, ts - 30 * DAY, expiresAt, status, ts, ts);
  created.push(id);
  return { id, studentId: bind.student_id, parentOpenid: bind.parent_openid };
}

const statusOf = (id) => (db.prepare('SELECT status FROM member_cards WHERE id = ?').get(id) || {}).status;
const notified = (cardId, weekMs) => !!db.prepare('SELECT 1 FROM notifications WHERE template_id = ?')
  .get(`low_class_${cardId}_${Math.floor(Date.now() / weekMs)}`);

console.log('\n\x1b[1m=== P1-8 会员卡过期流转回归测试 ===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '（seed 夹具）\n');

// ============================================================
// 一、低课时提醒必须排除已过期卡
// ============================================================
console.log('\x1b[1m[一] 低课时提醒排除过期卡\x1b[0m');
{
  const nowMs = Date.now();
  const weekMs = 7 * DAY;
  const threshold = 3;

  // 过期卡：仍在 'active'（模拟旧代码的既有状态），剩余 2 节 ≤ 阈值
  const expired = mkCard({ expiresAt: nowMs - DAY, remaining: 2 });
  // 有效卡：剩余 2 节 ≤ 阈值，到期日在未来 → 应当照常收到提醒
  const valid = mkCard({ expiresAt: nowMs + 10 * DAY, remaining: 2 });

  // 判别性自证：旧口径查询（无 expires_at 过滤）确实会命中那张过期卡
  const oldHit = db.prepare(`
    SELECT COUNT(*) AS c FROM member_cards mc
    WHERE mc.status = 'active' AND mc.remaining_classes <= ? AND mc.remaining_classes > 0 AND mc.id = ?
  `).get(threshold, expired.id).c;
  rec('旧口径查询会命中过期卡（证明过滤是有效约束）', oldHit === 1, `oldHit=${oldHit}`);

  generateLowClassReminders(nowMs);

  rec('已过期卡不再收到低课时续费提醒', !notified(expired.id, weekMs), '仍生成了 NTF_LOW_CLASS 通知');
  rec('未过期低课时卡照常收到提醒（查询未被写坏）', notified(valid.id, weekMs), '未生成通知');
}

// ============================================================
// 二、过期状态流转
// ============================================================
console.log('\n\x1b[1m[二] 过期状态流转（expireOverdueCards）\x1b[0m');
{
  const nowMs = Date.now();
  const overdue = mkCard({ expiresAt: nowMs - DAY });                 // 应流转
  const future = mkCard({ expiresAt: nowMs + DAY });                  // 不应流转
  const paused = mkCard({ expiresAt: nowMs - DAY, status: 'paused' }); // 暂停态不由时间决定，不应流转
  const noExpiry = mkCard({ expiresAt: null });                       // 无到期日，不应流转
  const refunded = mkCard({ expiresAt: nowMs - DAY, status: 'refunded' }); // 已退卡，不应流转

  // 按判据先算一遍应流转的数量（含上方低课时用例遗留的过期卡），再与实际比较：
  // 这样任何「未预料到的卡被误伤」都会体现在计数不符上。
  const expectedSweep = db.prepare(
    "SELECT COUNT(*) AS c FROM member_cards WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?"
  ).get(nowMs).c;

  const r1 = expireOverdueCards(nowMs);
  rec('已过期有效卡 → expired', statusOf(overdue.id) === 'expired', `got=${statusOf(overdue.id)}`);
  rec('未到期卡保持 active', statusOf(future.id) === 'active', `got=${statusOf(future.id)}`);
  rec('暂停卡不被误伤（保持 paused）', statusOf(paused.id) === 'paused', `got=${statusOf(paused.id)}`);
  rec('无到期日的卡不被误伤（保持 active）', statusOf(noExpiry.id) === 'active', `got=${statusOf(noExpiry.id)}`);
  rec('已退卡不被误伤（保持 refunded）', statusOf(refunded.id) === 'refunded', `got=${statusOf(refunded.id)}`);
  rec('流转数量与判据完全一致（无多扫/漏扫）', r1.expired === expectedSweep, `expired=${r1.expired} expected=${expectedSweep}`);

  // 幂等：重复执行不再产生变更
  const r2 = expireOverdueCards(nowMs);
  rec('重复执行幂等（第二次流转 0 张）', r2.expired === 0, `expired=${r2.expired}`);
}

// ============================================================
// 收尾清理（仅测试库）
// ============================================================
for (const id of created) {
  db.prepare('DELETE FROM notifications WHERE template_id LIKE ?').run(`low_class_${id}_%`);
  db.prepare('DELETE FROM member_cards WHERE id = ?').run(id);
}

console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
