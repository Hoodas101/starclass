/**
 * 迁移 022：orders 补 last_refunded_at —— 退款归属月份的独立时间列
 *
 * 背景（全量实测审计 P1-A6）：退款没有自己的时间列，财务报表借用了
 * `orders.updated_at` 来把退款归集到某个月。这导致两个问题：
 *
 *   1. **归属漂移**：3 月退的款，5 月改了一次备注（PUT /orders/:id 会刷新
 *      updated_at），这笔退款就在月报里从 3 月搬到了 5 月。财务月报一旦出过
 *      就是既成事实，事后被改写等于账目被静默篡改。
 *   2. **跨报表对不平**：`summary` 与 `by-sales` / `by-product` 的退款口径
 *      取自不同的时间列/过滤条件，同一区间三张表数字互相矛盾。
 *
 * 处理：新增 `last_refunded_at`，只在**真实发生退款**时写入（全额/部分/多次退款
 * 均刷新为最后一次退款时间）。财务报表改按该列归集退款；历史数据无法追溯真实
 * 退款时间，回填为 `updated_at`（即旧口径），保证升级前后数字连续、不跳变。
 *
 * 口径说明：epoch 毫秒整数，与全库时间列一致（非秒）。默认 0 表示「从未退款」。
 *
 * 幂等性：ALTER 前先查 pragma_table_info，重复执行安全；回填只在列刚新增时执行一次。
 */

function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('orders')").all().map((c) => c.name);
  const isNew = !cols.includes('last_refunded_at');
  if (isNew) {
    db.exec('ALTER TABLE orders ADD COLUMN last_refunded_at INTEGER DEFAULT 0');
    // 历史回填：旧口径就是 updated_at，保持升级前后报表数字连续。
    // 只回填「确有退款痕迹」的订单，避免把从未退款的订单伪造成退款记录。
    db.exec(`
      UPDATE orders SET last_refunded_at = COALESCE(updated_at, 0)
      WHERE COALESCE(refunded_amount, 0) > 0
    `);
  }
  // 报表按月/区间归集退款 → 给该列建索引，避免全表扫描
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_last_refunded_at ON orders(last_refunded_at)');
}

module.exports = { up };
