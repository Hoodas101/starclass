/**
 * 迁移 023：时效卡「到店次数上限」字段（每周 / 每月）
 *
 * 背景（全量实测审计 P1-D1，作者提出）：系统已支持计次/时效双制
 * （billing_mode = count / time），但时效卡学员可以无限次到店，机构无法用
 * 「限定每周/每月到店次数」来控制频次、提升单次到店价值与排课效率。
 * 全库无任何到店限次字段（grep max_visit / quota / 每月 均无命中）。
 *
 * 处理：在卡种（membership_cards）与卡实例（member_cards）两侧各加两个字段：
 *   · visit_limit_per_week  —— 每自然周（周一为一周起点）允许到店次数
 *   · visit_limit_per_month —— 每自然月允许到店次数
 *   取值 0 或 NULL 表示「不限次」（默认，向后兼容存量数据）。
 *
 * 为什么卡种与卡实例都存：卡种上是「销售策略」（新建卡种时设定），
 * 卡实例上是「签发时的快照」——与 total_classes / valid_days 的处理方式一致，
 * 保证日后调整卡种不会追溯改写已售出的卡（已售合同不可单方面变更）。
 *
 * 幂等性：ALTER 前先查 pragma_table_info，重复执行安全。
 */

function up(db) {
  const addColumn = (table, column, ddl) => {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (exists) return;
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  };

  addColumn('membership_cards', 'visit_limit_per_week', 'INTEGER DEFAULT 0');
  addColumn('membership_cards', 'visit_limit_per_month', 'INTEGER DEFAULT 0');
  addColumn('member_cards', 'visit_limit_per_week', 'INTEGER DEFAULT 0');
  addColumn('member_cards', 'visit_limit_per_month', 'INTEGER DEFAULT 0');
}

module.exports = { up };
