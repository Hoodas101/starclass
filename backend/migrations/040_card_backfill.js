/**
 * 迁移 040：存量卡回填
 *
 * 1) first_used_at：取该学员在该卡生效期内最早的 present/late 考勤时刻。
 *    没有考勤的卡保持 0（未使用）。
 * 2) period_anchor 保持 'natural' —— 037 的默认值即旧口径，**不静默改行为**。
 * 3) cycle_days_* 保持默认 7/30（natural 锚点下不使用）。
 *
 * 幂等：只处理 first_used_at 为空/0 的卡。
 */
function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('member_cards')").all().map((c) => c.name);
  if (!cols.includes('first_used_at')) return;

  // 只回填「有考勤可依」的卡：按卡所属学员 + 卡生效区间取最早签到
  const cards = db.prepare(`
    SELECT id, student_id, activated_at, expires_at
      FROM member_cards
     WHERE COALESCE(first_used_at, 0) = 0
       AND activated_at IS NOT NULL AND activated_at > 0
  `).all();

  const upd = db.prepare('UPDATE member_cards SET first_used_at = ? WHERE id = ?');
  let filled = 0;
  for (const c of cards) {
    const row = db.prepare(`
      SELECT MIN(a.checkin_time) AS t
        FROM attendances a
       WHERE a.student_id = ?
         AND a.status IN ('present','late')
         AND a.checkin_time >= ?
         AND (? IS NULL OR ? = 0 OR a.checkin_time <= ?)
    `).get(c.student_id, c.activated_at, c.expires_at, c.expires_at, c.expires_at);
    if (row && row.t) {
      upd.run(row.t, c.id);
      filled++;
    }
  }
  if (filled) console.log(`[migration 040] 回填 first_used_at：${filled} 张卡`);
}

module.exports = { up };
