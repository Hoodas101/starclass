/**
 * 迁移 028：trial_bookings 补 student_id —— 体验课成交后绑定学员档案
 *
 * 背景（P0-2 体验课转正式学员）：`trial_bookings` 原本没有 `student_id` 列，
 * 体验课转正式学员时无法把预约记录与新建的学员档案关联起来，也就无法回答
 * 「这条预约转化成了哪个学员」，幂等判据（是否已转化）同样无处落库。
 *
 * 处理：新增可空列 `student_id`。可空是刻意的 —— 存量预约都还没有转化，
 * 强行给默认值等于伪造「已转化」状态。已转化的预约由 routes/trial.js 的
 * `POST /:id/convert` 写入该列。
 *
 * 说明：routes/trial.js 顶部此前有一段**运行时幂等补列守卫**（pragma 查 + ALTER）
 * 用于在缺少本迁移的库上兜底。本迁移落地后该守卫成为冗余，已同步移除 ——
 * schema 变更统一由 migrations 拥有，避免「启动时偷偷改表结构」的隐式行为。
 *
 * 幂等性：ALTER 前先查 pragma_table_info，重复执行安全。
 */

function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('trial_bookings')").all().map((c) => c.name);
  if (!cols.includes('student_id')) {
    db.exec('ALTER TABLE trial_bookings ADD COLUMN student_id TEXT');
  }
  // 按学员回查其体验课记录（学员档案页/转化溯源）
  db.exec('CREATE INDEX IF NOT EXISTS idx_trial_bookings_student ON trial_bookings(student_id)');
}

module.exports = { up };
