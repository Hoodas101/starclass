/**
 * 财务报表路由
 *
 * GET /api/finance/summary     — 收支汇总（总收入、退款、净收入、订单数）
 * GET /api/finance/monthly     — 月度收支明细
 * GET /api/finance/by-product  — 按产品/卡类型统计收入
 * GET /api/finance/by-sales    — 按销售人员统计业绩
 * GET /api/finance/trend       — 收入趋势（按月/按周）
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { success, safeFail, isAdminReq } = require('../utils');

// 所有财务接口仅管理员可访问
router.use((req, res, next) => {
  if (!isAdminReq(req)) return res.status(403).json({ code: 403, data: null, message: '仅管理员可查看财务报表' });
  next();
});

/**
 * GET /api/finance/summary — 收支汇总
 * Query: { startDate?, endDate? } 默认本月
 */
// 校验并转换 YYYY-MM-DD 日期；非法值返回 NaN，由调用方回退默认区间
function parseDateParam(v) {
  if (typeof v !== 'string') return NaN;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return NaN;
  const t = new Date(v + 'T00:00:00').getTime();
  return Number.isFinite(t) ? t : NaN;
}

router.get('/summary', (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let start, end;
    const startT = startDate ? parseDateParam(startDate) : NaN;
    const endT = endDate ? parseDateParam(endDate) : NaN;
    if (Number.isFinite(startT) && Number.isFinite(endT)) {
      start = startT;
      end = new Date(endDate + 'T23:59:59.999').getTime();
    } else {
      const now = new Date();
      start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    }

    // 收入口径含 status IN ('paid','refunded')：订单退完会把 status 翻转为 refunded，
    // 若只认 paid，全额退款订单的收入从 gross 消失、refunded_amount 又照减 → net 双扣为负。
    // 已支付订单（含已全额退款的，其退款在下方统一冲减）
    const paidOrders = db.prepare(`
      SELECT COUNT(CASE WHEN status = 'paid' THEN 1 END) as order_count,
             COALESCE(SUM(payable_amount), 0) as total_revenue,
             COALESCE(SUM(discount_amount), 0) as total_discount,
             COALESCE(SUM(refunded_amount), 0) as total_refunded
      FROM orders
      WHERE status IN ('paid', 'refunded') AND order_type != 'refund' AND paid_at >= ? AND paid_at <= ?
    `).get(start, end);

    // 退款总额（与收入同一行集合：paid 的部分退 + refunded 的全额退，避免跨口径双扣）
    const refunded = db.prepare(`
      SELECT COUNT(*) as refund_count,
             COALESCE(SUM(refunded_amount), 0) as refund_amount
      FROM orders
      WHERE status IN ('paid', 'refunded') AND order_type != 'refund' AND refunded_amount > 0 AND updated_at >= ? AND updated_at <= ?
    `).get(start, end);

    // 按订单类型分组
    const byType = db.prepare(`
      SELECT order_type,
             COUNT(*) as count,
             COALESCE(SUM(payable_amount), 0) as revenue,
             COALESCE(SUM(refunded_amount), 0) as refunded
      FROM orders
      WHERE status IN ('paid', 'refunded') AND order_type != 'refund' AND paid_at >= ? AND paid_at <= ?
      GROUP BY order_type
    `).all(start, end);

    // 教师课时费支出：仅统计已结算记录，按「薪资所属月份」归属（与 monthly 口径一致），
    // 避免次月结算上月工资时落在查询区间之外。
    const ymOf = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };
    const monthsInRange = [];
    {
      let cur = ymOf(start); const endYm = ymOf(end);
      while (cur <= endYm && monthsInRange.length < 24) {
        monthsInRange.push(cur);
        const [y, m] = cur.split('-').map(Number);
        cur = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      }
    }
    let coachPay = { total_pay: 0 };
    try {
      const ph = monthsInRange.map(() => '?').join(',');
      coachPay = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total_pay
        FROM payroll_logs
        WHERE status = 'settled' AND month IN (${ph})
      `).get(...monthsInRange) || { total_pay: 0 };
    } catch (e) { /* payroll_logs 表不存在时跳过 */ }

    const netRevenue = (paidOrders.total_revenue || 0) - (refunded.refund_amount || 0);
    const netProfit = netRevenue - (coachPay.total_pay || 0);

    res.json(success({
      period: { start, end },
      revenue: {
        gross: paidOrders.total_revenue || 0,
        discount: paidOrders.total_discount || 0,
        refunded: refunded.refund_amount || 0,
        net: netRevenue,
      },
      orders: {
        paid: paidOrders.order_count || 0,
        refunded: refunded.refund_count || 0,
      },
      expense: {
        coachPay: coachPay.total_pay || 0,
      },
      // 净利润口径：师资成本按 payroll_logs 中已结算（settled）记录扣除；
      // 未结算月份该笔支出计 0（属正常口径，非缺陷），在「薪资结算」页执行结算后自动变真。
      expenseNote: coachPay.total_pay > 0
        ? ''
        : '本月暂无已结算师资成本，净利润未扣除教师课时费（可在「薪资结算」中按月结算）',
      profit: netProfit,
      byType: byType.map(t => ({
        type: t.order_type || 'other',
        count: t.count,
        revenue: t.revenue,
        refunded: t.refunded,
        net: t.revenue - t.refunded,
      })),
    }));
  } catch (err) {
    console.error('[finance summary]', err);
    res.status(500).json(safeFail('获取财务汇总失败'));
  }
});

/**
 * GET /api/finance/monthly — 月度收支明细
 * Query: { year? } 默认当前年
 */
router.get('/monthly', (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const startMs = new Date(year, 0, 1).getTime();
    const endMs = new Date(year, 11, 31, 23, 59, 59, 999).getTime();

    // 与 summary 同口径：含已全额退款（status='refunded'）订单，其 refunded_amount 在同月冲减，
    // 否则出现「summary 扣了、monthly 没扣」的跨报表矛盾。RFND 退款流水行 paid_at 为 NULL 天然不入此表。
    // 收入/折扣按「订单支付月份」（paid_at）归属。
    const months = db.prepare(`
      SELECT
        strftime('%m', datetime(paid_at/1000, 'unixepoch', 'localtime')) as month,
        COUNT(CASE WHEN status = 'paid' THEN 1 END) as order_count,
        COALESCE(SUM(payable_amount), 0) as revenue,
        COALESCE(SUM(discount_amount), 0) as discount
      FROM orders
      WHERE status IN ('paid', 'refunded') AND order_type != 'refund' AND paid_at >= ? AND paid_at <= ?
      GROUP BY month
      ORDER BY month
    `).all(startMs, endMs);

    // 退款单独按「退款发生月份」（orders.updated_at）归属，与 /summary 的 revenue.refunded 完全同口径。
    // 若沿用 paid_at，跨月退款会落在原支付月，导致同一年内 summary 与 monthly 的退款额永远对不平。
    const refundsByMonth = db.prepare(`
      SELECT
        strftime('%m', datetime(updated_at/1000, 'unixepoch', 'localtime')) as month,
        COALESCE(SUM(refunded_amount), 0) as refunded
      FROM orders
      WHERE status IN ('paid', 'refunded') AND order_type != 'refund' AND refunded_amount > 0
        AND updated_at >= ? AND updated_at <= ?
      GROUP BY month
      ORDER BY month
    `).all(startMs, endMs);

    // 教师课时费支出按月统计（容错：表可能不存在）
    // 归属到「薪资所属月份」（month 字段）而非结算操作时间；仅统计已结算记录
    let coachPayByMonth = [];
    try {
      coachPayByMonth = db.prepare(`
        SELECT substr(month, 6, 2) as month,
          COALESCE(SUM(amount), 0) as total_pay
        FROM payroll_logs
        WHERE status = 'settled' AND month LIKE ?
        GROUP BY month
      `).all(`${year}-%`);
    } catch (e) { /* payroll_logs 表不存在时跳过 */ }

    // 合并数据
    const payMap = {};
    coachPayByMonth.forEach(p => { payMap[p.month] = p.total_pay; });
    const refundMap = {};
    refundsByMonth.forEach(r => { refundMap[r.month] = r.refunded; });

    const result = [];
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const data = months.find(d => d.month === mm) || { month: mm, order_count: 0, revenue: 0, discount: 0 };
      const coachPay = payMap[mm] || 0;
      const refunded = refundMap[mm] || 0;
      const net = data.revenue - refunded;
      result.push({
        month: mm,
        revenue: data.revenue || 0,
        discount: data.discount || 0,
        refunded,
        netRevenue: net,
        coachPay,
        profit: net - coachPay,
        orderCount: data.order_count || 0,
      });
    }

    const totals = result.reduce((acc, r) => ({
      revenue: acc.revenue + r.revenue,
      discount: acc.discount + r.discount,
      refunded: acc.refunded + r.refunded,
      netRevenue: acc.netRevenue + r.netRevenue,
      coachPay: acc.coachPay + r.coachPay,
      profit: acc.profit + r.profit,
      orderCount: acc.orderCount + r.orderCount,
    }), { revenue: 0, discount: 0, refunded: 0, netRevenue: 0, coachPay: 0, profit: 0, orderCount: 0 });

    res.json(success({ year, months: result, totals, expenseNote: totals.coachPay > 0
      ? ''
      : '本年度暂无已结算师资成本，净利润未扣除教师课时费（可在「薪资结算」中按月结算）' }));
  } catch (err) {
    console.error('[finance monthly]', err);
    res.status(500).json(safeFail('获取月度报表失败'));
  }
});

/**
 * GET /api/finance/by-product — 按产品/卡类型统计收入
 * Query: { startDate?, endDate? }
 */
router.get('/by-product', (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let start, end;
    const startT = startDate ? parseDateParam(startDate) : NaN;
    const endT = endDate ? parseDateParam(endDate) : NaN;
    if (Number.isFinite(startT) && Number.isFinite(endT)) {
      start = startT;
      end = new Date(endDate + 'T23:59:59.999').getTime();
    } else {
      const now = new Date();
      start = new Date(now.getFullYear(), 0, 1).getTime();
      end = now.getTime();
    }

    // E16：原实现把区间内每张订单的 items 整行读进 JS、逐条 JSON.parse 再在 JS 里做加权分摊，
    // 订单量上万后是纯 CPU + 内存开销。改为 SQL 侧 json_each 展开、按订单算 gross 后分摊，
    // 只把「已按产品名聚合好的行」带回 JS（与 /admin/charts 的 productSales 同一套路）。
    // 分摊口径与旧实现逐字对应：
    //   · gross = Σ(unitPrice×qty)（unitPrice 缺失回退 price，再缺失记 0）
    //   · gross > 0 时按单项 itemValue/gross 占比分摊 payable_amount / refunded_amount
    //   · gross 非正时按订单项数均分
    //   · 非法 JSON / 非数组 items 统一按 '[]' 处理，等价于旧实现的 continue
    //   · 元素必须自身是 JSON 对象才取字段（json_type = 'object'）。这是刻意保留旧实现的语义：
    //     json_extract 对「数组元素为 JSON 字符串」的双重编码行会**自动下沉**解析出真实 itemName，
    //     而旧 JS 实现取 item.itemName 恒为 undefined、把这类行记成「未命名」且标价计 0。
    //     /admin/charts 的 productSales 已按前者（真实项目名）归类；本接口是财务报表，
    //     口径变更会让历史月份的 by-product 与既有报表对不上，故此处显式保持旧口径不变。
    //     （附带修正：旧实现在元素为 null 时会抛 TypeError 导致整个接口 500，此处按「未命名」处理。）
    // 四舍五入刻意留在 JS：SQL 的 round() 对负数是「远离零」，JS Math.round 是「向上」，
    // 而 net 可能为负，两者会在 .5 处产生分歧。
    const rows = db.prepare(`
      WITH valid AS (
        SELECT o.id, o.payable_amount, o.refunded_amount,
               CASE WHEN json_valid(o.items) AND json_type(o.items) = 'array'
                    THEN o.items ELSE '[]' END AS items_json
        FROM orders o
        WHERE o.status IN ('paid', 'refunded') AND o.order_type != 'refund'
          AND o.paid_at >= ? AND o.paid_at <= ?
      ),
      exploded AS (
        SELECT v.id, v.payable_amount, v.refunded_amount,
               json_array_length(v.items_json) AS n_items,
               CASE WHEN it.type = 'object'
                    THEN COALESCE(NULLIF(json_extract(it.value, '$.itemName'), ''),
                                  NULLIF(json_extract(it.value, '$.name'), ''), '未命名')
                    ELSE '未命名' END AS name,
               CASE WHEN it.type = 'object'
                     AND CAST(json_extract(it.value, '$.quantity') AS REAL) > 0
                    THEN CAST(json_extract(it.value, '$.quantity') AS REAL) ELSE 1 END AS qty,
               CASE WHEN it.type = 'object'
                    THEN COALESCE(CAST(json_extract(it.value, '$.unitPrice') AS REAL),
                                  CAST(json_extract(it.value, '$.price') AS REAL), 0)
                    ELSE 0 END AS unit_price
        FROM valid v, json_each(v.items_json) AS it
      ),
      per_order AS (
        SELECT id, SUM(unit_price * qty) AS gross FROM exploded GROUP BY id
      )
      SELECT e.name AS name,
             SUM(e.qty) AS count,
             SUM(CASE WHEN p.gross > 0 THEN e.payable_amount * (e.unit_price * e.qty / p.gross)
                      WHEN e.n_items > 0 THEN e.payable_amount * 1.0 / e.n_items
                      ELSE 0 END) AS revenue,
             SUM(CASE WHEN p.gross > 0 THEN e.refunded_amount * (e.unit_price * e.qty / p.gross)
                      WHEN e.n_items > 0 THEN e.refunded_amount * 1.0 / e.n_items
                      ELSE 0 END) AS refunded
      FROM exploded e JOIN per_order p ON p.id = e.id
      GROUP BY e.name
    `).all(start, end);

    const result = rows
      .map((p) => ({
        ...p,
        revenue: Math.round(p.revenue),
        refunded: Math.round(p.refunded),
        net: Math.round(p.revenue - p.refunded),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json(success({ list: result, total: result.length }));
  } catch (err) {
    console.error('[finance by-product]', err);
    res.status(500).json(safeFail('获取产品收入统计失败'));
  }
});

/**
 * GET /api/finance/by-sales — 按销售人员统计业绩
 * Query: { startDate?, endDate? }
 */
router.get('/by-sales', (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let start, end;
    const startT = startDate ? parseDateParam(startDate) : NaN;
    const endT = endDate ? parseDateParam(endDate) : NaN;
    if (Number.isFinite(startT) && Number.isFinite(endT)) {
      start = startT;
      end = new Date(endDate + 'T23:59:59.999').getTime();
    } else {
      const now = new Date();
      start = new Date(now.getFullYear(), 0, 1).getTime();
      end = now.getTime();
    }

    const list = db.prepare(`
      SELECT
        salesperson,
        COUNT(*) as order_count,
        COALESCE(SUM(payable_amount), 0) as revenue,
        COALESCE(SUM(refunded_amount), 0) as refunded,
        COALESCE(SUM(CASE WHEN is_1v1 = 1 THEN 1 ELSE 0 END), 0) as vip_count
      FROM orders
      WHERE status IN ('paid', 'refunded') AND order_type != 'refund' AND paid_at >= ? AND paid_at <= ?
      GROUP BY salesperson
      ORDER BY revenue DESC
    `).all(start, end);

    const result = list.map(s => ({
      salesperson: s.salesperson || '未分配',
      orderCount: s.order_count,
      revenue: s.revenue,
      refunded: s.refunded,
      net: s.revenue - s.refunded,
      vipCount: s.vip_count,
    }));

    res.json(success({ list: result, total: result.length }));
  } catch (err) {
    console.error('[finance by-sales]', err);
    res.status(500).json(safeFail('获取销售业绩失败'));
  }
});

module.exports = router;
