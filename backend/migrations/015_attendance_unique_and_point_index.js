/**
 * 迁移 015：考勤 (schedule_id, student_id) 唯一约束 + 积分流水引用索引
 *
 * 背景一（唯一约束）：`attendances` 的语义键是「某排期某学员的一条考勤」——
 * 全部 4 处生产写入点（checkin.js:192 / :356 / :515、leave.js:290）都先按
 * `WHERE schedule_id = ? AND student_id = ?` 查存在性再决定 INSERT 还是 UPDATE，
 * 且 checkin.js:187 的 UPDATE 正是用这两列做条件。也就是说**代码早已假定这两列唯一**，
 * 只是数据库层没有强制。缺约束的后果不是「多一行脏数据」那么轻：一旦出现重复行，
 * 后续那条 UPDATE 会同时改中两行，而 `LEFT JOIN attendances` 的聚合
 * （如 checkin.js:508 的自动缺席、看板到场率）会把同一个学员算两次。
 *
 * 背景二（索引）：`point_logs.reference_id` 无任何索引，而全额退款路径
 * （orders.js:500）要按 `reference_id GLOB 'order_<id>*'` 回查该订单发放过的积分
 * 以便回收。实测该 GLOB 前缀模式本可走索引（EXPLAIN QUERY PLAN 显示
 * `SEARCH ... USING INDEX (reference_id>? AND reference_id<?)` 的区间扫描），
 * 缺索引时退化为全表 SCAN —— 每次全额退款都全表扫一遍积分流水。
 *
 * 幂等性：两条语句均带 IF NOT EXISTS，新库 / 老库重复执行安全。
 *
 * ⚠️ 唯一索引的失败处理（重要，P0-3 修订）：
 * 早期版本在检测到历史重复行时**静默跳过**建索引，但迁移仍「成功」被记账，
 * 导致下次启动直接跳过、唯一约束永远缺失。修订后改为 **fail-loud**：检测到重复行时
 * 抛出带可执行修复指引的错误，迁移不会被记为已完成、会在运维清理重复行并重启后重试。
 * 这样暴露真实的数据完整性问题，而不是把它藏起来。point_logs 索引是独立的安全幂等项，
 * 先建，不随唯一约束的失败而连带回滚丢失。
 */

function up(db) {
  // ── 2. point_logs.reference_id 索引（退款回收集成积分的热路径，安全幂等，先建）──
  db.exec('CREATE INDEX IF NOT EXISTS idx_point_logs_reference ON point_logs(reference_id)');

  // ── 1. attendances(schedule_id, student_id) 唯一约束 ──
  const dupes = db.prepare(`
    SELECT schedule_id, student_id, COUNT(*) AS c
    FROM attendances
    GROUP BY schedule_id, student_id
    HAVING c > 1
    ORDER BY c DESC
    LIMIT 20
  `).all();

  if (dupes.length > 0) {
    // 存在重复行：无法建立唯一约束。fail-loud 而非静默跳过 —— 否则迁移会被记为
    // 「已完成」却未建索引，下次启动直接跳过、约束永远缺失（P0-3）。
    // 由运维确认每组重复行保留其一，删除 _migrations 中本记录并重启即可重建约束。
    const detail = dupes.map(d => `    ${d.schedule_id} / ${d.student_id} → ${d.c} 行`).join('\n');
    throw new Error(
      `[Migrations] 015 无法建立唯一约束：attendances 存在 ${dupes.length} 组重复 (schedule_id, student_id)。\n` +
      `${detail}\n` +
      `请人工确认并保留每组中的一行，删除 _migrations 表中 name = '015_attendance_unique_and_point_index.js' ` +
      `的记录后重启，本迁移会重新执行并建立约束。`
    );
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_attendances_schedule_student
    ON attendances(schedule_id, student_id)
  `);
}

module.exports = { up };
