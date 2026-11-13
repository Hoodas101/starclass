/**
 * 迁移 042 — 存量脏数据一致性修复（幂等，可重复执行）
 *
 * 审计 2026-11-10 发现的三处「已登记迁移 / 绕过业务写入路径」遗留问题：
 *
 * 1) students.join_date 仍是 13 位毫秒串。
 *    迁移 041 已在旧库登记执行，但 db/seed.js 此前仍写 String(Date.now())，
 *    新建或重置演示库会在 041 之后再次污染；本迁移作为兜底在启动时回填，
 *    写入侧已同步改为 'YYYY-MM-DD'。
 *
 * 2) 部分退款订单被写成 status='refunded' 终态。
 *    orders.js 的退款守卫原先只看 status，剩余可退额度被永久锁死；
 *    现已改为按 refunded_amount >= payable_amount 判定全退，此处把存量行改回 'paid'
 *    以恢复续退能力，并让状态与金额重新自洽。
 *
 * 3) 退款金额在 orders 有记录、payments 却没有任何 REF 流水。
 *    seed 直接落库绕过了 orders.js 的退款事务。按累计 refunded_amount 补一条
 *    REF 流水，使「钱退了多少」在支付流水侧可追溯（payments 不参与营收 SUM 口径，
 *    补登不会污染财务报表）。仅在完全缺失 REF 流水时补，避免重复记账。
 *
 * 全部语句带幂等条件；执行前后可重复运行无副作用。
 */
function up(db) {
  const hasTable = (name) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(name);

  // ── 1) join_date 毫秒串 → 日期串 ──
  if (hasTable('students')) {
    const cols = db.prepare("SELECT name FROM pragma_table_info('students')").all().map((c) => c.name);
    if (cols.includes('join_date')) {
      const r = db.prepare(`
        UPDATE students
        SET join_date = strftime('%Y-%m-%d', datetime(CAST(join_date AS INTEGER) / 1000, 'unixepoch', '+8 hours'))
        WHERE join_date IS NOT NULL
          AND join_date NOT LIKE '%-%'
          AND length(join_date) >= 10
          AND CAST(join_date AS INTEGER) BETWEEN 1000000000000 AND 9999999999999
      `).run();
      if (r.changes > 0) console.log(`[Migrations] 042 join_date 回填日期串：${r.changes} 行`);
    }
  }

  if (!hasTable('orders')) return;

  const orderCols = db.prepare("SELECT name FROM pragma_table_info('orders')").all().map((c) => c.name);

  // ── 2) 部分退款却标记终态的订单改回可续退状态 ──
  if (['status', 'refunded_amount', 'payable_amount'].every((c) => orderCols.includes(c))) {
    const r = db.prepare(`
      UPDATE orders SET status = 'paid'
      WHERE status = 'refunded'
        AND COALESCE(refunded_amount, 0) > 0
        AND COALESCE(refunded_amount, 0) < COALESCE(payable_amount, 0) - 0.005
    `).run();
    if (r.changes > 0) console.log(`[Migrations] 042 部分退款终态纠正为 paid：${r.changes} 行`);
  }

  // ── 3) 补登缺失的退款流水 ──
  if (hasTable('payments') && orderCols.includes('refunded_amount')) {
    const missing = db.prepare(`
      SELECT o.id, o.order_no, o.user_id, o.refunded_amount,
             COALESCE(NULLIF(o.last_refunded_at, 0), o.updated_at, o.created_at) AS refund_ts,
             (SELECT p.channel FROM payments p
              WHERE p.order_id = o.id AND p.status <> 'refunded'
              ORDER BY COALESCE(p.paid_at, p.created_at) DESC LIMIT 1) AS channel
      FROM orders o
      WHERE COALESCE(o.refunded_amount, 0) > 0
        AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.order_id = o.id AND r.status = 'refunded')
    `).all();
    if (missing.length > 0) {
      const insert = db.prepare(`
        INSERT INTO payments (id, order_id, order_no, user_id, amount, channel, status, paid_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'refunded', ?, ?)
      `);
      for (const o of missing) {
        const ts = Number(o.refund_ts) || Date.now();
        insert.run(`REF_BACKFILL_${o.id}`, o.id, o.order_no || null, o.user_id || null,
          Number(o.refunded_amount) || 0, o.channel || 'manual', ts, ts);
      }
      console.log(`[Migrations] 042 补登缺失退款流水：${missing.length} 行`);
    }
  }
}

module.exports = { up };
