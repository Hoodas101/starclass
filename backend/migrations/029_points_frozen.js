/**
 * 迁移 029：points 增加 frozen 冻结标记
 *
 * 背景（D4 归档冻结）：归档学员时其会员卡已置 frozen（students.js 归档联动，
 * 见 applyAdminUpdate 事务），但积分（points 聚合）在排行榜/余额统计中仍计入，
 * 形成「幽灵资产」。新增 frozen 标记，归档时置 1、反归档置 0；排行榜/统计排除冻结项。
 *
 * 幂等：ALTER 前先查 pragma_table_info，重复执行安全；索引用 IF NOT EXISTS。
 */

function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('points')").all().map((c) => c.name);
  if (!cols.includes('frozen')) {
    db.exec('ALTER TABLE points ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_points_frozen ON points(frozen)');
}

module.exports = { up };
