/**
 * 迁移 031：回填历史积分流水的 expire_at（D1 积分过期的历史数据补齐）
 *
 * 背景：D1 引入 point_logs.expire_at 后，只有新写入的流水带过期时间；存量流水
 * （尤其是签到积分——最大来源）expire_at 为 NULL，永不过期，导致「24 个月滚动过期」
 * 对历史积分不生效。此处按 created_at + 730 天回填「正数（获得）流水」的到期时间，
 * 负数流水（消费/退款/回滚）保持 NULL。
 *
 * 幂等：仅回填 expire_at IS NULL 的行；030 未执行（无该列）时直接跳过。
 */
const POINT_EXPIRY_MS = 730 * 24 * 3600 * 1000;

function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('point_logs')").all().map((c) => c.name);
  if (!cols.includes('expire_at')) return;
  db.prepare(`
    UPDATE point_logs SET expire_at = COALESCE(created_at, ?) + ?
    WHERE expire_at IS NULL AND amount > 0
  `).run(Date.now(), POINT_EXPIRY_MS);
}

module.exports = { up };
