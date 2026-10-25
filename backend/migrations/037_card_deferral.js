/**
 * 迁移 037：会员卡实例支持「顺延 + 周期锚定」
 *
 * 背景（订阅卡功能线 P1/P2）：
 *   机构按订阅制卖卡时，学员常在旧卡未用完时续费。旧实现新卡支付即生效，
 *   与旧卡完全重叠 —— 学员手里两张同科目卡，额度叠加、限次各算一套。
 *   同时「每周/每月到店上限」此前按自然周/自然月切分，与「有效期 30 天」
 *   的合同表述对不上（2 月与 1 月周期长度差 3 天）。
 *
 * 本迁移只加列，不改任何既有数据：
 *   · period_anchor 默认 'natural' —— **存量卡保持旧口径**，机构显式切换后才变；
 *   · first_used_at 默认 0 —— 由 040 回填。
 *
 * 幂等：逐列判断存在性。
 */
function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('member_cards')").all().map((c) => c.name);
  const add = (name, ddl) => {
    if (cols.includes(name)) return;
    db.exec(`ALTER TABLE member_cards ADD COLUMN ${ddl}`);
  };

  // 顺延谱系：本卡的基准卡（上一张在途卡）。空串 = 非顺延卡
  add('deferred_from_card_id', "deferred_from_card_id TEXT DEFAULT ''");
  // 首次实际使用时刻（present/late 首次落库时写），供 first_use 锚点使用
  add('first_used_at', "first_used_at INTEGER DEFAULT 0");
  // 周期锚点快照：natural（自然周/月，存量口径） / activated（开卡日） / first_use（首次使用日）
  add('period_anchor', "period_anchor TEXT DEFAULT 'natural'");
  // 周期长度快照：与卡种解耦，改卡种不追溯改写已售卡
  add('cycle_days_week', 'cycle_days_week INTEGER DEFAULT 7');
  add('cycle_days_month', 'cycle_days_month INTEGER DEFAULT 30');

  db.exec("CREATE INDEX IF NOT EXISTS idx_member_cards_activated ON member_cards(student_id, activated_at)");
}

module.exports = { up };
