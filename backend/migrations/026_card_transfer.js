/**
 * 迁移 026：会员卡转让 —— 卡实例的受让人字段 + 转让流水表
 *
 * 背景（增量问题报告第二轮 P1-8）：卡种表 ct_003（时效年卡）`transferable = 1`
 * 已在售，但全后端没有任何转让路由/入口，member_cards 也没有受让人字段 ——
 * 属「承诺已卖出、交付未实现」，比没有这个字段更糟：线下转让后系统无记录，
 * 受让人上课时系统查无卡，扣课失败但考勤已记，账实不符。
 *
 * 处理：
 *   1. member_cards 补三列，记录「这张卡是从谁手上转来的」（历史不可改写：
 *      deduction_logs / attendances / orders 一律不动，转让只改卡的归属）。
 *   2. 新建 card_transfer_logs 表：转让是**有价资产易主**，必须留痕可追溯，
 *      仅靠 audit_log 的 JSON 快照不足以回答「这张卡被转过几次、每次转给谁」。
 *
 * 幂等性：ALTER 前先查 pragma_table_info，重复执行安全。
 */

function up(db) {
  const addColumn = (table, column, ddl) => {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (exists) return;
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  };

  addColumn('member_cards', 'transfer_from_student_id', 'TEXT');
  addColumn('member_cards', 'transfer_from_student_name', 'TEXT');
  addColumn('member_cards', 'transferred_at', 'INTEGER DEFAULT 0');

  db.exec(`
    CREATE TABLE IF NOT EXISTS card_transfer_logs (
      id                  TEXT PRIMARY KEY,
      card_id             TEXT NOT NULL,
      card_type_name      TEXT,
      from_student_id     TEXT,
      from_student_name   TEXT,
      to_student_id       TEXT NOT NULL,
      to_student_name     TEXT,
      remaining_classes   INTEGER,
      expires_at          INTEGER,
      reason              TEXT DEFAULT '',
      operator_id         TEXT,
      operator_role       TEXT,
      created_at          INTEGER
    );
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_card_transfer_logs_card ON card_transfer_logs(card_id)');
}

module.exports = { up };
