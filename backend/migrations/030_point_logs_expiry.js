/**
 * 迁移 030：point_logs 增加 expire_at / expired，落地 D1 积分滚动过期
 *
 * 背景（D1）：points 表已有 expire_at 列但从未写入/读取，过期机制缺位。
 * 精确过期必须以「每笔获得流水」为粒度（不同获得批次到期日不同），故在
 * point_logs 增加 expire_at（到期毫秒戳，消费/退款为 NULL）与 expired（是否已处理）。
 * 日调度 sweep（utils/points-expiry.js）将到期未处理的获得流水按金额从余额扣减并标记 expired。
 *
 * 幂等：ALTER 前先查 pragma_table_info，重复执行安全；索引用 IF NOT EXISTS。
 */

function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('point_logs')").all().map((c) => c.name);
  if (!cols.includes('expire_at')) {
    db.exec('ALTER TABLE point_logs ADD COLUMN expire_at INTEGER');
  }
  if (!cols.includes('expired')) {
    db.exec('ALTER TABLE point_logs ADD COLUMN expired INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_point_logs_expiry ON point_logs(expire_at, expired)');
}

module.exports = { up };
