/**
 * 会员卡路由 — 会员卡类型管理、激活、扣课、退卡
 * POST /api/membership/card-type  — 创建会员卡类型
 * POST /api/membership/activate   — 激活会员卡
 * GET  /api/membership/my         — 我的会员卡
 * POST /api/membership/deduct     — 扣课
 * POST /api/membership/refund     — 退卡退费
 * GET  /api/membership/expiring   — 即将到期列表
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, now, isAdminReq, isCoachReq, canViewStudentData, calcCardExpiresAt } = require('../utils');

// schema 列（paused_at/billing_mode/points_reward/product_type 等）已收编至 migrations/011；
// 此处仅保留数据回填。
// 按卡类型名称回填默认赠送积分（体验10 / 月20 / 季50 / 年120）
try {
  db.prepare(`
    UPDATE membership_cards SET points_reward = CASE
      WHEN name LIKE '%体验%' THEN 10
      WHEN name LIKE '%月%' THEN 20
      WHEN name LIKE '%季%' THEN 50
      WHEN name LIKE '%年%' THEN 120
      ELSE points_reward END
    WHERE points_reward = 0
  `).run();
} catch (e) { /* 忽略 */ }

// 首次启用商品类型：把原 uniform_price 迁移为一条「训练球服」实物商品（仅当不存在 goods 记录时执行一次）
try {
  const hasGoods = db.prepare("SELECT COUNT(*) c FROM membership_cards WHERE product_type = 'goods'").get().c;
  if (!hasGoods) {
    const uniformRow = db.prepare("SELECT value FROM settings WHERE key = 'uniform_price'").get();
    const uniformPrice = Number(uniformRow?.value) || 60;
    const id = 'GD-UNIFORM-' + Date.now().toString(36).toUpperCase();
    db.prepare(`
      INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, is_active, product_type, unit, description, created_at)
      VALUES (?, '训练球服', 0, 0, 'goods', 0, ?, '', 0, 1, 1, 'goods', '套', '训练比赛用球服，可联系客服选购尺码', ?)
    `).run(id, uniformPrice, Date.now());
  }
} catch (e) { console.warn('[membership] uniform goods migration failed:', e.message); }

// 权限判断：管理员或该成员的绑定家长
function canManageCard(req, card) {
  const openid = getOpenId(req);
  if (!openid) return false;
  if (req.userRole === 'admin') return true;
  const u = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
  if (u && u.role === 'admin') return true;
  const bind = db.prepare('SELECT 1 FROM parent_bindings WHERE parent_openid = ? AND student_id = ?').get(openid, card.student_id);
  return !!bind;
}

/**
 * POST /api/membership/pause — 暂停会员卡（暂停期间不计入有效期）
 * Body: { cardId, reason }
 */
router.post('/pause', (req, res) => {
  try {
    const { cardId, reason = '' } = req.body;
    if (!cardId) return res.json(fail('缺少会员卡 ID'));
    const card = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(cardId);
    if (!card) return res.json(fail('会员卡不存在'));
    if (!canManageCard(req, card)) return res.status(403).json(safeFail('无权操作该会员卡'));
    if (card.status !== 'active') return res.json(fail('仅进行中的会员卡可暂停'));

    const currentTime = now();
    db.prepare(`
      UPDATE member_cards SET status = 'paused', paused_at = ?, pause_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(currentTime, reason, currentTime, cardId);

    res.json(success({ id: cardId, status: 'paused', pausedAt: currentTime }));
  } catch (err) {
    console.error('[pause card]', err);
    res.status(500).json(safeFail('暂停会员卡失败'));
  }
});

/**
 * POST /api/membership/resume — 恢复会员卡并按暂停天数顺延有效期
 * Body: { cardId }
 */
router.post('/resume', (req, res) => {
  try {
    const { cardId } = req.body;
    if (!cardId) return res.json(fail('缺少会员卡 ID'));
    const card = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(cardId);
    if (!card) return res.json(fail('会员卡不存在'));
    if (!canManageCard(req, card)) return res.status(403).json(safeFail('无权操作该会员卡'));
    if (card.status !== 'paused' || !card.paused_at) return res.json(fail('该会员卡未处于暂停状态'));

    const currentTime = now();
    const pausedMs = Math.max(0, currentTime - card.paused_at);
    const newExpiresAt = (card.expires_at || currentTime) + pausedMs;
    const totalPaused = (card.pause_total_ms || 0) + pausedMs;

    db.prepare(`
      UPDATE member_cards SET
        status = 'active',
        paused_at = 0,
        pause_total_ms = ?,
        pause_reason = '',
        expires_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(totalPaused, newExpiresAt, currentTime, cardId);

    res.json(success({
      id: cardId,
      status: 'active',
      pausedDays: Math.round(pausedMs / 86400000),
      totalPausedDays: Math.round(totalPaused / 86400000),
      expiresAt: newExpiresAt,
    }));
  } catch (err) {
    console.error('[resume card]', err);
    res.status(500).json(safeFail('恢复会员卡失败'));
  }
});

/**
 * POST /api/membership/card-type — 创建会员卡类型
 * Body: { name, totalClasses, validDays, billingMode, price, courseScope, transferable, refundable }
 */
router.post('/card-type', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可管理产品'));
    const { name, totalClasses, validDays, billingMode = 'time', price, pointsReward = 0, courseScope, transferable, refundable, productType = 'membership', unit = '', description = '' } = req.body;
    if (!name) return res.json(fail('名称为必填'));
    const type = productType === 'goods' ? 'goods' : 'membership';

    if (type === 'goods') {
      const id = generateId('gd_');
      db.prepare(`
        INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, product_type, unit, description, created_at)
        VALUES (?, ?, 0, 0, 'goods', ?, ?, '', 0, 1, 'goods', ?, ?, ?)
      `).run(id, name, pointsReward || 0, price || 0, unit || '', description || '', now());
      return res.json(success({ id, productType: 'goods' }));
    }

    const mode = billingMode === 'count' ? 'count' : 'time';
    if (mode === 'count') {
      if (!totalClasses || totalClasses <= 0) return res.json(fail('次数制卡必须设置总次数'));
    } else {
      if (!validDays || validDays <= 0) return res.json(fail('时效制卡必须设置有效天数'));
    }

    const id = generateId('ct_');
    db.prepare(`
      INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, product_type, unit, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'membership', '', ?, ?)
    `).run(id, name, mode === 'count' ? totalClasses : 0, validDays || 0, mode, pointsReward || 0, price || 0, courseScope || '', transferable ? 1 : 0, refundable !== false ? 1 : 0, description || '', now());

    res.json(success({ id, billingMode: mode }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/membership/card-types — 会员卡类型列表
 */
router.get('/card-types', (req, res) => {
  try {
    const { type } = req.query;
    let sql = `SELECT id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, is_active, product_type, unit, description
      FROM membership_cards`;
    const params = [];
    if (type === 'membership' || type === 'goods') {
      sql += ' WHERE product_type = ?';
      params.push(type);
    }
    sql += ' ORDER BY product_type ASC, price ASC';
    const list = db.prepare(sql).all(...params);
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail("获取产品列表失败"));
  }
});

/**
 * GET /api/membership/products — 小程序产品服务列表（含球服与客服电话）
 */
router.get('/products', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, name, valid_days, total_classes, billing_mode, points_reward, price, course_scope, product_type, unit, description
      FROM membership_cards WHERE is_active = 1 ORDER BY product_type ASC, price ASC
    `).all();
    const servicePhone = db.prepare("SELECT value FROM settings WHERE key = 'service_phone'").get()?.value || '';
    const tags = ['热门', '推荐', '超值', ''];

    const list = rows.map((c, i) => {
      const isGoods = c.product_type === 'goods' || c.billing_mode === 'goods';
      if (isGoods) {
        return {
          id: c.id,
          name: c.name,
          desc: c.description || '',
          price: c.price,
          billingMode: 'goods',
          unit: c.unit || '件',
          pointsReward: c.points_reward || 0,
          tag: '',
        };
      }
      const mode = c.billing_mode || 'time';
      return {
        id: c.id,
        name: c.name,
        desc: mode === 'count'
          ? `${c.total_classes}次 · ${c.valid_days}天内有效`
          : `${c.valid_days}天不限次数`,
        price: c.price,
        billingMode: mode,
        pointsReward: c.points_reward || 0,
        tag: tags[i % tags.length],
      };
    });

    res.json(success({ list, servicePhone }));
  } catch (err) {
    res.status(500).json(safeFail("获取产品列表失败"));
  }
});

/**
 * PUT /api/membership/card-type/:id — 更新会员卡类型（价格、课时、有效期等）
 */
router.put('/card-type/:id', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可管理产品'));
    const { name, totalClasses, validDays, billingMode, price, pointsReward, courseScope, transferable, refundable, isActive, productType, unit, description } = req.body;
    const existing = db.prepare('SELECT id, product_type FROM membership_cards WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('产品不存在'));
    const isGoods = productType === 'goods' || existing.product_type === 'goods';

    if (isGoods) {
      db.prepare(`
        UPDATE membership_cards SET
          name = COALESCE(?, name),
          points_reward = COALESCE(?, points_reward),
          price = COALESCE(?, price),
          unit = COALESCE(?, unit),
          description = COALESCE(?, description),
          is_active = COALESCE(?, is_active)
        WHERE id = ?
      `).run(name, pointsReward, price, unit, description, isActive, req.params.id);
    } else {
      db.prepare(`
        UPDATE membership_cards SET
          name = COALESCE(?, name),
          total_classes = COALESCE(?, total_classes),
          valid_days = COALESCE(?, valid_days),
          billing_mode = COALESCE(?, billing_mode),
          points_reward = COALESCE(?, points_reward),
          price = COALESCE(?, price),
          course_scope = COALESCE(?, course_scope),
          transferable = COALESCE(?, transferable),
          refundable = COALESCE(?, refundable),
          description = COALESCE(?, description),
          is_active = COALESCE(?, is_active)
        WHERE id = ?
      `).run(name, totalClasses, validDays, billingMode, pointsReward, price, courseScope, transferable, refundable, description, isActive, req.params.id);
    }

    res.json(success({ id: req.params.id }));
  } catch (err) {
    res.status(500).json(safeFail("更新会员卡类型失败"));
  }
});

/**
 * DELETE /api/membership/card-type/:id — 停用会员卡类型
 */
router.delete('/card-type/:id', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可管理产品'));
    const existing = db.prepare('SELECT id FROM membership_cards WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('会员卡类型不存在'));
    db.prepare('UPDATE membership_cards SET is_active = 0 WHERE id = ?').run(req.params.id);
    res.json(success({ id: req.params.id }));
  } catch (err) {
    res.status(500).json(safeFail("停用会员卡类型失败"));
  }
});

/**
 * POST /api/membership/activate — 激活会员卡
 * 根据会员卡类型创建一张新的会员卡实例
 * Body: { cardTypeId, studentId, orderId }
 */
router.post('/activate', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可激活会员卡'));
    const { cardTypeId, studentId, orderId } = req.body;
    if (!cardTypeId || !studentId) return res.json(fail('缺少卡类型或成员'));

    const cardType = db.prepare('SELECT * FROM membership_cards WHERE id = ?').get(cardTypeId);
    if (!cardType) return res.json(fail('会员卡类型不存在'));

    const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
    if (!student) return res.json(fail('成员不存在'));

    const id = generateId('mc_');
    const activatedAt = now();
    const expiresAt = calcCardExpiresAt(activatedAt, cardType.valid_days, cardType.billing_mode || 'time');

    db.prepare(`
      INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name,
        total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?, ?)
    `).run(id, cardTypeId, cardType.name, cardType.billing_mode || 'time', studentId, student.name,
      cardType.total_classes, cardType.total_classes,
      activatedAt, expiresAt, orderId || '', now(), now());

    res.json(success({ id, cardTypeName: cardType.name, billingMode: cardType.billing_mode || 'time', totalClasses: cardType.total_classes, expiresAt }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/membership/my — 我的会员卡
 * Query: { studentId } 或通过 openid 查询绑定成员的卡
 */
router.get('/my', (req, res) => {
  try {
    const openid = getOpenId(req);
    const { studentId } = req.query;

    let cards;
    if (studentId) {
      // 防越权：家长仅可查看自己绑定的成员；管理端工作人员可查看
      if (!canViewStudentData(req, studentId)) {
        return res.status(403).json(safeFail('无权查看该成员的会员卡'));
      }
      cards = db.prepare('SELECT * FROM member_cards WHERE student_id = ? ORDER BY created_at DESC').all(studentId);
    } else if (openid) {
      cards = db.prepare(`
        SELECT mc.* FROM member_cards mc
        JOIN parent_bindings pb ON pb.student_id = mc.student_id
        WHERE pb.parent_openid = ?
        ORDER BY mc.created_at DESC
      `).all(openid);
    } else {
      return res.json(fail('缺少参数'));
    }

    // 补充会员中心所需字段：购买时间（激活时间回退创建时间）与累计购买次数（该成员已支付订单数）
    // 单次 GROUP BY 聚合替代逐卡 COUNT（N+1：多孩家庭多卡时每次进会员中心都打一圈查询）
    const studentIds = [...new Set(cards.map((c) => c.student_id))];
    const countMap = {};
    if (studentIds.length) {
      const ph = studentIds.map(() => '?').join(',');
      db.prepare(`
        SELECT student_id, COUNT(*) as count FROM orders
        WHERE student_id IN (${ph}) AND status = 'paid' GROUP BY student_id
      `).all(...studentIds).forEach((r) => { countMap[r.student_id] = r.count; });
    }
    const enriched = cards.map((c) => ({
      ...c,
      purchased_at: c.activated_at || c.created_at || null,
      purchase_count: countMap[c.student_id] || 0,
    }));

    res.json(success(enriched));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * POST /api/membership/deduct — 扣课
 * Body: { scheduleId, studentId, cardId, classes }
 * 幂等：同一 scheduleId + studentId 只扣一次
 */
router.post('/deduct', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可扣课'));
    const { scheduleId, studentId, cardId, classes = 1 } = req.body;
    if (!scheduleId || !studentId) return res.json(fail('缺少参数'));
    // 扣课数量必须为正整数：负数会把「扣课」变成反向充值（remaining - (-N) = +N），凭空膨胀课时资产
    const n = Number(classes);
    if (!Number.isInteger(n) || n <= 0) return res.json(fail('扣课数量必须为正整数'));

    // 幂等检查
    const existing = db.prepare(
      'SELECT * FROM deduction_logs WHERE schedule_id = ? AND student_id = ?'
    ).get(scheduleId, studentId);
    if (existing) return res.json(fail('已扣过训练时长，无需重复扣课'));

    // 查找学员当前生效的会员卡（优先指定卡）
    let card = cardId
      ? db.prepare('SELECT * FROM member_cards WHERE id = ? AND student_id = ?').get(cardId, studentId)
      : db.prepare(
          "SELECT * FROM member_cards WHERE student_id = ? AND status = 'active' AND expires_at > ? ORDER BY expires_at ASC LIMIT 1"
        ).get(studentId, now());

    if (!card) return res.json(fail('没有可用会员卡'));

    // 时效制会员：无需扣课，直接记录出席即可（日志与幂等检查同事务，防并发重复记录）
    const mode = card.billing_mode || 'time';
    if (mode === 'time') {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO deduction_logs (schedule_id, student_id, card_id, deducted_at)
          SELECT ?, ?, ?, ? WHERE NOT EXISTS (
            SELECT 1 FROM deduction_logs WHERE schedule_id = ? AND student_id = ?
          )
        `).run(scheduleId, studentId, card.id, now(), scheduleId, studentId);
      })();
      return res.json(success({ cardId: card.id, mode: 'time', deducted: 0, message: '时效制会员无需扣课' }));
    }

    // 查找可用会员卡
    if (card.remaining_classes < n) return res.json(fail('剩余训练时长不足'));

    // 扣课 + 日志同事务；UPDATE 带 remaining >= n 条件守卫，
    // 杜绝并发扣同一张卡把余额扣成负数（检查与扣减之间的竞态）
    const deductOutcome = db.transaction(() => {
      const dup = db.prepare('SELECT 1 FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').get(scheduleId, studentId);
      if (dup) return { err: '已扣过训练时长，无需重复扣课' };
      const upd = db.prepare(`
        UPDATE member_cards SET remaining_classes = remaining_classes - ?, used_classes = used_classes + ?, updated_at = ?
        WHERE id = ? AND remaining_classes >= ?
      `).run(n, n, now(), card.id, n);
      if (upd.changes === 0) return { err: '剩余训练时长不足' };
      db.prepare(`
        INSERT INTO deduction_logs (schedule_id, student_id, card_id, deducted_at)
        VALUES (?, ?, ?, ?)
      `).run(scheduleId, studentId, card.id, now());
      return { cardId: card.id };
    })();
    if (deductOutcome.err) return res.json(fail(deductOutcome.err));

    const updatedCard = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(deductOutcome.cardId);
    res.json(success({
      cardId: card.id,
      mode: 'count',
      remainingClasses: updatedCard.remaining_classes,
      usedClasses: updatedCard.used_classes,
      deducted: n,
    }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * POST /api/membership/refund — 退卡退费
 * Body: { cardId, studentId, reason }
 * 退卡：将卡标记为已退款，按比例退还
 */
router.post('/refund', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可办理退卡'));
    const { cardId, studentId, reason } = req.body;
    if (!cardId || !studentId) return res.json(fail('缺少参数'));

    const currentTime = now();

    // 退卡全过程原子处理：重读卡 + 计算退款 + 回收权益 + 标记订单退款
    const result = db.transaction(() => {
      const card = db.prepare('SELECT * FROM member_cards WHERE id = ? AND student_id = ?').get(cardId, studentId);
      if (!card) return { err: '会员卡不存在' };
      if (card.status === 'refunded') return { err: '该卡已退过' };

      // 取得该卡的实际成交价（优先取购卡订单实付，避免按卡类型原价退款造成多退/少退）
      let paidPrice = 0;
      let orderId = null;
      let orderPayable = 0;
      let orderRefundedSoFar = 0;
      if (card.order_id) {
        orderId = card.order_id;
        const order = db.prepare('SELECT items, total_amount, payable_amount, refunded_amount FROM orders WHERE id = ?').get(card.order_id);
        if (order) {
          orderPayable = Number(order.payable_amount) || 0;
          orderRefundedSoFar = Number(order.refunded_amount) || 0;
          try {
            const items = JSON.parse(order.items || '[]');
            // 必须精确匹配本卡商品：旧逻辑回退 items[0] 会把别的热价格算到本卡头上；
            // 订单明细写入字段是 unitPrice（orders.js），旧逻辑读 it.price 永不命中，
            // 再回退整单 payable_amount 会对多明细订单超退。
            const it = items.find(i => i.itemId === card.card_type_id);
            if (it) {
              const qty = Number(it.quantity) || 1;
              const unit = Number(it.unitPrice ?? it.price) || 0;
              const total = Number(it.totalPrice) || 0;
              let base = 0;
              if (unit > 0) base = unit * qty;
              else if (total > 0) base = total;
              if (base > 0) {
                // 按订单实付/原价比例折减：整单有折扣时按标价退会超退
                const orderTotal = Number(order.total_amount) || 0;
                paidPrice = (orderTotal > 0 && orderPayable > 0 && orderPayable < orderTotal)
                  ? Math.round(base * orderPayable / orderTotal)
                  : base;
              }
            }
            // 单明细订单可安全回退整单实付
            if (!paidPrice && items.length === 1 && orderPayable > 0) {
              paidPrice = orderPayable;
            }
          } catch (e) { /* 忽略损坏数据 */ }
        }
      }
      const cardType = db.prepare('SELECT * FROM membership_cards WHERE id = ?').get(card.card_type_id);
      if (!paidPrice && cardType) paidPrice = Number(cardType.price) || 0;

      // 计算退款金额（按计费模式：次数卡按剩余次数比例，时效卡按剩余有效期天数比例）
      // 时效卡分母为「已购总时长」：expires_at 在恢复时会顺延 pause_total_ms，
      // 故总时长 = (expires_at - pause_total_ms) - activated_at，扣除暂停期后才是真实购买时长。
      const mode = card.billing_mode || 'time';
      let refundAmount = 0;
      if (mode === 'count') {
        const pricePerClass = paidPrice > 0 && card.total_classes > 0 ? paidPrice / card.total_classes : 0;
        refundAmount = Math.round(card.remaining_classes * pricePerClass);
      } else {
        const totalMs = ((card.expires_at || 0) - (card.pause_total_ms || 0)) - (card.activated_at || 0);
        const remainMs = Math.max(0, (card.expires_at || 0) - currentTime);
        refundAmount = totalMs > 0 && paidPrice > 0 ? Math.max(0, Math.round(paidPrice * remainMs / totalMs)) : 0;
      }
      // 硬上限：不得超过该订单剩余额退额度（payable − 已退），与 orders/refund 的
      // 「累计退款不能超过订单金额」口径一致。RFND 流水行按本值入账，不会超过原单可退额。
      if (orderId && orderPayable > 0) {
        const room = Math.max(0, orderPayable - orderRefundedSoFar);
        if (refundAmount > room) refundAmount = room;
      }

      // 更新卡状态
      db.prepare("UPDATE member_cards SET status = 'refunded', updated_at = ? WHERE id = ?").run(currentTime, cardId);

      // 回收购买时赠送的积分（仅本卡对应商品的奖励，订单含多商品时不影响其他商品权益）
      if (orderId) {
        const refId = 'order_' + orderId + '_' + card.card_type_id;
        const rewardLogs = db.prepare("SELECT * FROM point_logs WHERE reference_id = ? AND type = 'earn'").all(refId);
        let totalReward = 0;
        for (const log of rewardLogs) {
          totalReward += Number(log.amount) || 0;
          db.prepare("UPDATE point_logs SET type = 'refund', description = '退卡回收积分' WHERE id = ?").run(log.id);
        }
        if (totalReward > 0) {
          db.prepare(`
            UPDATE points SET
              total_earned = MAX(0, total_earned - ?),
              balance = MAX(0, balance - ?),
              updated_at = ?
            WHERE student_id = ?
          `).run(totalReward, totalReward, currentTime, studentId);
        }
        // 原订单累计已退金额增加本次退额；累计达订单金额时整单标记已退（保证财务口径一致）
        db.prepare(`
          UPDATE orders SET
            refunded_amount = MIN(payable_amount, refunded_amount + ?),
            status = CASE WHEN refunded_amount + ? >= payable_amount THEN 'refunded' ELSE status END,
            updated_at = ?
          WHERE id = ? AND status = 'paid'
        `).run(refundAmount, refundAmount, currentTime, orderId);
      }

      // 创建退款订单
      const refundOrderId = generateId('RFND');
      // order_no 有 UNIQUE 约束：同一毫秒内连续退卡/同事务重试时纯时间戳必撞（回归测试实测）
      const orderNo = `RF${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      db.prepare(`
        INSERT INTO orders (id, order_no, student_id, student_name, order_type, items, total_amount, payable_amount, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'refund', ?, ?, ?, 'refunded', ?, ?)
      `).run(refundOrderId, orderNo, studentId, card.student_name, JSON.stringify([{ cardId, reason }]), refundAmount, refundAmount, currentTime, currentTime);

      return { ok: true, refundAmount, orderId: refundOrderId };
    })();

    if (result.err) return res.json(fail(result.err));
    res.json(success({ cardId, refundAmount: result.refundAmount, orderId: result.orderId }));
  } catch (err) {
    console.error('[membership refund]', err);
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/membership/deductions — 扣课明细
 * Query: { studentId, page, pageSize }
 * 不带 studentId 时查询全机构流水，仅限管理端工作人员（与 /expiring 对齐）。
 */
router.get('/deductions', (req, res) => {
  try {
    const { studentId } = req.query;
    // 防越权：指定成员时家长仅可查看自己绑定的成员；
    // 不指定成员即全机构流水，必须限定为工作人员，否则任何登录家长都能拉全量。
    if (studentId) {
      if (!canViewStudentData(req, studentId)) {
        return res.status(403).json(safeFail('无权查看该成员的扣课明细'));
      }
    } else if (!isCoachReq(req)) {
      return res.status(403).json(safeFail('仅管理员或教练可查看全部扣课明细'));
    }
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 10));
    const offset = (page - 1) * pageSize;

    let where = '';
    const params = [];
    if (studentId) { where = 'WHERE d.student_id = ?'; params.push(studentId); }

    const total = db.prepare(`SELECT COUNT(*) as count FROM deduction_logs d ${where}`).get(...params).count;
    const list = db.prepare(`
      SELECT d.id, d.schedule_id, d.student_id, d.card_id, d.deducted_at,
             s.course_name, sc.name as student_name
      FROM deduction_logs d
      LEFT JOIN schedules s ON s.id = d.schedule_id
      LEFT JOIN students sc ON sc.id = d.student_id
      ${where}
      ORDER BY d.deducted_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/membership/expiring — 即将到期列表
 * Query: { days }（默认 30 天）
 */
router.get('/expiring', (req, res) => {
  try {
    // 全机构即将到期列表仅管理端工作人员可见（涉及成员隐私）
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可查看'));
    const days = parseInt(req.query.days) || 30;
    const threshold = now() + days * 24 * 3600 * 1000;

    const list = db.prepare(`
      SELECT mc.*, s.name as student_name_real, s.status as student_status
      FROM member_cards mc
      JOIN students s ON s.id = mc.student_id
      WHERE mc.status = 'active' AND mc.expires_at <= ? AND mc.expires_at > ?
      ORDER BY mc.expires_at ASC
    `).all(threshold, now());

    res.json(success({ count: list.length, list }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

module.exports = router;
