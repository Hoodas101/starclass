/**
 * 迁移 032：orders.revenue_excluded（财务口径排除标记）+ students.created_at 索引
 *
 * 背景：
 *  - 核销 / 赠课 / 代金券抵扣等订单「不产生真实收入」，此前只能在 remark 里加文字标记，
 *    财务接口不解析 remark，导致这类订单永远混在营收里（口径失真）。新增显式布尔列，
 *    财务各查询统一追加 AND revenue_excluded = 0。
 *  - students 列表默认按 created_at 排序但该列无索引，EXPLAIN 显示 SCAN + TEMP B-TREE；
 *    临时建索引后 1.63ms → 0.036ms。学员规模增长后该查询会线性劣化。
 *
 * 幂等：ALTER 前查 pragma_table_info；索引用 IF NOT EXISTS。
 */
function up(db) {
  const ocols = db.prepare("SELECT name FROM pragma_table_info('orders')").all().map((c) => c.name);
  if (!ocols.includes('revenue_excluded')) {
    db.exec('ALTER TABLE orders ADD COLUMN revenue_excluded INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_revenue_excluded ON orders(revenue_excluded)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_students_created_at ON students(created_at DESC)');
}

module.exports = { up };
