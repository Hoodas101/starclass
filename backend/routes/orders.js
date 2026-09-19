/**
 * 订单路由 — 创建订单、我的订单、支付、退款、订单列表
 * POST /api/orders              — 创建订单
 * GET  /api/orders/my           — 我的订单
 * POST /api/orders/:id/pay      — 支付订单（模拟）
 * POST /api/orders/:id/refund   — 申请退款
 * GET  /api/orders              — 订单列表（管理员）
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
// 管理员判断统一来自 utils（此前各路由各自复制实现）
const { generateId, success, fail, safeFail, getOpenId, now, parsePagination, hasPerm, getReqUser, calcCardExpiresAt, formatDate, recordAudit, isAdminReq } = require('../utils');
const { parseItems } = require('../utils/items');
// 退费规则引擎已抽到 utils/refund：refund-preview / refund / 退卡（membership）共用同一口径
const { computeRefundSuggestion } = require('../utils/refund');

// 销售权限：管理员或拥有「sales」权限的员工（销售）
function canSales(req) {
  return isAdminReq(req) || hasPerm(getReqUser(req), 'sales');
}

// E3：把 date(paid_at/1000,'unixepoch','localtime') 这类表达式谓词改写为 paid_at 的毫秒区间比较。
// 函数包裹的列用不上索引 → 每次 /stats 与订单列表筛选都对 orders 全表扫描；
// 016 迁移建的 idx_orders_paid_at 只在裸列比较下才会被选中。
// paid_at 存的是 epoch 毫秒整数；区间取半开 [start, end)，与原来的 date(...) 比较等价。
const dayStartMs = (d) => new Date(`${d}T00:00:00`).getTime();        // 'YYYY-MM-DD' 当日 00:00 本地
const dayEndMs = (d) => dayStartMs(d) + 86400000;                      // 次日 00:00（开区间上界）
const monthStartMs = (ym) => new Date(`${ym}-01T00:00:00`).getTime();  // 'YYYY-MM' 当月 1 日 00:00
const nextMonthStartMs = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const nm = m === 12 ? 1 : m + 1;
  return new Date(`${m === 12 ? y + 1 : y}-${String(nm).padStart(2, '0')}-01T00:00:00`).getTime();
};
const yearStartMs = (y) => new Date(`${y}-01-01T00:00:00`).getTime();
const nextYearStartMs = (y) => new Date(`${Number(y) + 1}-01-01T00:00:00`).getTime();

// refunded_amount / salesperson / remark / is_1v1 列已收编至 migrations/011

// 解析订单项目文本
function parseOrderItems(itemsJson) {
  try {
    const items = parseItems(itemsJson);
    return items.map((i) => i.itemName || i.name || '').filter(Boolean).join('、');
  } catch (e) {
    return '';
  }
}

// 读取「购买产品送积分」规则是否启用（未配置时默认启用，向后兼容）
function isPurchasePointsEnabled() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'points_rules'").get();
  if (!row || !row.value) return true;
  try {
    const rules = JSON.parse(row.value);
    if (!Array.isArray(rules)) return true;
    const purchase = rules.find((r) => r && r.name === '购买产品送积分');
    if (!purchase) return true;
    return purchase.enabled !== false;
  } catch (e) {
    return true;
  }
}

// 支付并激活会员卡（供直接录入已收款订单复用）
function settleOrder(order, paidAt) {
  const currentTime = paidAt || now();
  db.prepare('UPDATE orders SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?')
    .run('paid', currentTime, currentTime, order.id);
  db.prepare('INSERT INTO payments (id, order_id, order_no, user_id, amount, channel, status, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(generateId('PAY'), order.id, order.order_no, order.user_id, order.payable_amount, 'wechat', 'success', currentTime, currentTime);
  grantOrderBenefits(order, currentTime);
}

/**
 * 仅在订单已标记为 paid 之后调用：根据订单明细创建会员卡 / 发放购买积分。
 * 不做订单状态标记与支付流水写入，避免被重复调用（如支付回调路径已写过流水时）。
 */
function grantOrderBenefits(order, paidAt) {
  const currentTime = paidAt || now();
  const items = parseItems(order.items);
  // 解析为空但订单确有 items 原文 → 极可能是坏数据/双重编码异常，静默跳过会漏发会员卡与积分
  if (order.items && parseItems(order.items).length === 0) console.error('grantOrderBenefits: 订单 items 解析为空，可能漏发权益', order && order.id);
  for (const item of items) {
    const productId = item.itemId;
    if (!productId) continue;
    const product = db.prepare('SELECT * FROM membership_cards WHERE id = ?').get(productId);
    if (!product) continue;

    const isCard = (product.product_type || 'membership') === 'membership' && product.billing_mode !== 'goods';

    if (isCard && (item.itemType === 'membershipCard' || order.order_type === 'membership')) {
      const cardId = generateId('CARD');
      const expiresAt = calcCardExpiresAt(currentTime, product.valid_days, product.billing_mode || 'time');
      db.prepare(`
        INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name,
          total_classes, remaining_classes, activated_at, expires_at, status, order_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(cardId, product.id, product.name, product.billing_mode || 'time', order.student_id, order.student_name,
        product.total_classes, product.total_classes, currentTime, expiresAt, order.id, currentTime, currentTime);
    }

    // 购买产品（会员卡或实物商品）赠送积分（幂等：按 订单+商品 去重；受积分规则开关控制）
    const reward = (product.points_reward || 0);
    if (reward > 0 && isPurchasePointsEnabled()) {
      const refId = 'order_' + order.id + '_' + product.id;
      const exist = db.prepare('SELECT id FROM point_logs WHERE reference_id = ?').get(refId);
      if (!exist) {
        const student = db.prepare('SELECT name FROM students WHERE id = ?').get(order.student_id);
        const acc = db.prepare('SELECT id FROM points WHERE student_id = ?').get(order.student_id);
        if (!acc && student) {
          db.prepare('INSERT INTO points (id, student_id, student_name, total_earned, balance, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(generateId('PTS'), order.student_id, student.name, reward, reward, currentTime);
        } else {
          db.prepare('UPDATE points SET total_earned = total_earned + ?, balance = balance + ?, updated_at = ? WHERE student_id = ?')
            .run(reward, reward, currentTime, order.student_id);
        }
        const bal = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(order.student_id)?.balance || reward;
        db.prepare('INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(generateId('PLG'), order.student_id, 'earn', reward, bal, '购买「' + product.name + '」赠送积分', refId, '购买产品赠送', currentTime);
      }
    }
  }
}

/**
 * POST /api/orders — 创建订单
 * Body: { studentId, cardTypeId, items, discountAmount, orderType, salesperson, remark, status, paidAt }
 */
router.post('/', (req, res) => {
  try {
    // 创建销售单属于管理操作（家长购买走联系客服渠道）
    if (!canSales(req)) return res.status(403).json(safeFail('无销售录入权限'));
    const { studentId, cardTypeId, items, discountAmount = 0, orderType = 'membership', salesperson = '', remark = '', status = 'pending', paidAt, is1v1 = 0, payableAmount: overrideAmount } = req.body;
    const openid = getOpenId(req);
    if (!studentId) return res.json(fail('缺少成员ID'));

    const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
    if (!student) return res.json(fail('成员不存在'));

    let orderItems = items;
    let totalAmount = 0;

    // 如果是会员卡订单且没有显式 items，根据 cardTypeId 构造
    if (orderType === 'membership' && cardTypeId && !items) {
      const cardType = db.prepare('SELECT * FROM membership_cards WHERE id = ?').get(cardTypeId);
      if (!cardType) return res.json(fail('会员卡类型不存在'));
      orderItems = [{ itemType: 'membershipCard', itemId: cardTypeId, itemName: cardType.name, quantity: 1, unitPrice: cardType.price, totalPrice: cardType.price }];
      totalAmount = cardType.price;
    } else if (items?.length) {
      totalAmount = items.reduce((sum, item) => sum + (item.unitPrice || 0) * (item.quantity || 1), 0);
    } else {
      return res.json(fail('缺少订单项或会员卡类型'));
    }

    let payableAmount = Math.max(0, totalAmount - discountAmount);
    // 支持管理端按实际成交价录入（覆盖项目标价）
    if (overrideAmount !== undefined && isFinite(Number(overrideAmount)) && Number(overrideAmount) >= 0) {
      payableAmount = Number(overrideAmount);
    }
    const currentTime = now();
    const id = generateId('ORD');
    const orderNo = `ORD${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // INSERT 与（若已付）结算同处一个事务：任一环节失败整体回滚，避免"已付订单无支付流水/未激活卡"
    db.transaction(() => {
      db.prepare(`
        INSERT INTO orders (id, order_no, user_id, student_id, student_name, order_type, items, total_amount, discount_amount, payable_amount, status, salesperson, remark, is_1v1, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, orderNo, openid, studentId, student.name, orderType, JSON.stringify(orderItems), totalAmount, discountAmount, payableAmount, status, salesperson, remark, is1v1 ? 1 : 0, currentTime, currentTime);

      // 直接录入已收款订单：立即结算并激活会员卡（settleOrder/grantOrderBenefits 内部按 reference_id 幂等去重）
      if (status === 'paid') {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
        settleOrder(order, paidAt || currentTime);
      }

      // 建单即确定应收金额，status='paid' 时还会立即结算建卡发积分；
      // overrideAmount 可绕过项目标价任意定价，必须留痕（保留原始 totalAmount，让「被人为改过价」在审计里可见）
      const auditAfter = { orderNo, studentId, totalAmount, payableAmount, status };
      if (overrideAmount !== undefined && isFinite(Number(overrideAmount)) && Number(overrideAmount) >= 0) {
        auditAfter.overridden = true;
      }
      recordAudit(db, {
        entity: 'order',
        entityId: id,
        action: 'create',
        actorId: openid,
        actorRole: req.userRole || '',
        before: null,
        after: auditAfter,
      });
    })();

    res.json(success({ orderId: id, orderNo, totalAmount, payableAmount, discountAmount }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * POST /api/orders/import — 批量导入销售记录（CSV 解析后由前端提交 JSON）
 * Body: { rows: [{ studentName, phone, itemName, amount, salesperson, paidDate, orderNo, remark }] }
 * 按「姓名 + 电话」匹配成员；找不到的行会跳过并返回原因。
 */
router.post('/import', (req, res) => {
  try {
    if (!canSales(req)) return res.status(403).json(safeFail('无销售导入权限'));
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.json(fail('未提供导入数据'));
    if (rows.length > 2000) return res.json(fail('单次最多导入 2000 条'));

    const okCount = [];
    const failed = [];

    const insertOrder = db.prepare(`
      INSERT INTO orders (id, order_no, user_id, student_id, student_name, order_type, items, total_amount, discount_amount, payable_amount, status, salesperson, remark, is_1v1, created_at, updated_at)
      VALUES (?, ?, '', ?, ?, 'membership', ?, ?, 0, ?, 'pending', ?, ?, 0, ?, ?)
    `);

    // 整批导入单事务提交：任一行出现未预期异常即整体回滚，避免半批订单入库。
    // 行级校验失败只记入 failed 不影响其余行；校验通过的行走 settleOrder，
    // 补齐支付流水并激活应得权益（幂等）。
    db.transaction(() => {
      rows.forEach((r, idx) => {
        const studentName = String(r.studentName || '').trim();
        const phone = String(r.phone || '').trim();
        const itemName = String(r.itemName || '').trim();
        const amount = Number(r.amount);
        if (!studentName || !itemName) {
          failed.push({ row: idx + 2, reason: '成员姓名与项目必填' });
          return;
        }
        if (!Number.isFinite(amount) || amount <= 0) {
          failed.push({ row: idx + 2, reason: '金额需为大于 0 的数字' });
          return;
        }

        // 匹配成员：优先姓名+电话，其次姓名
        let student = null;
        if (phone) {
          student = db.prepare(`
            SELECT s.id, s.name FROM students s
            JOIN parent_bindings pb ON pb.student_id = s.id
            WHERE s.name = ? AND pb.parent_phone = ? LIMIT 1
          `).get(studentName, phone);
        }
        if (!student) {
          student = db.prepare('SELECT id, name FROM students WHERE name = ? ORDER BY created_at DESC LIMIT 1').get(studentName);
        }
        if (!student) {
          failed.push({ row: idx + 2, reason: `未找到成员「${studentName}」` });
          return;
        }

        const id = generateId('ORD');
        const t = now();
        let paidTs = r.paidDate ? new Date(String(r.paidDate).trim() + 'T12:00:00').getTime() : t;
        if (!Number.isFinite(paidTs)) paidTs = t; // 非法日期回退为当前时间，防止 NaN 写入
        const orderNo = String(r.orderNo || '').trim() || `ORD${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        const items = [{ itemType: 'product', itemName, quantity: 1, unitPrice: amount, totalPrice: amount }];
        insertOrder.run(id, orderNo, student.id, student.name, JSON.stringify(items), amount, amount, String(r.salesperson || '').trim(), String(r.remark || '').trim(), t, t);
        const order = {
          id,
          order_no: orderNo,
          user_id: '',
          student_id: student.id,
          student_name: student.name,
          items: JSON.stringify(items),
          payable_amount: amount,
          order_type: 'membership',
        };
        settleOrder(order, paidTs);
        okCount.push({ studentName, itemName, amount });
      });

      // 批量导入每一行都会结算建卡发分，逐条留痕会产生几千行噪音；此处只写一条汇总
      // （count=成功导入条数，settled=实际结算条数，本流程中二者相等）
      recordAudit(db, {
        entity: 'order',
        entityId: '',
        action: 'import',
        actorId: getOpenId(req),
        actorRole: req.userRole || '',
        before: null,
        after: { count: okCount.length, settled: okCount.length },
      });
    })();

    res.json(success({ success: okCount.length, failed, created: okCount.length }));
  } catch (err) {
    console.error('[orders import]', err);
    res.status(500).json(safeFail('导入失败，请稍后重试'));
  }
});

/**
 * GET /api/orders/my — 我的订单（通过 openid 查询）
 * Query: { status }
 */
router.get('/my', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));

    const { status } = req.query;
    // 兼容历史 openid 格式：按账号 openid 或绑定成员匹配订单
    let sql = `
      SELECT * FROM orders
      WHERE (user_id = ? OR student_id IN (
        SELECT student_id FROM parent_bindings WHERE parent_openid = ?
      ))
    `;
    const params = [openid, openid];
    if (status && status !== 'all') { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const list = db.prepare(sql).all(...params);
    res.json(success({ list }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * POST /api/orders/:id/pay — 支付订单（模拟）
 * 模拟支付成功，更新订单状态，创建支付记录，激活会员卡
 */
router.post('/:id/pay', (req, res) => {
  try {
    const { id } = req.params;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.json(fail('订单不存在'));
    // Ownership: only the order owner (or a bound parent) can pay
    if (!isAdminReq(req)) {
      const openid = getOpenId(req);
      const owned = order.user_id === openid || db.prepare(
        'SELECT 1 FROM parent_bindings WHERE parent_openid = ? AND student_id = ?'
      ).get(openid, order.student_id);
      if (!owned) return res.status(403).json(safeFail('无权操作该订单'));
    }
    if (order.status === 'cancelled' || order.status === 'refunded') return res.json(fail('订单已取消或已退款'));
    // Self-mark-paid is a simulated-pay shortcut. Real WeChat Pay is not wired
    // up yet, so an open shortcut would let parents settle orders with zero
    // funds received. Therefore it is DISABLED BY DEFAULT in production
    // (fail-closed). Set SIMULATED_PAY_DISABLED=0 to re-enable it explicitly
    // (local dev / demo only). Admins are never affected.
    const simulatedPayEnabled = process.env.SIMULATED_PAY_DISABLED === '0'
      || (process.env.SIMULATED_PAY_DISABLED === undefined && process.env.NODE_ENV !== 'production');
    if (!isAdminReq(req) && !simulatedPayEnabled) {
      return res.status(403).json(safeFail('该机构未开放自助支付，请联系机构收银'));
    }

    const currentTime = now();
    // Atomic claim inside the transaction: pending → paid. Zero affected rows
    // means a concurrent request already handled it — prevents double activation.
    const result = db.transaction(() => {
      const claim = db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(currentTime, currentTime, order.id);
      if (claim.changes === 0) {
        const cur = db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id);
        return { dup: cur && cur.status === 'paid' ? '订单已支付' : '订单状态不可支付' };
      }
      const paidOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      db.prepare('INSERT INTO payments (id, order_id, order_no, user_id, amount, channel, status, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(generateId('PAY'), paidOrder.id, paidOrder.order_no, paidOrder.user_id, paidOrder.payable_amount, 'wechat', 'success', currentTime, currentTime);
      // 仅激活会员卡 + 发积分（grantOrderBenefits 内部按 订单+商品 幂等去重），不再重复置订单状态
      grantOrderBenefits(paidOrder, currentTime);

      // 收款是资金流入的关键节点：置 paid 并写入支付流水、发放权益；退款已有审计，收款更必须留痕
      recordAudit(db, {
        entity: 'order',
        entityId: paidOrder.id,
        action: 'pay',
        actorId: getOpenId(req),
        actorRole: req.userRole || '',
        before: { status: order.status, payableAmount: Number(order.payable_amount) || 0 },
        after: {
          status: 'paid',
          payableAmount: Number(paidOrder.payable_amount) || 0,
          paymentMethod: 'wechat',
          paidAt: currentTime,
        },
      });
      return { ok: true };
    })();

    if (result.dup) return res.json(fail(result.dup));
    res.json(success({ paid: true, paidAt: currentTime }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/orders/:id/refund-preview — 按退费规则计算建议退款金额
 * 返回：是否开课、适用规则、建议金额、卡剩余信息
 */
router.get('/:id/refund-preview', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可操作退款'));
    const { id } = req.params;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.json(fail('订单不存在'));
    if (order.status !== 'paid') return res.json(fail('只有已支付订单可退款'));

    const s = computeRefundSuggestion(order);
    res.json(success({
      started: s.started,
      mode: s.mode,
      amount: s.amount,
      reason: s.reason,
      paid: Number(order.payable_amount) || 0,
      refundedSoFar: Number(order.refunded_amount) || 0,
      remain: s.remain,
      cardInfo: s.cardInfo,
      needApproval: s.needApproval,
      processDays: s.processDays,
      rules: s.rules,
    }));
  } catch (err) {
    console.error('[orders refund-preview]', err);
    res.status(500).json(safeFail('操作失败，请稍后重试'));
  }
});

/**
 * POST /api/orders/:id/refund — 申请退款
 * Body: { reason, refundAmount?, confirmOverride? }
 * refundAmount 省略时按退费规则建议值退款；显式传入且与建议值不符时必须带 confirmOverride=true，
 * 防止预览页只是装饰（旧版可绕过规则全额甚至任意金额退款）。
 */
router.post('/:id/refund', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可操作退款'));
    const { id } = req.params;
    const { reason = '', refundAmount, confirmOverride } = req.body;
    const currentTime = now();
    let clawback = null; // set when a partial refund reclaims card entitlement
    // Refund runs in one transaction with an optimistic lock on refunded_amount
    // to prevent concurrent double refunds.
    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!order) return { err: '订单不存在' };
      if (order.status !== 'paid') return { err: '只有已支付订单可退款' };

      const paidAmount = Number(order.payable_amount) || 0;
      const refundedSoFar = Number(order.refunded_amount) || 0;

      // 规则建议金额（与 refund-preview 同一计算）：省略入参时按建议值退款
      const suggestion = computeRefundSuggestion(order);
      const requested = refundAmount === undefined || refundAmount === null || refundAmount === ''
        ? suggestion.amount
        : Number(refundAmount);
      if (!Number.isFinite(requested) || requested <= 0 || requested > paidAmount) {
        return { err: '退款金额不合法（应在 0 至订单金额之间）' };
      }
      // 偏离规则建议值需显式覆盖确认（允许 ¥1 计算误差）
      if (Math.abs(requested - suggestion.amount) > 1 && !confirmOverride) {
        return {
          mismatch: true,
          suggested: suggestion.amount,
          reason: suggestion.reason,
        };
      }
      const amount = requested;
      const newRefunded = refundedSoFar + amount;
      if (newRefunded > paidAmount) return { err: '累计退款金额不能超过订单金额' };

      const isFull = newRefunded >= paidAmount;
      // Entitlement reclaim applies only to rule-suggested amounts;
      // a negotiated custom amount is a voluntary discount and keeps card benefits.
      const appliedSuggestion = Math.abs(requested - suggestion.amount) <= 1;
      // Optimistic lock: fails if refunded_amount changed concurrently
      const upd = db.prepare("UPDATE orders SET refunded_amount = ?, status = CASE WHEN ? >= ? THEN 'refunded' ELSE status END, updated_at = ? WHERE id = ? AND refunded_amount = ?")
        .run(newRefunded, newRefunded, paidAmount, currentTime, order.id, refundedSoFar);
      if (upd.changes === 0) return { conflict: true };

      if (isFull) {
        // 全额退款：将关联的会员卡标记为已退款
        const cards = db.prepare('SELECT * FROM member_cards WHERE order_id = ?').all(order.id);
        for (const card of cards) {
          db.prepare('UPDATE member_cards SET status = ?, updated_at = ? WHERE id = ?').run('refunded', currentTime, card.id);
        }
        // 全额退款：回收购买赠送的积分（按 订单+商品 维度查找，支持多商品订单）
        const rewardLogs = db.prepare("SELECT * FROM point_logs WHERE reference_id GLOB ? AND type = 'earn'").all('order_' + order.id + '*');
        let totalReward = 0;
        for (const log of rewardLogs) {
          totalReward += Number(log.amount) || 0;
          db.prepare("UPDATE point_logs SET type = 'refund', description = '订单退款回收积分' WHERE id = ?").run(log.id);
        }
        if (totalReward > 0) {
          db.prepare(`
            UPDATE points SET
              total_earned = MAX(0, total_earned - ?),
              balance = MAX(0, balance - ?),
              updated_at = ?
            WHERE student_id = ?
          `).run(totalReward, totalReward, currentTime, order.student_id);
        }
      } else if (appliedSuggestion && suggestion.started && (suggestion.mode === 'custom' || suggestion.mode === 'ratio') && suggestion.cardId) {
        // 语义：凡**按规则建议值**退款（appliedSuggestion 为真）且该退款对应「交出剩余权益」
        // 的，都要同步回收卡权益——否则学员既拿到现金退款、又保留全部剩余课时/有效期。
        // mode==='ratio' 是 afterStart='percent' 的规则扣费退（退款额 = remain×(1−pct%)），
        // 此前只回收 custom 分支，ratio 分支既不回收权益也不标记 refunded → 直接资金漏洞。
        // 只有协商金额（appliedSuggestion 为假，即显式 confirmOverride 偏离规则）才视为
        // 自愿折扣，保留卡权益。
        const card = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(suggestion.cardId);
        if (card && card.status !== 'refunded') {
          if ((card.billing_mode || 'time') === 'count') {
            db.prepare('UPDATE member_cards SET remaining_classes = 0, updated_at = ? WHERE id = ?').run(currentTime, card.id);
            clawback = `已同步回收卡内剩余 ${card.remaining_classes || 0} 次课时`;
          } else {
            db.prepare('UPDATE member_cards SET expires_at = ?, updated_at = ? WHERE id = ?').run(currentTime, card.id);
            clawback = '已同步清零卡内剩余有效期';
          }
        }
      }

      // Refund payment record
      const paymentId = generateId('REF');
      db.prepare('INSERT INTO payments (id, order_id, order_no, user_id, amount, channel, status, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(paymentId, order.id, order.order_no, order.user_id, amount, 'wechat', 'refunded', currentTime, currentTime);

      // Audit every money-out
      recordAudit(db, {
        entity: 'order',
        entityId: order.id,
        action: 'refund',
        actorId: getOpenId(req),
        actorRole: req.userRole || '',
        before: { refunded_amount: refundedSoFar, status: order.status },
        after: {
          refunded_amount: newRefunded,
          amount,
          full: isFull,
          appliedSuggestion,
          clawback: clawback || null,
          reason,
          payment_id: paymentId,
        },
      });

      return { ok: true, amount, full: isFull, reason };
    })();

    if (result.err) return res.json(fail(result.err));
    if (result.conflict) return res.json(fail('退款处理冲突，请稍后重试'));
    if (result.mismatch) {
      return res.json(fail(
        `退款金额与退费规则建议(¥${result.suggested})不符：${result.reason}。如确认偏离规则请勾选「按规则外金额退款」`
      ));
    }
    res.json(success({ refunded: true, refundAmount: result.amount, full: result.full, reason: result.reason, clawback }));
  } catch (err) {
    console.error('[orders refund]', err);
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * PUT /api/orders/:id — 修改订单（管理员）：金额 / 签单人 / 备注
 * 金额与支付流水变更在同一事务内完成，避免 payments 与 orders 撕裂产生对账差异
 */
router.put('/:id', (req, res) => {
  try {
    if (!canSales(req)) return res.status(403).json(safeFail('无订单修改权限'));
    const { id } = req.params;
    const { payableAmount, salesperson, remark } = req.body;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.json(fail('订单不存在'));
    if (order.status === 'refunded' || order.status === 'cancelled') {
      return res.json(fail('已取消或已退款的订单不可修改'));
    }

    const fields = [];
    const params = [];
    let syncPaymentAmount = null;
    if (payableAmount !== undefined) {
      const amount = Number(payableAmount);
      if (!isFinite(amount) || amount < 0) return res.json(fail('金额不合法'));
      // Never below what was already refunded
      const refundedSoFar = Number(order.refunded_amount) || 0;
      if (amount < refundedSoFar) return res.json(fail(`金额不能低于已退款金额 ¥${refundedSoFar}`));
      fields.push('payable_amount = ?');
      params.push(amount);
      syncPaymentAmount = amount;
    }
    if (salesperson !== undefined) { fields.push('salesperson = ?'); params.push(String(salesperson)); }
    if (remark !== undefined) { fields.push('remark = ?'); params.push(String(remark)); }
    if (fields.length === 0) return res.json(fail('没有需要修改的内容'));

    const prevPayable = Number(order.payable_amount) || 0;
    params.push(now(), id);
    // 改价与支付流水同步必须同事务：中途失败会留下「订单已改价、流水仍旧金额」的对账裂缝
    db.transaction(() => {
      if (syncPaymentAmount !== null) {
        db.prepare('UPDATE payments SET amount = ? WHERE order_id = ?').run(syncPaymentAmount, id);
      }
      db.prepare(`UPDATE orders SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);

      // 改价直接改写应收金额并同步支付流水，无痕则事后无法追责；
      // 仅在 payableAmount 确实变化时才留痕，改备注/签单人这类操作不产生审计噪音
      if (syncPaymentAmount !== null && syncPaymentAmount !== prevPayable) {
        recordAudit(db, {
          entity: 'order',
          entityId: id,
          action: 'update_amount',
          actorId: getOpenId(req),
          actorRole: req.userRole || '',
          before: { payableAmount: prevPayable, salesperson: order.salesperson, remark: order.remark },
          after: {
            payableAmount: syncPaymentAmount,
            salesperson: salesperson !== undefined ? String(salesperson) : order.salesperson,
            remark: remark !== undefined ? String(remark) : order.remark,
          },
        });
      }
    })();
    res.json(success({ id }));
  } catch (err) {
    console.error('[orders update]', err);
    res.status(500).json(safeFail('修改订单失败，请稍后重试'));
  }
});

/**
 * POST /api/orders/:id/cancel — 取消订单（管理员）
 * 已支付订单取消时：回滚会员卡、回收赠送积分、标记支付记录
 */
router.post('/:id/cancel', (req, res) => {
  try {
    const { id } = req.params;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.json(fail('订单不存在'));
    if (order.status === 'cancelled' || order.status === 'refunded') {
      return res.json(fail('订单已取消或已退款'));
    }

    // 权限：管理员/销售可取消任意订单；家长只能取消自己的待支付订单
    if (!canSales(req)) {
      const openid = getOpenId(req);
      const isOwner = openid && db.prepare(`
        SELECT 1 FROM orders o
        JOIN parent_bindings pb ON pb.student_id = o.student_id
        WHERE o.id = ? AND pb.parent_openid = ?
        LIMIT 1
      `).get(id, openid);
      if (!isOwner || order.status !== 'pending') {
        return res.status(403).json(safeFail('仅可取消自己的待支付订单'));
      }
    }

    const currentTime = now();
    // 已支付订单的资金回滚（会员卡、积分、支付流水、订单状态）整体事务化：
    // 中途抛错不再留下「卡已回收但订单仍 paid」的半回滚状态
    db.transaction(() => {
      if (order.status === 'paid') {
        // 回滚会员卡
        const cards = db.prepare("SELECT * FROM member_cards WHERE order_id = ? AND status = 'active'").all(id);
        for (const card of cards) {
          db.prepare("UPDATE member_cards SET status = 'cancelled', updated_at = ? WHERE id = ?").run(currentTime, card.id);
        }
        // 回收购买赠送的积分（按 订单+商品 维度查找）
        const logs = db.prepare("SELECT * FROM point_logs WHERE reference_id GLOB ? AND type = 'earn'").all('order_' + id + '*');
        let totalCancelReward = 0;
        for (const l of logs) {
          totalCancelReward += Number(l.amount) || 0;
          db.prepare("UPDATE point_logs SET type = 'refund', description = '订单取消回收积分' WHERE id = ?").run(l.id);
        }
        if (totalCancelReward > 0) {
          db.prepare(`
            UPDATE points SET
              total_earned = MAX(0, total_earned - ?),
              balance = MAX(0, balance - ?),
              updated_at = ?
            WHERE student_id = ?
          `).run(totalCancelReward, totalCancelReward, currentTime, order.student_id);
        }
        db.prepare("UPDATE payments SET status = 'refunded' WHERE order_id = ?").run(id);
      }

      db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(currentTime, id);
      if (order.status === 'paid') {
        // Cancelling a paid order rolls back money — same audit as refund
        recordAudit(db, {
          entity: 'order',
          entityId: id,
          action: 'cancel_paid',
          actorId: getOpenId(req),
          actorRole: req.userRole || '',
          before: { status: 'paid', payable_amount: order.payable_amount },
          after: { status: 'cancelled' },
        });
      }
    })();
    res.json(success({ cancelled: true }));
  } catch (err) {
    console.error('[orders cancel]', err);
    res.status(500).json(safeFail('取消订单失败，请稍后重试'));
  }
});

/**
 * GET /api/orders/stats — 营收汇总（管理员/销售）
 * 返回今日/本月/本年净营收（已支付订单，且已扣除退款金额），覆盖全量订单而非当前分页。
 * 用于销售单列表顶部的统计卡片，避免“只看当前页 10 行”导致金额严重少算。
 */
router.get('/stats', (req, res) => {
  try {
    if (!canSales(req)) return res.status(403).json(safeFail('无销售查看权限'));
    const today = formatDate(now());
    const month = today.slice(0, 7);
    const year = today.slice(0, 4);
    const q = (sql, ...p) => db.prepare(sql).get(...p).t;
    // 'localtime' 口径不可省略：today/month/year 由 formatDate() 按本机时区生成。
    // E3：谓词由 date(paid_at/1000,'unixepoch','localtime') = ? 改为 paid_at 毫秒区间（半开），
    // 前者是表达式谓词、用不上 idx_orders_paid_at，每次 /stats 全表扫三遍。
    const todayAmount = q(`SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount,0)),0) as t FROM orders WHERE status='paid' AND paid_at >= ? AND paid_at < ?`, dayStartMs(today), dayEndMs(today));
    const monthAmount = q(`SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount,0)),0) as t FROM orders WHERE status='paid' AND paid_at >= ? AND paid_at < ?`, monthStartMs(month), nextMonthStartMs(month));
    const yearAmount = q(`SELECT COALESCE(SUM(payable_amount - COALESCE(refunded_amount,0)),0) as t FROM orders WHERE status='paid' AND paid_at >= ? AND paid_at < ?`, yearStartMs(year), nextYearStartMs(year));
    res.json(success({ today: todayAmount, month: monthAmount, year: yearAmount }));
  } catch (err) {
    console.error('[orders stats]', err);
    res.status(500).json(safeFail('获取营收统计失败'));
  }
});

/**
 * GET /api/orders — 订单列表（管理员）
 * Query: { status, studentId, page, pageSize }
 */
router.get('/', (req, res) => {
  try {
    if (!canSales(req)) return res.status(403).json(safeFail('无销售查看权限'));
    const { status, studentId, startDate, endDate } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);

    let where = 'WHERE 1=1';
    const params = [];

    if (status) { where += ' AND status = ?'; params.push(status); }
    if (studentId) { where += ' AND student_id = ?'; params.push(studentId); }
    // E3：日期筛选改为 paid_at 毫秒区间（半开），命中 idx_orders_paid_at，避免全表扫描
    if (startDate) { where += ' AND paid_at >= ?'; params.push(dayStartMs(startDate)); }
    if (endDate) { where += ' AND paid_at < ?'; params.push(dayEndMs(endDate)); }

    const total = db.prepare(`SELECT COUNT(*) as count FROM orders o ${where.replace('WHERE', 'WHERE')}`).get(...params).count;
    const list = db.prepare(`
      SELECT o.*,
        (SELECT pb.parent_phone FROM parent_bindings pb WHERE pb.student_id = o.student_id ORDER BY pb.is_main DESC, pb.id ASC LIMIT 1) AS parent_phone
      FROM orders o ${where}
      ORDER BY o.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json(success({
      list: list.map((o) => ({
        ...o,
        item_name: parseOrderItems(o.items),
      })),
      total, page, pageSize
    }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

// 供支付回调等路径复用：仅在订单已 paid 后授予会员卡/积分（不在本模块外重复标记订单状态）
router.grantOrderBenefits = grantOrderBenefits;

module.exports = router;
