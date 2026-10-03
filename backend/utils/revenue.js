/**
 * 收入结转口径收口 —— 单价推导 + 时效卡按时间摊销。
 *
 * 背景：routes/checkin.js 的「扣课成功 → 结转一条收入」依赖 deriveUnitPrice
 * 从卡的关联订单推导「实付价 / 总课时数」。该函数原本内联在 checkin.js 里，
 * 时效卡（billing_mode='time'）却完全不参与结转 —— 时效卡学员到课不写
 * revenue_recognitions，于是 finance/summary 的 recognizedRevenue 永远缺时效卡部分，
 * contractLiability（全期已收 − 全期已结转）把时效卡收入**永久**挂成合同负债。
 *
 * 本模块做两件事，且只有这两件：
 *   1. 把 deriveUnitPrice（计次卡：元/课时）与其底层「订单行实付价」推导抽出，
 *      供 checkin.js（计次卡扣课）与 recognizeTimeCardRevenue（时效卡摊销）共用，
 *      避免两处各写一份、口径日久漂移。**单向依赖**：本模块不 require routes/*，
 *      由 routes/checkin.js require 本模块（反过来会成环）。
 *   2. recognizeTimeCardRevenue(asOfDate?)：时效卡按「已过天数 / 总有效天数」
 *      摊销结转，写入同一张 revenue_recognitions 台账。
 *
 * 金额口径与全库一致：单位**整数元**，由调用方四舍五入；推导不出实付价时
 * 绝不猜测金额（跳过该卡，不写 0 元行）。
 */
'use strict';

const db = require('../db');
const { generateId } = require('../utils');
const { parseItems, itemLineTotal, itemQuantity } = require('./items');
// revenue_recognitions 表存在性判定与「冲销」共用考勤回滚模块的单一实现
const { hasRevenueRecognitionTable } = require('./attendance-revert');

/**
 * 从卡的**关联订单**推导「本卡那一行的实付价」与「总课时数」。
 *
 * 关联关系取 member_cards.order_id —— 由 orders.js / membership.js 建卡时写入，
 * 是唯一能确定「这张卡到底是按哪笔钱买的」的凭据。
 * 刻意**不**跨订单模糊匹配（例如按 student_id + card_type_id 去别的订单里找）：
 * 同一学员可能以不同价格买过同类卡，那样推导出的单价是猜的。
 *
 * 折扣口径：结转基数是**实际收到的钱**，不是标价。若按标价结转，折扣单的累计
 * 结转额会超过订单实付，合同负债（已收未结转）因此出现负数。
 * 故取整单折扣比例（实付 / 标价）× 行小计。与退卡（membership.js）同一口径。
 *
 * @param {object} card member_cards 行（需含 order_id / card_type_id / card_type_name / total_classes）
 * @returns {{orderId:string, lineTotal:number, totalClasses:number}|null}
 *          null 表示无法可靠推导（无订单 / 无明细 / 明细里找不到本卡商品）
 */
function deriveOrderLine(card) {
  if (!card || !card.order_id) return null;
  const order = db.prepare('SELECT id, items, total_amount, payable_amount FROM orders WHERE id = ?').get(card.order_id);
  if (!order) return null;
  const orderTotal = Number(order.total_amount) || 0;
  const orderPayable = Number(order.payable_amount) || 0;
  const discountRatio = (orderTotal > 0 && orderPayable > 0 && orderPayable < orderTotal)
    ? orderPayable / orderTotal : 1;
  // 必须走 utils/items：双重编码（数组元素本身是 JSON 字符串）时直接取字段恒为 undefined
  const items = parseItems(order.items);
  if (!items.length) return null;
  // 精确匹配本卡商品：优先 itemId（orders.js 写入字段），历史脏数据缺 itemId 时按卡类型名匹配。
  // 不退回 items[0] —— 多明细订单会把别的商品价格算到本卡头上。
  const item = items.find((i) => i.itemId && String(i.itemId) === String(card.card_type_id))
    || items.find((i) => i.itemName && card.card_type_name && i.itemName === card.card_type_name);
  if (!item) return null;
  const rawLine = itemLineTotal(item);
  const lineTotal = discountRatio < 1 ? Math.round(rawLine * discountRatio) : rawLine;
  // 总课时数优先取卡上登记值（售出时的真实课时数），取不到才回退订单项数量。
  // 时效卡的 total_classes 常为 0，此时会回退到 itemQuantity（通常为 1）——
  // 对时效卡而言该值无意义（它只用于 deriveUnitPrice 的元/课时换算），
  // 摊销路径只用 lineTotal，不读 totalClasses。
  const totalClasses = Number(card.total_classes) > 0 ? Number(card.total_classes) : itemQuantity(item);
  return { orderId: order.id, lineTotal, totalClasses };
}

/**
 * 计次卡单位课时价（元/课时）—— 从 deriveOrderLine 之上加「单价必须可解析」的约束。
 * 返回结构与历史上内联在 checkin.js 里的实现**完全一致**，供调用方无缝替换。
 *
 * @returns {{unit:number, lineTotal:number, totalClasses:number, orderId:string}|null}
 *          null 表示无法可靠推导 —— 调用方必须写 amount=0 / basis='unresolved'
 */
function deriveUnitPrice(card) {
  const d = deriveOrderLine(card);
  if (!d || !(d.lineTotal > 0) || !(d.totalClasses > 0)) return null;
  return { unit: d.lineTotal / d.totalClasses, lineTotal: d.lineTotal, totalClasses: d.totalClasses, orderId: d.orderId };
}

/**
 * 时效卡按时间摊销结转收入（合同负债 → 收入）。
 *
 * 口径：对每张 billing_mode='time' 且能推导出实付价、activated_at / expires_at 有效的卡，
 *   应结转 = round(实付价 × 已过天数 / 总有效天数)
 * 其中「已过天数」以 asOfDate 为观察点并**夹取到 [activated_at, expires_at]**：
 *   · asOf < activated_at → 0（未生效，不结转）；
 *   · asOf ≥ expires_at   → 全额（到期即全部确认为收入）。
 *
 * 幂等与去重（关键设计）：
 *   · schedule_id 用固定格式 `timecard:<cardId>`，与课时结转行（schedule_id 是真排期 id）
 *     天然隔离 —— revertRevenueRecognition(scheduleId, studentId) 只会按真排期 id 删除，
 *     绝不会误删时效卡的摊销行；
 *   · 同卡只保留一行：每次把 amount UPDATE 为**累计应结转额**（不是本次增量），
 *     重复执行 delta ≤ 0 时不做任何写入，因此多次运行结果收敛、可安全重跑。
 *     财务侧按 recognized_at 落区间聚合：这里每次更新都把 recognized_at 推到 asOf，
 *     使该卡已确认收入整体落在最近一次摊销所在期间（合同负债总量口径始终正确）。
 *   · classes 写 0（时效卡不消耗课时），basis 写明摊销公式便于审计核对。
 *
 * 表不存在（迁移 017 未执行）时静默跳过，绝不让调用方报错。
 * 本函数自开 immediate 事务（与签到路径不同：它是批处理，由定时任务调用，
 * 调用方通常不在事务内；如需嵌套调用请改为不传 asOf 的纯函数版本）。
 *
 * @param {number} [asOfDate] 观察时间戳（毫秒），缺省 Date.now()
 * @returns {{recognized:number, amount:number}} 本次实际更新/新增的卡数与增量金额合计
 */
function recognizeTimeCardRevenue(asOfDate) {
  if (!hasRevenueRecognitionTable()) return { recognized: 0, amount: 0 };
  const asOf = Number.isFinite(asOfDate) ? asOfDate : Date.now();

  const cards = db.prepare(`
    SELECT * FROM member_cards
    WHERE billing_mode = 'time'
      AND order_id IS NOT NULL AND order_id <> ''
      AND activated_at IS NOT NULL AND expires_at IS NOT NULL
      AND expires_at > activated_at
  `).all();

  let recognized = 0;
  let amount = 0;

  const run = db.transaction(() => {
    for (const card of cards) {
      const paid = deriveOrderLine(card);
      if (!paid || !(paid.lineTotal > 0)) continue; // 推导不出实付价：不猜测、跳过

      const totalMs = card.expires_at - card.activated_at;
      // 已过时长夹取到有效区间：未生效记 0，已到期记满额
      const elapsedMs = Math.min(Math.max(asOf - card.activated_at, 0), totalMs);
      const shouldRecognize = Math.round(paid.lineTotal * elapsedMs / totalMs);

      const scheduleId = `timecard:${card.id}`;
      const existing = db.prepare(
        'SELECT id, amount FROM revenue_recognitions WHERE schedule_id = ? AND student_id = ?'
      ).get(scheduleId, card.student_id);
      const already = existing ? (Number(existing.amount) || 0) : 0;
      const delta = shouldRecognize - already;
      if (delta <= 0) continue; // 已结转额不小于应结转额：无新增，保持幂等

      const basis = `时效卡按时间摊销: 实付${paid.lineTotal}元 × 已过${Math.round(elapsedMs / 86400000)}天 / 总${Math.round(totalMs / 86400000)}天; order=${paid.orderId}; card=${card.id}`;
      if (existing) {
        db.prepare('UPDATE revenue_recognitions SET amount = ?, recognized_at = ?, basis = ? WHERE id = ?')
          .run(shouldRecognize, asOf, basis, existing.id);
      } else {
        db.prepare(`
          INSERT INTO revenue_recognitions (id, order_id, student_id, schedule_id, attendance_id,
            course_id, course_name, classes, amount, recognized_at, basis, created_at)
          VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?)
        `).run(generateId('rr_'), paid.orderId, card.student_id, scheduleId, shouldRecognize, asOf, basis, asOf);
      }
      recognized++;
      amount += delta;
    }
  });
  run.immediate();

  return { recognized, amount };
}

module.exports = {
  deriveOrderLine,
  deriveUnitPrice,
  recognizeTimeCardRevenue,
};
