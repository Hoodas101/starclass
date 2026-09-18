/**
 * 迁移 016：性能索引补建（Batch 6 · E2 / E3）
 *
 * 背景一（enrollments 组合谓词）：`enrollments` 现有索引只有
 * `idx_enrollments_class(class_id)`、`idx_enrollments_request(request_status)`、
 * `idx_enrollments_student(student_id)`，全是单列。而最热的两个查询形态是
 * 「按排期 + 状态回查」（课次名单 / 报名核对）与「按状态全量分布」（看板报名分布），
 * 单列索引在这两种形态下都要回表再过滤，选择度差的 status 单列索引甚至会被优化器忽略。
 * 补 `(schedule_id, status)` 组合索引与 `(status)` 单列索引，让两种形态都能收敛。
 *
 * 背景二（orders.paid_at）：营收类查询原先一律写成表达式谓词
 * `date(paid_at/1000, 'unixepoch', 'localtime') = ?`（或 `strftime('%Y-%m', ...) = ?`）。
 * SQLite 只在**裸列**参与比较时才用得上索引，函数包裹的列一律退化为全表 SCAN ——
 * 看板一次调用就要对 orders 全表扫 13 次。本迁移建 `idx_orders_paid_at`，
 * 并由同批的 E3 把这些谓词改写为 `paid_at >= ? AND paid_at < ?` 的毫秒半开区间
 * （paid_at 存的是 epoch 毫秒整数），两者配合后索引才真正生效。
 *
 * 幂等性：三条语句均带 IF NOT EXISTS，新库 / 老库 / 半迁移库重复执行安全。
 * 与 014/015 不同，本迁移只加索引、不改数据、不建唯一约束，因此不需要 fail-loud 分支。
 */

function up(db) {
  // ── enrollments：排期 + 状态组合回查（课次名单 / 报名核对）──
  db.exec('CREATE INDEX IF NOT EXISTS idx_enrollments_schedule_status ON enrollments(schedule_id, status)');

  // ── enrollments：按状态的全量统计 / 分布（看板报名分布等）──
  db.exec('CREATE INDEX IF NOT EXISTS idx_enrollments_status ON enrollments(status)');

  // ── orders.paid_at：营收区间统计（配合 E3 的毫秒区间谓词改写）──
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at)');
}

module.exports = { up };
