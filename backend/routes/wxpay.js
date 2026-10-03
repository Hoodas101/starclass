/**
 * 微信支付路由
 *
 * POST /api/wxpay/create    — 创建支付订单（前端调起微信支付）
 * POST /api/wxpay/notify    — 微信支付回调通知（公网可访问）
 * GET  /api/wxpay/status    — 检查微信支付配置状态
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { success, fail, safeFail, getOpenId, now, recordAudit } = require('../utils');
const { isWechatPayEnabled, createPrepayOrder, verifyNotify } = require('../utils/wechat-pay');
const { parseItems } = require('../utils/items');
const ordersRoutes = require('./orders');

/**
 * GET /api/wxpay/status — 检查微信支付配置状态（已登录用户可查）
 */
router.get('/status', (req, res) => {
  try {
    res.json(success({ enabled: isWechatPayEnabled() }));
  } catch (err) {
    res.status(500).json(safeFail('查询失败'));
  }
});

/**
 * POST /api/wxpay/create — 创建支付订单
 * Body: { orderId }
 * 需要登录，用户只能支付自己的订单
 */
router.post('/create', async (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));

    if (!isWechatPayEnabled()) {
      return res.json(fail('微信支付尚未开通，请联系机构线下支付或联系管理员配置'));
    }

    const { orderId } = req.body;
    if (!orderId) return res.json(fail('缺少订单 ID'));

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.json(fail('订单不存在'));
    if (order.status === 'paid') return res.json(fail('订单已支付'));

    // 归属校验：仅订单所有者（下单家长）或绑定学员的家长可发起支付，
    // 否则任何人可对他人订单发起支付并覆盖 payments 记录。
    // 管理员经 Web 后台走「标记已收款」，微信侧支付入口仅对家长/订单主开放。
    const isOwner = openid && (
      (order.user_id && order.user_id === openid) ||
      !!db.prepare('SELECT 1 FROM parent_bindings WHERE parent_openid = ? AND student_id = ?')
        .get(openid, order.student_id || '')
    );
    if (!isOwner) {
      return res.status(403).json(safeFail('无权支付他人订单'));
    }

    // 获取支付者 openid（微信登录的 openid）
    const user = db.prepare('SELECT openid FROM users WHERE openid = ?').get(openid);
    const wxOpenid = String(openid).startsWith('wx_') ? openid.substring(3) : openid;

    const result = await createPrepayOrder({
      orderNo: order.order_no,
      amount: order.payable_amount,
      description: parseItems(order.items).map(i => i.itemName || i.name).join('、') || '教育服务',
      openid: wxOpenid,
    });

    if (result.success && result.paySign) {
      // 记录支付请求（同订单仅保留一条 pending：先清理旧的待支付流水，避免 OR REPLACE 覆盖成功流水）
      db.prepare(`
        INSERT INTO payments (id, order_id, order_no, user_id, amount, channel, status, created_at)
        SELECT ?, ?, ?, ?, ?, 'wechat', 'pending', ?
        WHERE NOT EXISTS (SELECT 1 FROM payments WHERE order_id = ? AND status = 'pending')
      `).run(
        `pay_${order.order_no}_${Date.now()}`, order.id, order.order_no,
        openid, order.payable_amount, now(), order.id
      );
      res.json(success({ paySign: result.paySign, orderId: order.id }));
    } else {
      res.json(fail(result.error || '创建支付失败'));
    }
  } catch (err) {
    console.error('[wxpay create]', err);
    res.status(500).json(safeFail('创建支付失败'));
  }
});

/**
 * POST /api/wxpay/notify — 微信支付回调通知
 * 该路由需在 server.js 中加入 PUBLIC_PATHS
 */
router.post('/notify', (req, res) => {
  try {
    // fail-closed：未配置微信支付商户凭证时，拒绝处理回调，绝不标记订单为已支付
    if (!isWechatPayEnabled()) {
      console.warn('[wxpay notify] 微信支付未配置，拒绝回调（fail-closed），不修改订单状态');
      return res.status(400).json({ code: 'FAIL', message: '微信支付未配置，回调暂不处理' });
    }

    const { verified, data } = verifyNotify(req.headers, JSON.stringify(req.body));
    if (!verified) return res.status(400).json({ code: 'FAIL', message: '验签失败' });

    // 解析回调数据：V3 明文在 data.resource；同时兼容 req.body 直传（测试 / 代理）形态
    const outTradeNo = data?.resource?.out_trade_no || req.body?.out_trade_no;
    const transactionId = data?.resource?.transaction_id || req.body?.transaction_id;

    // 无商户订单号则无从归属，按成功应答避免微信重试风暴（不修改任何数据）
    if (!outTradeNo) {
      console.warn('[wxpay notify] 回调缺少 out_trade_no，忽略');
      return res.json({ code: 'SUCCESS', message: '成功' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(outTradeNo);
    if (!order) {
      console.warn(`[wxpay notify] 订单 ${outTradeNo} 不存在，忽略回调`);
      return res.json({ code: 'SUCCESS', message: '成功' });
    }

    // === 金额校验（fail-closed）===
    // 微信 V3 回调金额单位为「分」，明文路径 data.resource.amount.total；
    // 兼容 req.body.resource.amount.total 与 req.body.amount.total 的直传形态。
    // 不校验金额会导致「下单后改价再支付，回调照样置 paid」，实收与账面不符却无从察觉。
    // 金额字段缺失一律视为「无法校验」→ 拒绝置 paid，绝不放行金额不明的回调。
    const totalFenRaw = data?.resource?.amount?.total
      ?? req.body?.resource?.amount?.total
      ?? req.body?.amount?.total;
    const totalFen = Number(totalFenRaw);
    const expectedFen = Math.round((Number(order.payable_amount) || 0) * 100);
    if (!Number.isFinite(totalFen)) {
      console.error(`[wxpay notify] 订单 ${outTradeNo} 回调缺少金额字段，无法校验，拒绝置 paid（fail-closed）`);
      recordAudit(db, {
        entity: 'order',
        entityId: order.id,
        action: 'pay_amount_unverifiable',
        actorId: '',
        actorRole: 'system',
        after: {
          orderNo: order.order_no,
          payableAmount: Number(order.payable_amount) || 0,
          reason: 'missing_amount',
          transactionId: transactionId || '',
        },
      });
      return res.status(400).json({ code: 'FAIL', message: '回调金额缺失，无法校验' });
    }
    if (totalFen !== expectedFen) {
      console.error(`[wxpay notify] 订单 ${outTradeNo} 回调金额不符：回调 ${totalFen} 分 ≠ 订单 ${expectedFen} 分，拒绝置 paid`);
      recordAudit(db, {
        entity: 'order',
        entityId: order.id,
        action: 'pay_amount_mismatch',
        actorId: '',
        actorRole: 'system',
        before: { payableAmount: Number(order.payable_amount) || 0 },
        after: {
          orderNo: order.order_no,
          callbackAmountFen: totalFen,
          expectedAmountFen: expectedFen,
          transactionId: transactionId || '',
        },
      });
      return res.status(400).json({ code: 'FAIL', message: '回调金额与订单金额不一致' });
    }

    // === 原子认领（防重复 / 防翻账）===
    // 只有 pending 订单能被回调置 paid：
    //   · 已 paid  —— 重复回调，幂等跳过；
    //   · 已 refunded / cancelled —— 管理员已退款/取消，迟到的回调绝不能把它翻回 paid。
    // 用 `WHERE id=? AND status='pending'` 把「检查 + 更新」合成一条原子语句，
    // changes === 0 即认领失败，不改任何数据（含 payments 流水与发卡）。
    const t = now();
    let claimed = false;
    db.transaction(() => {
      const claim = db.prepare(
        "UPDATE orders SET status = 'paid', paid_at = ?, payment_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
      ).run(t, transactionId || '', t, order.id);
      if (claim.changes === 0) return;
      claimed = true;

      // 流水同样限定 pending：已 refunded 的流水不得被翻回 success
      db.prepare("UPDATE payments SET status = 'success', transaction_id = ?, paid_at = ? WHERE order_id = ? AND status = 'pending'")
        .run(transactionId || '', t, order.id);

      // 收款→开通：真实支付成功后必须授予会员卡 / 发放购买积分，
      // 否则家长付款后看不到卡、无法签到扣课（与模拟支付 / 建单即付路径保持一致）。
      if (ordersRoutes.grantOrderBenefits) ordersRoutes.grantOrderBenefits(order, t);

      // 本路由是支付渠道回调（来源：微信支付 notify），无登录用户，操作者记为 system；
      // 真实收款是资金流入的关键节点，必须留痕，事后可核对回调金额与订单金额是否一致
      recordAudit(db, {
        entity: 'order',
        entityId: order.id,
        action: 'pay',
        actorId: '',
        actorRole: 'system',
        before: { status: 'pending', payableAmount: Number(order.payable_amount) || 0 },
        after: {
          orderNo: order.order_no,
          payableAmount: Number(order.payable_amount) || 0,
          callbackAmountFen: totalFen,
          transactionId: transactionId || '',
        },
      });
    })();

    if (!claimed) {
      // 订单已被处理过（paid / refunded / cancelled）：不修改数据，但仍回 SUCCESS 避免重试风暴
      console.warn(`[wxpay notify] 订单 ${outTradeNo} 当前状态非 pending（可能已 paid / refunded / cancelled），忽略回调，不修改数据`);
      return res.json({ code: 'SUCCESS', message: '成功' });
    }

    console.log(`[WxPay] 订单 ${outTradeNo} 支付成功`);
    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('[wxpay notify]', err);
    res.status(500).json({ code: 'FAIL', message: '处理失败' });
  }
});

module.exports = router;
