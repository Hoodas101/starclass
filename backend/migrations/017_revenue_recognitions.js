/**
 * 迁移 017：收入结转（合同负债）台账 —— revenue_recognitions
 *
 * 背景：`GET /api/finance/summary` 的收入一直按 `orders.paid_at` **全额**确认
 * （收付实现制）：学员交 1299 元买 24 课时的季卡，收款当天 1299 元全部进收入。
 * 但教培是预收费行业 —— 钱收了、课还没上，未消课部分在经济实质上是**合同负债**
 * 而非收入；只有学员实际到课、课时被消耗，那部分预收款才转为收入（权责发生制）。
 *
 * 本迁移只**新增**一张旁路台账表，不改动任何既有表/列，也不改变既有接口的
 * 取值与语义（既有收付实现制口径原样保留，新口径以新增字段并存）。
 * 一条记录 = 一次成功扣课所结转的课时与金额，由 routes/checkin.js 在扣课成功的
 * **同一事务内**写入，保证与 member_cards / deduction_logs 的扣减原子一致。
 *
 * 字段说明：
 *   · order_id      —— 本卡关联订单（member_cards.order_id）；推导不出时为 NULL
 *   · attendance_id —— 触发的考勤行；缺省 NULL
 *   · classes       —— 本次结转的课时数（= courses.consume_classes，缺省 1）
 *   · amount        —— 本次结转金额（**整数元**）；无法可靠推导单价时写 0
 *   · recognized_at —— 结转发生时间（epoch 毫秒，与全库时间列口径一致）
 *   · basis         —— 计价依据说明；无法解析单价时固定写 'unresolved'
 *
 * 幂等性：三条语句均带 IF NOT EXISTS，新库 / 老库 / 半迁移库重复执行安全。
 * 本迁移只建表建索引、不改数据、不加唯一约束，因此不需要 fail-loud 分支
 * （与 016 同一取舍）。重复结转的防护由写入侧保证：checkin.js 的扣课路径本身
 * 以 deduction_logs 的 UNIQUE(schedule_id, student_id) 为幂等闸门。
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS revenue_recognitions (
      id            TEXT PRIMARY KEY,
      order_id      TEXT,
      student_id    TEXT,
      schedule_id   TEXT,
      attendance_id TEXT,
      course_id     TEXT,
      course_name   TEXT,
      classes       REAL,
      amount        INTEGER,
      recognized_at INTEGER,
      basis         TEXT,
      created_at    INTEGER
    );
  `);

  // ── 按订单回查（退课/退卡时冲销结转、按订单核对已结转金额）──
  db.exec('CREATE INDEX IF NOT EXISTS idx_revenue_recognitions_order ON revenue_recognitions(order_id)');

  // ── 按结转时间区间统计（finance/summary 的 recognizedRevenue）──
  db.exec('CREATE INDEX IF NOT EXISTS idx_revenue_recognitions_recognized_at ON revenue_recognitions(recognized_at)');

  // ── 按学员回查（学员维度的已消课/剩余课时核对）──
  db.exec('CREATE INDEX IF NOT EXISTS idx_revenue_recognitions_student ON revenue_recognitions(student_id)');
}

module.exports = { up };
