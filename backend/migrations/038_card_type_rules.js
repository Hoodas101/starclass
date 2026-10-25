/**
 * 迁移 038：卡种支持「顺延开关 / 周期锚点 / 退费公式」
 *
 * 三个字段都可留空 —— 留空表示「跟随全局设置」，避免机构每建一个卡种都要重复配一遍。
 *
 * 幂等：逐列判断存在性。
 */
function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('membership_cards')").all().map((c) => c.name);
  const add = (name, ddl) => {
    if (cols.includes(name)) return;
    db.exec(`ALTER TABLE membership_cards ADD COLUMN ${ddl}`);
  };

  // 该卡种是否参与顺延（默认关闭：机构显式开启后才改变发卡行为）
  add('defer_enabled', 'defer_enabled INTEGER DEFAULT 0');
  // 周期锚点覆盖：'' = 跟随全局；activated / first_use / natural
  add('period_anchor', "period_anchor TEXT DEFAULT ''");
  // 退费公式：'' = 跟随全局/内置默认
  add('refund_formula', "refund_formula TEXT DEFAULT ''");
}

module.exports = { up };
