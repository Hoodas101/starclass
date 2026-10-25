/**
 * 迁移 039：新增 settings.card_rules（订阅卡规则中心）
 *
 * 只补缺失键，**不覆盖机构已配过的任何值**（与既有设置项一致的幂等策略）。
 * 注意：settings.js 的 KEYS 白名单也要同步登记，否则保存时会被静默丢弃。
 */
function up(db) {
  const DEFAULTS = {
    defer: { enabled: true, startAnchor: 'day', crossScope: false, allowActivateNow: true },
    period: { defaultAnchor: 'activated' },
    refund: { formula: '', allowPartial: true },
  };

  const row = db.prepare("SELECT value FROM settings WHERE key = 'card_rules'").get();
  let current = {};
  if (row && row.value) {
    try { current = JSON.parse(row.value) || {}; } catch (e) { current = {}; }
  }
  // 按组浅合并：只补缺失组，不覆盖已配组
  const merged = {
    defer: { ...DEFAULTS.defer, ...(current.defer || {}) },
    period: { ...DEFAULTS.period, ...(current.period || {}) },
    refund: { ...DEFAULTS.refund, ...(current.refund || {}) },
  };

  if (row) {
    db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'card_rules'")
      .run(JSON.stringify(merged), Date.now());
  } else {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('card_rules', ?, ?)")
      .run(JSON.stringify(merged), Date.now());
  }
}

module.exports = { up };
