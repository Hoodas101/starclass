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
const { generateId, success, fail, safeFail, getOpenId, getActor, recordAudit, now, isAdminReq, isCoachReq, hasPerm, getReqUser, canViewStudentData, calcCardExpiresAt, parsePagination } = require('../utils');
// 订单明细解析 / 每次课消耗课时数：与签到扣课、导出报表共用同一实现
const { parseItems, itemLineTotal } = require('../utils/items');
const { resolveConsumeClasses } = require('../utils/deduction');
// 退卡与订单退款共用同一套退费规则引擎（refund_rules），避免同一笔钱两条路径两个金额
const { computeRefundSuggestion } = require('../utils/refund');
// 已删除（status='refunded'）/ 已归档学员的统一排除条件（学员表别名须为 s）
const { ACTIVE_STUDENT_SQL } = require('../utils/student-state');

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

    // 暂停改变卡状态与有效期计算口径，需留痕（谁、何时、为何暂停）
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'membership_card',
      entityId: cardId,
      action: 'pause',
      actorId: actor.id,
      actorRole: actor.role,
      before: { status: card.status },
      after: { status: 'paused', reason },
    });

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

    // 恢复会顺延有效期（资产口径变化），需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'membership_card',
      entityId: cardId,
      action: 'resume',
      actorId: actor.id,
      actorRole: actor.role,
      before: { status: card.status, expires_at: card.expires_at || 0 },
      after: { status: 'active', expires_at: newExpiresAt, paused_ms: pausedMs },
    });

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
    const { name, totalClasses, validDays, billingMode = 'time', price, pointsReward = 0, courseScope, transferable, refundable, productType = 'membership', unit = '', description = '', visitLimitPerWeek, visitLimitPerMonth } = req.body;
    if (!name) return res.json(fail('名称为必填'));
    const type = productType === 'goods' ? 'goods' : 'membership';
    // 到店限次（0/NULL = 不限次）；负数与非法值一律归 0
    const vw = Math.max(0, Number(visitLimitPerWeek) || 0);
    const vm = Math.max(0, Number(visitLimitPerMonth) || 0);

    if (type === 'goods') {
      const id = generateId('gd_');
      db.prepare(`
        INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, product_type, unit, description, created_at)
        VALUES (?, ?, 0, 0, 'goods', ?, ?, '', 0, 1, 'goods', ?, ?, ?)
      `).run(id, name, pointsReward || 0, price || 0, unit || '', description || '', now());
      // 产品（卡类型/商品）定价与权益变更影响销售口径，需留痕
      const actor = getActor(req);
      recordAudit(db, {
        entity: 'card_type',
        entityId: id,
        action: 'create',
        actorId: actor.id,
        actorRole: actor.role,
        after: { name, product_type: 'goods', price: price || 0 },
      });
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
      INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, product_type, unit, description, visit_limit_per_week, visit_limit_per_month, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'membership', '', ?, ?, ?, ?)
    `).run(id, name, mode === 'count' ? totalClasses : 0, validDays || 0, mode, pointsReward || 0, price || 0, courseScope || '', transferable ? 1 : 0, refundable !== false ? 1 : 0, description || '', vw, vm, now());

    // 产品（卡类型/商品）定价与权益变更影响销售口径，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'card_type',
      entityId: id,
      action: 'create',
      actorId: actor.id,
      actorRole: actor.role,
      after: {
        name,
        product_type: 'membership',
        billing_mode: mode,
        price: price || 0,
        total_classes: mode === 'count' ? totalClasses : 0,
        valid_days: validDays || 0,
        visit_limit_per_week: vw,
        visit_limit_per_month: vm,
      },
    });

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
    // 读侧与写侧对齐：卡种含定价（price），属销售/管理数据。此前读侧无任何守卫，
    // 教练可读全部卡种价格；写侧（POST/PUT/DELETE）早已 adminOnly —— 读写判据不一致。
    // 管理员与销售（需按卡种下单）可读，其余角色拒绝。
    if (!isAdminReq(req) && !hasPerm(getReqUser(req), 'sales')) {
      return res.status(403).json(safeFail('无权查看产品价格'));
    }
    const { type } = req.query;
    // 带上到店限次字段：管理端产品页需要展示/回填，否则「已设置限次」在列表里看不见
    let sql = `SELECT id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, is_active, product_type, unit, description, visit_limit_per_week, visit_limit_per_month
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
    const { name, totalClasses, validDays, billingMode, price, pointsReward, courseScope, transferable, refundable, isActive, productType, unit, description, visitLimitPerWeek, visitLimitPerMonth } = req.body;
    const existing = db.prepare('SELECT id, product_type FROM membership_cards WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('产品不存在'));
    const isGoods = productType === 'goods' || existing.product_type === 'goods';
    // 到店限次：未传（undefined/null）→ 保持原值（COALESCE 兜底）；显式传值则写库，负数/非法值归 0
    const vw = (visitLimitPerWeek === undefined || visitLimitPerWeek === null) ? null : Math.max(0, Number(visitLimitPerWeek) || 0);
    const vm = (visitLimitPerMonth === undefined || visitLimitPerMonth === null) ? null : Math.max(0, Number(visitLimitPerMonth) || 0);

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
          is_active = COALESCE(?, is_active),
          visit_limit_per_week = COALESCE(?, visit_limit_per_week),
          visit_limit_per_month = COALESCE(?, visit_limit_per_month)
        WHERE id = ?
      `).run(name, totalClasses, validDays, billingMode, pointsReward, price, courseScope, transferable, refundable, description, isActive, vw, vm, req.params.id);
    }

    // 产品（卡类型/商品）定价与权益变更影响销售口径，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'card_type',
      entityId: req.params.id,
      action: 'update',
      actorId: actor.id,
      actorRole: actor.role,
      after: { product_type: isGoods ? 'goods' : 'membership', is_active: isActive === undefined ? null : (isActive ? 1 : 0) },
    });

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
    // 停用产品会使前端不可再售，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'card_type',
      entityId: req.params.id,
      action: 'deactivate',
      actorId: actor.id,
      actorRole: actor.role,
      after: { is_active: 0 },
    });
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

    // 到店限次（每周/每月）随开卡快照到卡实例：与 total_classes / valid_days 同一处理方式，
    // 保证日后调整卡种不追溯改写已售出的卡（已售合同不可单方面变更）。
    const visitLimitPerWeek = Number(cardType.visit_limit_per_week) || 0;
    const visitLimitPerMonth = Number(cardType.visit_limit_per_month) || 0;

    db.prepare(`
      INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name,
        total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id,
        visit_limit_per_week, visit_limit_per_month, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(id, cardTypeId, cardType.name, cardType.billing_mode || 'time', studentId, student.name,
      cardType.total_classes, cardType.total_classes,
      activatedAt, expiresAt, orderId || '', visitLimitPerWeek, visitLimitPerMonth, now(), now());

    // 开卡即产生一项会员资产（课时/有效期），需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'membership_card',
      entityId: id,
      action: 'activate',
      actorId: actor.id,
      actorRole: actor.role,
      after: {
        card_type_id: cardTypeId,
        student_id: studentId,
        billing_mode: cardType.billing_mode || 'time',
        total_classes: cardType.total_classes,
        expires_at: expiresAt,
        order_id: orderId || '',
        visit_limit_per_week: visitLimitPerWeek,
        visit_limit_per_month: visitLimitPerMonth,
      },
    });

    res.json(success({ id, cardTypeName: cardType.name, billingMode: cardType.billing_mode || 'time', totalClasses: cardType.total_classes, expiresAt }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * POST /api/membership/card/:id/transfer — 会员卡转让
 * Body: { toStudentId, reason? }
 *
 * 背景：卡种 ct_003（时效年卡）transferable = 1 已在售，但此前无任何转让入口。
 * 线下转让后系统无记录，受让人上课查无卡 → 扣课失败但考勤已记，账实不符。
 *
 * 历史不可改写：deduction_logs / attendances / orders / revenue_recognitions 一律不动，
 * 转让只改卡的归属（member_cards.student_id）并写一条 card_transfer_logs 流水。
 */
router.post('/card/:id/transfer', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可办理会员卡转让'));
    const cardId = req.params.id;
    const { toStudentId, reason = '' } = req.body;
    if (!toStudentId) return res.json(fail('缺少受让学员'));

    const actor = getActor(req);

    // 转让是有价资产易主：校验 + 改归属 + 写流水整体事务化，避免中途失败留下半转让状态
    const result = db.transaction(() => {
      const card = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(cardId);
      if (!card) return { err: '会员卡不存在' };
      if (card.status !== 'active') return { err: '仅进行中的会员卡可转让' };

      const cardType = db.prepare('SELECT * FROM membership_cards WHERE id = ?').get(card.card_type_id);
      if (!cardType || Number(cardType.transferable) !== 1) return { err: '该卡种不可转让' };

      // 防重/幂等：目标学员已是持卡人即拒绝（同卡不能转给同一人）
      if (toStudentId === card.student_id) return { err: '受让学员不能是原持卡人' };

      // 受让学员必须存在且在册（已删除/已归档不得受让）；学员表别名须为 s
      const toStudent = db.prepare(
        `SELECT s.id, s.name FROM students s WHERE s.id = ? AND ${ACTIVE_STUDENT_SQL}`
      ).get(toStudentId);
      if (!toStudent) return { err: '受让学员不存在或已失效' };

      const currentTime = now();
      db.prepare(`
        UPDATE member_cards SET
          student_id = ?,
          student_name = ?,
          transfer_from_student_id = ?,
          transfer_from_student_name = ?,
          transferred_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(toStudentId, toStudent.name, card.student_id, card.student_name, currentTime, currentTime, cardId);

      // 转让流水：audit_log 的 JSON 快照无法回答「这张卡被转过几次、每次转给谁」，故单表留痕
      db.prepare(`
        INSERT INTO card_transfer_logs (id, card_id, card_type_name, from_student_id, from_student_name,
          to_student_id, to_student_name, remaining_classes, expires_at, reason, operator_id, operator_role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(generateId('CTL'), cardId, card.card_type_name, card.student_id, card.student_name,
        toStudentId, toStudent.name, card.remaining_classes, card.expires_at, reason || '',
        actor.id, actor.role, currentTime);

      return {
        cardId,
        fromStudentId: card.student_id,
        fromStudentName: card.student_name,
        toStudentId,
        toStudentName: toStudent.name,
        transferredAt: currentTime,
      };
    })();

    if (result.err) return res.json(fail(result.err));

    recordAudit(db, {
      entity: 'membership_card',
      entityId: cardId,
      action: 'transfer',
      actorId: actor.id,
      actorRole: actor.role,
      before: { student_id: result.fromStudentId, student_name: result.fromStudentName },
      after: {
        student_id: result.toStudentId,
        student_name: result.toStudentName,
        reason: reason || '',
      },
    });

    res.json(success(result));
  } catch (err) {
    console.error('[membership transfer]', err);
    res.status(500).json(safeFail('会员卡转让失败'));
  }
});

/**
 * GET /api/membership/my — 我的会员卡
 * Query: { studentId } 或通过 openid 查询绑定成员的卡
 */
/**
 * GET /api/membership/cards — 会员卡实例列表（管理端）
 *
 * 与 `/my`（家长/家长视角自己的卡）不同：本接口是**管理视角**的卡台账，
 * 供学员档案页与卡列表展示「到店限次、卡状态、转让来源」等管理字段。
 * 此前前端只能靠 `/my`（按绑定关系取，且不含管理字段）或 `/card-types`
 * （卡种模板，不是卡实例），导致「卡实例」这一层在管理端没有可读接口。
 *
 * 权限：仅管理端工作人员（与 /expiring 同口径）—— 卡实例含学员隐私，
 * 不带 studentId 时是全机构查询，绝不能对家长开放。
 *
 * 路由顺序：**必须注册在 `/my` 之前**。`/cards` 与 `/card/:id/transfer`
 * 是不同前缀段，当前不会互相吞掉；但放在此处可避免日后新增
 * `/:id` 形态的动态路由时被误匹配。
 */
router.get('/cards', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可查看会员卡'));

    const { studentId, status } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);

    const where = [];
    const params = [];
    if (studentId) { where.push('student_id = ?'); params.push(studentId); }
    if (status) { where.push('status = ?'); params.push(status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS count FROM member_cards ${whereSql}`).get(...params).count;
    const list = db.prepare(`
      SELECT id, card_type_id, card_type_name, student_id, student_name, billing_mode,
        total_classes, remaining_classes, used_classes, activated_at, expires_at,
        status, order_id, visit_limit_per_week, visit_limit_per_month,
        transfer_from_student_id, transfer_from_student_name, transferred_at,
        created_at, updated_at
      FROM member_cards ${whereSql}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    console.error('[membership cards]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail('获取会员卡列表失败'));
  }
});

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
    const { scheduleId, studentId, cardId, classes } = req.body;
    if (!scheduleId || !studentId) return res.json(fail('缺少参数'));
    // 扣课数量：显式入参优先；未传时取排期所属课程的 courses.consume_classes（缺省 1）。
    // 此前该字段默认 1，而签到扣课路径也硬编码 1 —— 两条路径都不读配置，
    // 于是配置为「每次消耗 2 课时」的课程永远只扣 1，卡内余额被系统性高估。
    // 两条路径现在统一走 utils/deduction.resolveConsumeClasses。
    const n = (classes === undefined || classes === null || classes === '')
      ? resolveConsumeClasses(scheduleId)
      : Number(classes);
    // 扣课数量必须为正整数：负数会把「扣课」变成反向充值（remaining - (-N) = +N），凭空膨胀课时资产
    if (!Number.isInteger(n) || n <= 0) return res.json(fail('扣课数量必须为正整数'));

    // 幂等检查
    const existing = db.prepare(
      'SELECT * FROM deduction_logs WHERE schedule_id = ? AND student_id = ?'
    ).get(scheduleId, studentId);
    if (existing) return res.json(fail('已扣过训练时长，无需重复扣课'));
    // 两套账本交叉校验：请假审批扣课写的是 leave_deduction_logs（mode='class'），
    // 与本接口的 deduction_logs 不是同一张表。此前只查本表，于是
    // 「学员请假获批已扣课 → 管理员在后台手工补扣」会把同一节课扣两次。
    // 签到路径 applyArrivalDeduction（checkin.js:322）已有同款校验，此处此前漏了。
    // 只拦 mode='class'：mode='days' 扣的是时效卡有效期，并未消课时，不构成重复扣课。
    const leaveDed = db.prepare(
      "SELECT 1 FROM leave_deduction_logs WHERE schedule_id = ? AND student_id = ? AND mode = 'class'"
    ).get(scheduleId, studentId);
    if (leaveDed) return res.json(fail('该场次已按请假规则扣过课时，无需重复扣课'));

    // 查找学员当前生效的会员卡（优先指定卡）
    // 显式指定 cardId 时也必须校验 status = 'active'：订单全额退款只把卡标记为 status='refunded'，
    // 并不会清零 remaining_classes，若不校验 status，学员拿回全额退款后仍可显式传该卡 id 继续扣课时。
    // 显式路径还必须校验有效期（expires_at > now）：自动选卡路径一直带此条件，
    // 显式路径此前漏了，于是已过期卡在过期窗口内（最长 24h）仍可被手工扣课。
    let card;
    if (cardId) {
      card = db.prepare("SELECT * FROM member_cards WHERE id = ? AND student_id = ? AND status = 'active'").get(cardId, studentId);
      // 卡存在但已过期 → 给出明确原因，而不是笼统的「没有可用会员卡」
      if (card && !(Number(card.expires_at) > now())) {
        return res.json(fail('该卡已过期'));
      }
    } else {
      // 自动选卡路径口径不变（由另一处统一收敛）
      card = db.prepare(
        "SELECT * FROM member_cards WHERE student_id = ? AND status = 'active' AND expires_at > ? ORDER BY expires_at ASC LIMIT 1"
      ).get(studentId, now());
    }

    if (!card) return res.json(fail('没有可用会员卡'));

    // 时效制会员：无需扣课，直接记录出席即可（日志与幂等检查同事务，防并发重复记录）
    const mode = card.billing_mode || 'time';
    if (mode === 'time') {
      db.transaction(() => {
        // 时效制不消耗课时，count 记 0：回滚路径据此判断「本次没有真实消课」。
        // 注意：SQL 里的注释必须写成 -- 而非 //，否则 SQLite 报 syntax error。
        db.prepare(`
          INSERT INTO deduction_logs (schedule_id, student_id, card_id, deducted_at, count)
          SELECT ?, ?, ?, ?, 0 WHERE NOT EXISTS (
            SELECT 1 FROM deduction_logs WHERE schedule_id = ? AND student_id = ?
          )
        `).run(scheduleId, studentId, card.id, now(), scheduleId, studentId);
      })();
      // 扣课会消耗卡内资产，需留痕（时效制不扣课时，但落了出席流水）
      const actor = getActor(req);
      recordAudit(db, {
        entity: 'membership_card',
        entityId: card.id,
        action: 'deduct',
        actorId: actor.id,
        actorRole: actor.role,
        after: { mode: 'time', deducted: 0, schedule_id: scheduleId, student_id: studentId },
      });
      return res.json(success({ cardId: card.id, mode: 'time', deducted: 0, message: '时效制会员无需扣课' }));
    }

    // 查找可用会员卡
    if (card.remaining_classes < n) return res.json(fail('剩余训练时长不足'));

    // 扣课 + 日志同事务；UPDATE 带 remaining >= n 条件守卫，
    // 杜绝并发扣同一张卡把余额扣成负数（检查与扣减之间的竞态）
    const deductOutcome = db.transaction(() => {
      const dup = db.prepare('SELECT 1 FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').get(scheduleId, studentId);
      if (dup) return { err: '已扣过训练时长，无需重复扣课' };
      // 与上方前置检查同口径：事务内复查一次，防「请假记录是在本次检查之后才写入」的并发窗口
      const dupLeave = db.prepare(
        "SELECT 1 FROM leave_deduction_logs WHERE schedule_id = ? AND student_id = ? AND mode = 'class'"
      ).get(scheduleId, studentId);
      if (dupLeave) return { err: '该场次已按请假规则扣过课时，无需重复扣课' };
      const upd = db.prepare(`
        UPDATE member_cards SET remaining_classes = remaining_classes - ?, used_classes = used_classes + ?, updated_at = ?
        WHERE id = ? AND remaining_classes >= ?
      `).run(n, n, now(), card.id, n);
      if (upd.changes === 0) return { err: '剩余训练时长不足' };
      // 一次扣课只落一行流水：deduction_logs 上有 UNIQUE(schedule_id, student_id)，
      // 消耗 N 课时不写成 N 行，而是记在 count 列（迁移 019）。
      // 这对「显式传 classes=N 的手动扣课」尤其关键：此前回滚路径按课程配置
      // 重新推导出 1，于是手动扣 3 节后撤销只退 1 节，学员白丢 2 节。
      db.prepare(`
        INSERT INTO deduction_logs (schedule_id, student_id, card_id, deducted_at, count)
        VALUES (?, ?, ?, ?, ?)
      `).run(scheduleId, studentId, card.id, now(), n);
      return { cardId: card.id };
    })();
    if (deductOutcome.err) return res.json(fail(deductOutcome.err));

    const updatedCard = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(deductOutcome.cardId);
    // 扣课消耗卡内课时资产，需留痕（含扣减前后余额，便于对账）
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'membership_card',
      entityId: card.id,
      action: 'deduct',
      actorId: actor.id,
      actorRole: actor.role,
      before: { remaining_classes: card.remaining_classes, used_classes: card.used_classes },
      after: {
        remaining_classes: updatedCard.remaining_classes,
        used_classes: updatedCard.used_classes,
        deducted: n,
        schedule_id: scheduleId,
        student_id: studentId,
      },
    });
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
      // 已随订单取消的卡不得再退费：orders.js 的取消已支付订单分支（cancel_paid）会把
      // 该单支付流水整体置为 refunded、回收赠送积分并把卡置为 'cancelled'，语义上钱已退回。
      // 此处若放行，会形成第二笔真实现金支出；且原单状态已非 paid，退款额也挂不上原单
      // （见下方载体订单注释），等于一笔支出无人知晓。
      if (card.status === 'cancelled') return { err: '该卡已随订单取消，不可再退费' };

      // 卡类型（membership_cards）上的 refundable 是机构对「这类卡能不能退」的开关：
      // 此前该字段全仓无任何代码读取（死字段），退卡接口可绕过卡类型设置强行退款。
      const cardType = db.prepare('SELECT * FROM membership_cards WHERE id = ?').get(card.card_type_id);
      if (cardType && cardType.refundable === 0) return { err: '该卡按卡类型设置不可退' };

      // 取得该卡的实际成交价（优先取购卡订单实付，避免按卡类型原价退款造成多退/少退）
      let paidPrice = 0;
      let orderId = null;
      let orderPayable = 0;
      let orderRefundedSoFar = 0;
      // 整单折扣比例（实付 / 标价）：<1 表示整单有折扣，按标价退会超退
      let discountRatio = 1;
      let order = null; // 规则引擎需要完整订单对象（id / payable_amount / refunded_amount）
      if (card.order_id) {
        orderId = card.order_id;
        // status 必须一并取出：下方决定是否把退款额累加回原订单时要用 order.status 判断，
        // 少了它该判断恒为 undefined === 'paid' → false，导致每笔退卡都改走载体订单分支、
        // 原订单的 refunded_amount 再也不累加（订单永远停留在 paid，财务口径断裂）。
        order = db.prepare('SELECT id, items, total_amount, payable_amount, refunded_amount, status FROM orders WHERE id = ?').get(card.order_id);
        if (order) {
          orderPayable = Number(order.payable_amount) || 0;
          orderRefundedSoFar = Number(order.refunded_amount) || 0;
          const orderTotal = Number(order.total_amount) || 0;
          discountRatio = (orderTotal > 0 && orderPayable > 0 && orderPayable < orderTotal)
            ? orderPayable / orderTotal : 1;
          // items 解析统一走 utils/items：兼容「数组元素为 JSON 字符串」的双重编码形态。
          // 旧实现直接 JSON.parse 后 items.find(i => i.itemId === card.card_type_id)，
          // 双重编码时元素是字符串、根本没有 itemId，必然落空 → 退化为卡类型**标价**，
          // 既忽略整单折扣也忽略真实实付，多明细订单会多退或少退。
          const items = parseItems(order.items);
          // 必须精确匹配本卡商品：旧逻辑回退 items[0] 会把别的商品价格算到本卡头上。
          // 优先 itemId（orders.js 写入字段）；历史脏数据可能缺 itemId，退而按卡类型名匹配。
          const it = items.find((i) => i.itemId && i.itemId === card.card_type_id)
            || items.find((i) => i.itemName && i.itemName === card.card_type_name);
          const base = it ? itemLineTotal(it) : 0;
          if (base > 0) {
            paidPrice = discountRatio < 1 ? Math.round(base * discountRatio) : base;
          }
          // 单明细订单可安全回退整单实付
          if (!paidPrice && items.length === 1 && orderPayable > 0) {
            paidPrice = orderPayable;
          }
        }
      }
      // 【资金安全】本卡是否存在「已支付」的收款订单 —— 退款的唯一合法依据。
      // 后台直接激活的卡（order_id = ''）从未收款；订单行缺失、或订单已非 paid
      // （已取消 / 已退完）同样意味着「这笔钱不在账上」。此时绝不允许产生任何退款额：
      // 否则下方兜底会拿卡类型**标价**算出 paidPrice，再经退费规则生成 refundAmount，
      // 最终落地成 refund_standalone 载体订单（payable=0、refunded=退款额、paid_at=当前）——
      // 钱从未流入，却凭空产生一笔真实现金流出，财务报表现金净额被侵蚀。
      const hasPaidOrder = !!(orderId && order && order.status === 'paid');

      // 最后兜底：连订单明细都拿不到时用卡类型标价，但仍按整单折扣比例折减
      // （旧实现直接取标价，折扣单会按原价退 → 超退）。
      // 仅在有已支付订单时才允许此兜底：无收款记录的卡不存在「可退的成交价」。
      if (!paidPrice && cardType && hasPaidOrder) {
        const base = Number(cardType.price) || 0;
        paidPrice = discountRatio < 1 ? Math.round(base * discountRatio) : base;
      }

      // 退款金额：卡关联订单存在时走与订单退款同一套退费规则（refund_rules 的
      // beforeStart/afterStart 百分比、以及 unused 模式按剩余比例），使同一笔钱在
      // /api/orders/:id/refund 与 /api/membership/refund 不再算出两个金额。
      //
      // 但**基数是本卡的折后成交价 paidPrice**，不是整单剩余额：规则引擎返回的 amount 是
      // 「整单剩余可退额 × 规则比例」，直接采用会把同一订单中其他商品的份额退到本卡头上
      // （多明细/多卡订单超退）。故这里只取规则比例因子 refundFactor 再乘本卡价。
      // 传 cardId 是必需的：否则引擎按 `ORDER BY created_at DESC LIMIT 1` 取卡，
      // 多卡订单会取到别的卡、按其消耗状态定价。
      let refundAmount = 0;
      let ruleApplied = false;
      if (order && paidPrice > 0) {
        const s = computeRefundSuggestion(order, { cardId });
        const remainAll = Number(s.remain) || 0;
        if (remainAll > 0) {
          const factor = Math.max(0, Math.min(1, Number(s.refundFactor) || 0));
          refundAmount = Math.round(paidPrice * factor);
          ruleApplied = true;
        }
      }
      if (!ruleApplied) {
        // 兜底：卡无关联订单、或整单已无剩余可退额（remain = 0）时，保留原有按计费模式的
        // 比例算法（次数卡按剩余次数比例，时效卡按剩余有效期天数比例）。
        // 时效卡分母为「已购总时长」：expires_at 在恢复时会顺延 pause_total_ms，
        // 故总时长 = (expires_at - pause_total_ms) - activated_at，扣除暂停期后才是真实购买时长。
        const mode = card.billing_mode || 'time';
        if (mode === 'count') {
          const pricePerClass = paidPrice > 0 && card.total_classes > 0 ? paidPrice / card.total_classes : 0;
          refundAmount = Math.round(card.remaining_classes * pricePerClass);
        } else {
          const totalMs = ((card.expires_at || 0) - (card.pause_total_ms || 0)) - (card.activated_at || 0);
          const remainMs = Math.max(0, (card.expires_at || 0) - currentTime);
          refundAmount = totalMs > 0 && paidPrice > 0 ? Math.max(0, Math.round(paidPrice * remainMs / totalMs)) : 0;
        }
      }
      // 硬上限：不得超过该订单剩余额退额度（payable − 已退），与 orders/refund 的
      // 「累计退款不能超过订单金额」口径一致。RFND 流水行按本值入账，不会超过原单可退额。
      if (orderId && orderPayable > 0) {
        const room = Math.max(0, orderPayable - orderRefundedSoFar);
        if (refundAmount > room) refundAmount = room;
      }

      // 双保险：无已支付订单 ⇒ 强制零退款。即使上方任一分支算出了金额也一并归零，
      // 确保「钱从未流入」的卡绝不产生真实现金流出（仅回收卡权益）。
      if (!hasPaidOrder) refundAmount = 0;

      // 更新卡状态：次数卡同时回收剩余课时并计入已用，理由与订单退款路径一致
      // （orders.js 退款回收）—— 只置 status='refunded' 而留着 remaining_classes，
      // 会让一张已退掉的卡仍显示「剩余 18 节」，且 total = remaining + used 不成立。
      // 时效卡不消耗课时，不做课时回收；但同样要清零剩余有效期（expires_at = 当前时间），
      // 与次数卡回收剩余课时形成对称口径：两条分支都必须把「卡内剩余资产」清零。
      // 此前只置 status，剩余有效期原样保留，等于把「已退卡仍有可用时长」这个事实
      // 交给下游的 status='active' 过滤去兜底 —— 一旦那个过滤被改动，已退的卡就会
      // 带着剩余有效期复活（与次数卡「只归零 remaining」是同一类脆弱设计）。
      // 注意：退费金额 refundAmount 已在上面按 remaining_classes / 剩余有效期算完，
      // 此处清零不影响已算金额。
      if ((card.billing_mode || 'time') === 'count') {
        db.prepare("UPDATE member_cards SET status = 'refunded', used_classes = used_classes + remaining_classes, remaining_classes = 0, updated_at = ? WHERE id = ?").run(currentTime, cardId);
      } else {
        db.prepare("UPDATE member_cards SET status = 'refunded', expires_at = ?, updated_at = ? WHERE id = ?").run(currentTime, currentTime, cardId);
      }

      // 回收购买时赠送的积分（仅本卡对应商品的奖励，订单含多商品时不影响其他商品权益）
      if (orderId) {
        const refId = 'order_' + orderId + '_' + card.card_type_id;
        const rewardLogs = db.prepare("SELECT * FROM point_logs WHERE reference_id = ? AND type = 'earn'").all(refId);
        let totalReward = 0;
        for (const log of rewardLogs) {
          totalReward += Number(log.amount) || 0;
          // 翻转 earn → refund 保留：既让该笔奖励不再计入「本周获得积分」，
          // 也使重复退卡时上面的 type='earn' 查询落空（幂等保护）。
          db.prepare("UPDATE point_logs SET type = 'refund', description = '退卡回收积分' WHERE id = ?").run(log.id);
        }
        if (totalReward > 0) {
          // 回收额以「实际生效量」为准：余额只有 30 而要回收 100 时，余额只能扣到 0
          // （实扣 30），流水就必须记 -30。旧实现余额按 MAX(0,…) 截断到 0、流水却按
          // 全额 100 计，SUM(point_logs.amount) 与 points.balance 从此永久相差 70 且无自愈。
          const acc = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId);
          const actual = Math.min(totalReward, (acc && acc.balance) || 0);
          if (actual > 0) {
            const newBal = ((acc && acc.balance) || 0) - actual; // actual ≤ balance，结果自然 ≥ 0
            db.prepare(`
              UPDATE points SET
                total_earned = MAX(0, total_earned - ?),
                balance = ?,
                updated_at = ?
              WHERE student_id = ?
            `).run(actual, newBal, currentTime, studentId);
            db.prepare(`
              INSERT INTO point_logs (id, student_id, type, amount, balance, reference_id, reason, description, created_at)
              VALUES (?, ?, 'refund', ?, ?, ?, '退卡回收积分', '退卡回收积分', ?)
            `).run(generateId('PLG'), studentId, -actual, newBal, refId, currentTime);
          }
        }
      }

      // 原订单累计已退金额增加本次退额；累计达订单金额时整单标记已退（保证财务口径一致）。
      // 只有「原订单存在、且仍是 paid」时原订单才能承载本笔退款额；其余情况——
      // 卡是后台直接发放的（POST /api/membership/activate 写 order_id=''）、订单行已找不到、
      // 或订单已非 paid（已取消/已退完）——都必须落到下面的载体订单，否则这笔现金支出
      // 在财务上完全没有载体（详见下方载体订单注释）。
      if (orderId && order && order.status === 'paid') {
        db.prepare(`
          UPDATE orders SET
            refunded_amount = MIN(payable_amount, refunded_amount + ?),
            status = CASE WHEN refunded_amount + ? >= payable_amount THEN 'refunded' ELSE status END,
            updated_at = ?
          WHERE id = ? AND status = 'paid'
        `).run(refundAmount, refundAmount, currentTime, orderId);
      } else if (refundAmount > 0) {
        // === 退款载体订单（隐形约定，改动统计口径前必读）===
        // 本系统所有财务视图（finance.js 的 summary / monthly / by-product / by-sales、
        // admin.js 看板的今日/本周/本年/本月收入）统一以
        //   SUM(payable_amount) − SUM(refunded_amount)
        // 计算净额，并用 `order_type != 'refund'` 把退款流水行（RFND）排除在外。
        // 因此要让这笔现金支出真正进入统计，载体行必须满足：
        //   · payable_amount = 0        —— 它不是收入；写 0，净额才会是 −refundAmount
        //   · refunded_amount = 本笔实退金额
        //   · status='refunded' 且 paid_at = 当前时间 —— 同时满足 status IN ('paid','refunded')
        //     与 paid_at 区间谓词，按日 / 按月的 KPI 才统计得到
        //   · order_type 绝不能写 'refund' —— 会被上述谓词一并排除
        //     （finance.js:57/65/75/129/198/210/321/408、admin.js:148/152/161/165），钱照样消失
        // 切勿把 payable_amount 也写成 refundAmount：那会让 gross 与 refund 相抵、净额变 0。
        const carrierId = generateId('ORD');
        const carrierNo = `ORDS${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        db.prepare(`
          INSERT INTO orders (id, order_no, student_id, student_name, order_type, items,
            total_amount, discount_amount, payable_amount, refunded_amount, status, paid_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'refund_standalone', ?, 0, 0, 0, ?, 'refunded', ?, ?, ?)
        `).run(carrierId, carrierNo, studentId, card.student_name,
          // items 结构与 orders.js 正常订单保持一致（itemType/itemName/quantity/unitPrice/totalPrice）；
          // 金额相关字段一律填 0 —— 这笔钱记在 refunded_amount 上，若这里也记价格会被重复计算。
          // 取「退卡退费」这个可读名字，是为了让 /by-product 展开后显示成一行正常项目
          // （revenue 0 / refunded X / net −X），而不是落进「未命名」桶里。
          JSON.stringify([{
            itemType: 'refund',
            itemName: '退卡退费',
            quantity: 1,
            unitPrice: 0,
            totalPrice: 0,
            cardId,
            reason,
            standalone: true,
          }]),
          refundAmount, currentTime, currentTime, currentTime);
      }

      // 创建退款订单
      // 定时炸弹警告：本行 order_type='refund' 且 payable_amount=refundAmount、refunded_amount=0。
      // 它当前被所有财务谓词的 `order_type != 'refund'` 排除，因此不进统计（这是正确的）；
      // 但一旦将来有人放开该过滤，它会被当成**正收入 refundAmount** 计入 gross。
      // 放开过滤之前，必须先把它改成 payable_amount=0 / refunded_amount=refundAmount，
      // 或统一改由上方 order_type='refund_standalone' 的载体订单记账。
      // 另注：tests/finance-refund-regression.cjs 依赖它当前的形态（该套件按
      // `order_type = 'refund'` 统计行数、并要求 payable_amount <= 240），改它的值会破坏既有测试。
      // 无已支付订单时不落任何资金台账行（RFND 也是台账），只回收卡权益。
      // 有已支付订单时保持既有形态（含 refundAmount=0 的边界，行为不变）。
      let refundOrderId = null;
      if (hasPaidOrder) {
        refundOrderId = generateId('RFND');
        // order_no 有 UNIQUE 约束：同一毫秒内连续退卡/同事务重试时纯时间戳必撞（回归测试实测）
        const orderNo = `RF${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        db.prepare(`
          INSERT INTO orders (id, order_no, student_id, student_name, order_type, items, total_amount, payable_amount, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'refund', ?, ?, ?, 'refunded', ?, ?)
        `).run(refundOrderId, orderNo, studentId, card.student_name, JSON.stringify([{ cardId, reason }]), refundAmount, refundAmount, currentTime, currentTime);
      }

      return { ok: true, refundAmount, orderId: refundOrderId, noPaidOrder: !hasPaidOrder };
    })();

    if (result.err) return res.json(fail(result.err));
    // 退卡涉及资金流出与权益回收，必须留痕（无收款记录的作废也留痕，便于事后解释「为何无退款」）
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'refund',
      entityId: result.orderId || cardId,
      action: 'refund',
      actorId: actor.id,
      actorRole: actor.role,
      after: {
        card_id: cardId,
        student_id: studentId,
        refund_amount: result.refundAmount,
        no_paid_order: !!result.noPaidOrder,
        reason: reason || '',
      },
    });
    const payload = { cardId, refundAmount: result.refundAmount, orderId: result.orderId };
    // 明确告知前端：本次只作废卡、未产生任何退款，避免财务误以为有一笔退款
    if (result.noPaidOrder) payload.message = '无收款记录，仅作废卡，不产生退款';
    res.json(success(payload));
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
    // 过滤条件作用于 UNION 子查询的别名 u，保证 card_id / student_id 等条件对两个分支同等生效
    if (studentId) { where = 'WHERE u.student_id = ?'; params.push(studentId); }

    // 扣课明细 = 上课扣课（deduction_logs）∪ 请假扣课（leave_deduction_logs，仅 mode='class'）。
    // 此前只读 deduction_logs，而请假审批扣课时写的是 leave_deduction_logs，
    // 于是「卡上少了一节课，却在任何明细里都查不到是谁扣的」。
    // 注意：
    //  1) mode='days' 的请假扣的是时效卡「有效天数」，并未消课，并入会凭空多出一条消课记录；
    //  2) leave_deduction_logs 没有数量列，UNION 分支的 count 恒为 NULL ——
    //     请假扣课的数量由当时的班级扣课规则决定，历史行无法回填，故不新增列、不改写入路径。
    //     返回中保留 mode 字段，调用方可据此标注「请假扣课」（上课扣课 mode 为 NULL）。
    // 只改读路径：写入路径不动，避免污染撤销签到的回滚语义与「已消课」守卫。
    const unionSql = `
      SELECT d.id, d.schedule_id, d.student_id, d.card_id, d.deducted_at, d.count, NULL AS mode
      FROM deduction_logs d
      UNION ALL
      SELECT l.id, l.schedule_id, l.student_id, l.card_id, l.deducted_at, NULL AS count, l.mode
      FROM leave_deduction_logs l WHERE l.mode = 'class'`;

    const total = db.prepare(`SELECT COUNT(*) as count FROM (${unionSql}) u ${where}`).get(...params).count;
    const list = db.prepare(`
      SELECT u.id, u.schedule_id, u.student_id, u.card_id, u.deducted_at, u.count, u.mode,
             s.course_name, sc.name as student_name
      FROM (${unionSql}) u
      LEFT JOIN schedules s ON s.id = u.schedule_id
      LEFT JOIN students sc ON sc.id = u.student_id
      ${where}
      ORDER BY u.deducted_at DESC LIMIT ? OFFSET ?
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
    // 默认 30 天是对外契约（前端/报表依赖），不得擅自改动。
    // ⚠️ 到期窗口在全仓有四处口径互不一致，改动前需先与主控统一：
    //   · 本接口 /membership/expiring        默认 30 天（此处）
    //   · routes/admin.js 看板/attention      7 天
    //   · utils/renewal.js RENEWAL_WARN_DAYS  15 天（growth.js 续费清单同源）
    //   · utils/renewal.js 提醒扫描档位        15 / 7 / 1 天
    // 本窗口常量需与 utils/renewal.js 的窗口常量保持一致（收敛由主控统一处理，勿单点改动）。
    const days = parseInt(req.query.days) || 30;
    const threshold = now() + days * 24 * 3600 * 1000;

    const list = db.prepare(`
      SELECT mc.*, s.name as student_name_real, s.status as student_status
      FROM member_cards mc
      JOIN students s ON s.id = mc.student_id
      WHERE mc.status = 'active' AND mc.expires_at <= ? AND mc.expires_at > ?
        AND ${ACTIVE_STUDENT_SQL}
      ORDER BY mc.expires_at ASC
    `).all(threshold, now());

    res.json(success({ count: list.length, list }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

module.exports = router;
