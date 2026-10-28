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
const { generateId, success, fail, safeFail, getOpenId, now, parsePagination, hasPerm, getReqUser, calcCardExpiresAt, formatDate, normalizeDateInput, recordAudit, isAdminReq } = require('../utils');
const { parseItems } = require('../utils/items');
// 退费规则引擎已抽到 utils/refund：refund-preview / refund / 退卡（membership）共用同一口径
const { computeRefundSuggestion } = require('../utils/refund');
// 订阅卡：顺延与周期锚定（P1/P2）
const { findDeferralBase, deferralStartFrom } = require('../utils/card-lifecycle');
const { getCardRules } = require('../utils/card-rules');
// 手机号归一化与建档查重同源（utils/duplicate）：库里 parent_bindings.parent_phone 存的是
// 归一化后的纯数字串，比对导入文件里的号码前必须同样归一化，否则「138 0013 8000」这类
// 带空格/分隔符的写法会漏配，订单就会退化成只按姓名匹配。
const { normalizePhone } = require('../utils/duplicate');
// 「学员是否已失效（已删除/已归档）」的单一事实来源：导入匹配学员时必须排除已退学的人，
// 否则历史订单会被挂到早已删除的学员头上（要求 SQL 中学员表别名为 s）。
const { ACTIVE_STUDENT_SQL } = require('../utils/student-state');
const { computeExpiry } = require('../utils/points-expiry');

// 销售权限：管理员或拥有「sales」权限的员工（销售）
function canSales(req) {
  return isAdminReq(req) || hasPerm(getReqUser(req), 'sales');
}

/**
 * 订单归属断言（写操作统一入口）。
 *
 * 非管理员只能操作「自己创建（orders.user_id = 本人 openid）」或「本人名下
 * （orders.salesperson = 本人昵称）」的订单。此前 PUT /:id 与 POST /:id/cancel 只校验
 * 角色（canSales），导致销售 A 可把销售 B 名下订单的金额改掉、状态改为 cancelled ——
 * 横向越权且直接篡改他人业绩/提成基数。pay 早已有归属校验，此处对齐消除同语义三处写法不一。
 */
/**
 * 当前登录员工的昵称（业绩归属用）。与 canOperateOrder 的比对口径一致：
 * 归属是自由文本，只能按昵称比对。
 */
function myStaffName(req) {
  const openid = getOpenId(req);
  if (!openid) return '';
  const u = db.prepare('SELECT nickname FROM users WHERE openid = ?').get(openid);
  return u && u.nickname ? String(u.nickname).trim() : '';
}

function canOperateOrder(req, order) {
  if (isAdminReq(req)) return true;
  const openid = getOpenId(req);
  if (!openid) return false;
  if (order.user_id && order.user_id === openid) return true;
  const sp = order.salesperson ? String(order.salesperson).trim() : '';
  if (sp) {
    const me = db.prepare('SELECT nickname FROM users WHERE openid = ?').get(openid);
    const myName = me && me.nickname ? String(me.nickname).trim() : '';
    if (myName && sp === myName) return true;
  }
  return false;
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

// 收款渠道白名单：此前 payments.channel 恒为 'wechat'，现金/转账收款被记成微信，
// 月底对账必然打架。允许前端传入并在白名单内归一，其余一律回退 'wechat'。
const PAY_CHANNELS = ['wechat', 'cash', 'alipay', 'bank', 'other'];
function normalizeChannel(ch) {
  const v = String(ch == null ? '' : ch).trim().toLowerCase();
  return PAY_CHANNELS.includes(v) ? v : 'wechat';
}

// 支付并激活会员卡（供直接录入已收款订单复用）
function settleOrder(order, paidAt, channel) {
  const currentTime = paidAt || now();
  db.prepare('UPDATE orders SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?')
    .run('paid', currentTime, currentTime, order.id);
  db.prepare('INSERT INTO payments (id, order_id, order_no, user_id, amount, channel, status, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(generateId('PAY'), order.id, order.order_no, order.user_id, order.payable_amount, normalizeChannel(channel), 'success', currentTime, currentTime);
  grantOrderBenefits(order, currentTime);
}

/**
 * 仅在订单已标记为 paid 之后调用：根据订单明细创建会员卡 / 发放购买积分。
 * 不做订单状态标记与支付流水写入，避免被重复调用（如支付回调路径已写过流水时）。
 *
 * 幂等策略：
 *   · 建卡按「订单 + 卡种」计数补齐（wanted − issued），重复调用不再多发。
 *     一张订单合法地对应多张卡（多卡种 / 同卡种多份），故绝不能对 order_id 加唯一约束。
 *   · 积分按 reference_id = 'order_<订单>_<商品>' 去重。
 * 计数、建卡与发积分同处一个事务，避免并发下重复发放。
 */
function grantOrderBenefits(order, paidAt) {
  const currentTime = paidAt || now();
  const items = parseItems(order.items);
  // 解析为空但订单确有 items 原文 → 极可能是坏数据/双重编码异常，静默跳过会漏发会员卡与积分
  if (order.items && items.length === 0) console.error('grantOrderBenefits: 订单 items 解析为空，可能漏发权益', order && order.id);

  // 建卡与发积分整体事务化：better-sqlite3 为同步 API，单机单进程下事务天然串行，
  // 使「统计已发张数 + 插入」成为原子步骤，避免并发请求都读到 issued=0 而各发一套。
  db.transaction(() => {
    // 预扫：按**数量**统计本单每个卡种应发张数、每个商品应发积分。
    // 此前只按「明细条数」+1，quantity=2 时实收两份钱却只发一张卡、一份积分
    //（客户多付一倍拿一半权益；反向也可被用来「收 2 份钱只记 1 单」做账外循环）。
    const wantedByProduct = new Map();   // productId -> 应发卡张数
    const rewardByProduct = new Map();   // productId -> 应发积分合计
    const productCache = new Map();      // productId -> 产品行（避免重复查库）

    for (const item of items) {
      const productId = item.itemId;
      if (!productId) continue;
      if (!productCache.has(productId)) {
        productCache.set(productId, db.prepare('SELECT * FROM membership_cards WHERE id = ?').get(productId));
      }
      const product = productCache.get(productId);
      if (!product) continue;

      const qty = Math.max(1, Number(item.quantity) || 1);
      const isCard = (product.product_type || 'membership') === 'membership' && product.billing_mode !== 'goods';

      // 卡：按数量展开（一单可合法包含同一卡种多条明细，故按条数×数量累计）
      if (isCard && (item.itemType === 'membershipCard' || order.order_type === 'membership')) {
        wantedByProduct.set(product.id, (wantedByProduct.get(product.id) || 0) + qty);
      }
      // 积分：同一卡种的多条明细合并成一笔，避免 refId 冲突导致第二笔被跳过
      const reward = Number(product.points_reward) || 0;
      if (reward > 0) {
        rewardByProduct.set(product.id, (rewardByProduct.get(product.id) || 0) + reward * qty);
      }
    }

    // 1) 发卡：只补发缺口（幂等）。issued 不按 status 过滤 —— 已退卡同样算「发过」，不能自动补发。
    for (const [productId, wanted] of wantedByProduct) {
      const product = productCache.get(productId);
      const issued = db.prepare('SELECT COUNT(*) AS c FROM member_cards WHERE order_id = ? AND card_type_id = ?')
        .get(order.id, productId).c;
      // 顺延判定：同一卡种的多张卡要链式排队，故每发一张都重新找基准卡
      const cardRules = getCardRules();
      for (let n = issued; n < wanted; n++) {
        const cardId = generateId('CARD');
        // P1 顺延：该卡种开启顺延 + 全局开关打开 + 学员已有同科目在途卡 → 排到旧卡之后。
        // 注意基准卡选择**包含已发未生效的顺延卡**，否则连买两张会完全重叠（额度翻倍）。
        let activatedAt = currentTime;
        let deferredFrom = '';
        if (cardRules.defer.enabled && Number(product.defer_enabled) === 1) {
          const base = findDeferralBase(order.student_id, {
            courseScope: product.course_scope || '',
            crossScope: cardRules.defer.crossScope,
            t: currentTime,
          });
          if (base) {
            activatedAt = deferralStartFrom(base, cardRules.defer.startAnchor, currentTime);
            deferredFrom = base.id;
          }
        }
        const expiresAt = calcCardExpiresAt(activatedAt, product.valid_days, product.billing_mode || 'time');
        // 到店限次（每周/每月）随开卡快照到卡实例：与 membership.js /activate 同一口径，
        // 保证日后调整卡种不追溯改写已售出的卡；缺列/空值时 Number(undefined)||0 → 0（不限次）
        const visitLimitPerWeek = Number(product.visit_limit_per_week) || 0;
        const visitLimitPerMonth = Number(product.visit_limit_per_month) || 0;
        // 周期锚点与周期长度**快照到卡实例**：机构之后改卡种配置，已售卡不受影响
        //（与 visit_limit_* 同一原则 —— 已收的钱不能因后台改配置而变）
        const anchor = String(product.period_anchor || '').trim() || cardRules.period.defaultAnchor || 'natural';
        db.prepare(`
          INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name,
            total_classes, remaining_classes, activated_at, expires_at, status, order_id,
            visit_limit_per_week, visit_limit_per_month,
            deferred_from_card_id, first_used_at, period_anchor, cycle_days_week, cycle_days_month,
            created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 0, ?, 7, 30, ?, ?)
        `).run(cardId, product.id, product.name, product.billing_mode || 'time', order.student_id, order.student_name,
          product.total_classes, product.total_classes, activatedAt, expiresAt, order.id,
          visitLimitPerWeek, visitLimitPerMonth,
          deferredFrom, anchor, currentTime, currentTime);
      }
    }

    // 2) 发积分：每个商品一笔，金额已按数量合计；按 订单+商品 幂等（受积分规则开关控制）
    if (isPurchasePointsEnabled()) {
      for (const [productId, reward] of rewardByProduct) {
        if (reward <= 0) continue;
        const product = productCache.get(productId);
        const refId = 'order_' + order.id + '_' + productId;
        if (db.prepare('SELECT id FROM point_logs WHERE reference_id = ?').get(refId)) continue;

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
        db.prepare('INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, created_at, expire_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(generateId('PLG'), order.student_id, 'earn', reward, bal, '购买「' + product.name + '」赠送积分', refId, '购买产品赠送', currentTime, computeExpiry(currentTime));
      }
    }
  })();
}

/** 布尔类入参归一为 0/1：字符串 "0"/"false"/"" 必须判为假。
 *  此前用 JS 真值判断，"0" 为真 → revenue_excluded 被置 1，该单从财务汇总、月报、
 *  销售业绩、看板 KPI 全部静默消失（revenue_excluded 是全站营收硬过滤），属账实不符。 */
function flag01(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  return 0;
}

/** ID 类入参只接受标量（字符串/数字）。
 *  传对象或数组会一路传到 better-sqlite3 绑定层抛 TypeError → HTTP 500，
 *  把「参数非法」误报成「服务器故障」。此处提前拦截，统一走 HTTP 200 + code!=0。 */
function isScalarId(v) {
  return (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v));
}

/**
 * POST /api/orders — 创建订单
 * Body: { studentId, cardTypeId, items, discountAmount, orderType, salesperson, remark, status, paidAt }
 */
router.post('/', (req, res) => {
  try {
    // 创建销售单属于管理操作（家长购买走联系客服渠道）
    if (!canSales(req)) return res.status(403).json(safeFail('无销售录入权限'));
    const { studentId, cardTypeId, items, discountAmount = 0, orderType = 'membership', salesperson = '', remark = '', status = 'pending', paidAt, is1v1 = 0, revenueExcluded = 0, channel, payableAmount: overrideAmount } = req.body;
    const openid = getOpenId(req);
    if (!isScalarId(studentId)) return res.json(fail('成员ID格式不正确'));
    if (cardTypeId !== undefined && cardTypeId !== null && cardTypeId !== '' && !isScalarId(cardTypeId)) {
      return res.json(fail('会员卡类型ID格式不正确'));
    }

    // P1-9：已归档/已删除学员不得建单。资产链路此前缺此校验，而上课链路
    // （checkin / leave / enroll）一直有 —— 结果能给归档学员卖卡、发积分，却上不了课。
    const student = db.prepare(`SELECT s.name FROM students s WHERE s.id = ? AND ${ACTIVE_STUDENT_SQL}`).get(studentId);
    if (!student) return res.json(fail('成员不存在或已归档'));

    // items 来自请求体，入口必须做形状校验：此前传字符串（有 length、无 reduce）
    // 或数组里混入 null / 裸字符串元素，都会让下方的 reduce 与属性访问抛 TypeError → 500。
    // 非法输入属业务错误，统一返回 fail（HTTP 200 + code!=0）而非 500。
    if (items !== undefined && items !== null && !Array.isArray(items)) {
      return res.json(fail('订单项格式不正确'));
    }
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return res.json(fail('订单项格式不正确'));
        }
        // 单价/数量若给出必须能解析为有限数，否则 totalAmount 会算出 NaN 并写库
        if (item.unitPrice !== undefined && item.unitPrice !== null && !Number.isFinite(Number(item.unitPrice))) {
          return res.json(fail('订单项单价不合法'));
        }
        if (item.quantity !== undefined && item.quantity !== null && !Number.isFinite(Number(item.quantity))) {
          return res.json(fail('订单项数量不合法'));
        }
        // 光挡 NaN 不够：负单价 / 1e308 这类超大金额同样是有限数，会穿透并污染
        // 实付、营收聚合与对账；quantity=0/负数/10000 也会算出荒谬金额。
        if (item.unitPrice !== undefined && item.unitPrice !== null) {
          const up = Number(item.unitPrice);
          if (up < 0 || up > 1e9) return res.json(fail('订单项单价需在 0 ~ 10 亿之间'));
        }
        if (item.quantity !== undefined && item.quantity !== null) {
          const q = Number(item.quantity);
          if (!Number.isInteger(q) || q < 1 || q > 9999) return res.json(fail('订单项数量需为 1 ~ 9999 的整数'));
        }
      }
    }

    // H2：totalPrice 一律服务端重算，不信任客户端。
    // 此前可传 unitPrice=0 / totalPrice=1000（实付 0），而收入结转 utils/items.js 的
    // itemLineTotal 优先取 totalPrice、退卡定价同源 —— 等于按 1000 逐次确认收入。
    // 反向亦可实付 100、totalPrice=999999，单课时结转数万元、合同负债变负。
    if (Array.isArray(items)) {
      for (const item of items) {
        const up = Number(item.unitPrice) || 0;
        const qty = Math.max(1, Number(item.quantity) || 1);
        item.totalPrice = up * qty;
      }
    }

    // 业绩归属是自由文本且无外键，写入前统一 trim：否则同一员工手输「张三」/「张三 」
    // 会在报表里分裂成两个业绩组。批量导入路径（下方 /import）本就 trim，两条路径策略须一致。
    // M2：业绩归属是提成依据。非管理员一律强制为本人昵称 —— 否则销售可把单子
    // 挂到任意人名下（伪造他人业绩，或改归属后绕过 canOperateOrder 的归属校验）。
    // 此前写成 `String(salesperson||'').trim() || myStaffName(req)`，传了值就直接采用，
    // 兜底永不生效（注释与实现相反）；现改为非管理员**直接忽略入参**。
    const salespersonNorm = isAdminReq(req)
      ? String(salesperson || '').trim()
      : myStaffName(req);

    let orderItems = items;
    let totalAmount = 0;

    // 如果是会员卡订单且没有显式 items，根据 cardTypeId 构造
    if (orderType === 'membership' && cardTypeId && !items) {
      const cardType = db.prepare('SELECT * FROM membership_cards WHERE id = ?').get(cardTypeId);
      if (!cardType) return res.json(fail('会员卡类型不存在'));
      const cardPrice = Number(cardType.price);
      // 负价 / 非数字一律拒绝。此前只挡 isFinite，price=-1 会算出负的订单总额，
      // 随后被折扣校验误判成「折扣金额不能超过订单总额」，报错文案与真实原因不符。
      if (!Number.isFinite(cardPrice) || cardPrice < 0) return res.json(fail('会员卡价格不合法，请先在卡种设置中修正'));
      orderItems = [{ itemType: 'membershipCard', itemId: cardTypeId, itemName: cardType.name, quantity: 1, unitPrice: cardPrice, totalPrice: cardPrice }];
      totalAmount = cardPrice;
    } else if (items?.length) {
      totalAmount = items.reduce((sum, item) => sum + (item.unitPrice || 0) * (item.quantity || 1), 0);
    } else {
      return res.json(fail('缺少订单项或会员卡类型'));
    }

    // 金额上限：item 单价已限 1e9、数量限 9999，但多行叠加仍可算出 1e13 级总额，
    // 会溢出前端展示与月度汇总。此处按「单笔实收」做业务上限。
    if (!Number.isFinite(totalAmount) || totalAmount < 0) return res.json(fail('订单总额不合法'));
    if (totalAmount > 1e8) return res.json(fail('订单总额超出单笔上限（1 亿元），请拆单'));

    // H3-1：折扣必须是有限数且落在 [0, totalAmount]。
    // 此前传 "abc" 会让 discount_amount='abc'、payable_amount=NULL，后续统计全失真。
    const discountVal = Number(discountAmount === undefined || discountAmount === null ? 0 : discountAmount);
    if (!Number.isFinite(discountVal) || discountVal < 0) return res.json(fail('折扣金额不合法'));
    if (discountVal > totalAmount) return res.json(fail('折扣金额不能超过订单总额'));

    // H3-2：状态白名单。此前可直接传 status='refunded' 建成"已退款单"（无任何支付/退款流水），
    // 或传 'paid' 跳过收款流程。退款/取消必须走各自的接口。
    const STATUS_ALLOWED = ['pending', 'paid'];
    if (!STATUS_ALLOWED.includes(String(status))) {
      return res.json(fail('订单状态只能为待支付或已支付，退款/取消请走对应操作'));
    }

    let payableAmount = Math.max(0, totalAmount - discountVal);
    // 支持管理端按实际成交价录入（覆盖项目标价）
    if (overrideAmount !== undefined && isFinite(Number(overrideAmount)) && Number(overrideAmount) >= 0) {
      payableAmount = Number(overrideAmount);
    }
    // M1：0 元单强制标记「不计入销售」。此前只写审计标记，仍照常计入销售统计 →
    // 赠课/让价单会虚增业绩，若提成以销售看板为准就会多发。
    const isZeroAmount = payableAmount <= 0;
    // 布尔字段必须真值归一：客户端传字符串 "0" 时，`"0" || isZeroAmount` 会把
    // 普通订单也置成 revenue_excluded=1，该单随即从全部营收报表消失且无任何报错。
    const is1v1Final = flag01(is1v1);
    const revenueExcludedFinal = (flag01(revenueExcluded) === 1 || isZeroAmount) ? 1 : 0;

    const currentTime = now();
    const id = generateId('ORD');
    const orderNo = `ORD${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // INSERT 与（若已付）结算同处一个事务：任一环节失败整体回滚，避免"已付订单无支付流水/未激活卡"
    db.transaction(() => {
      db.prepare(`
        INSERT INTO orders (id, order_no, user_id, student_id, student_name, order_type, items, total_amount, discount_amount, payable_amount, status, salesperson, remark, is_1v1, revenue_excluded, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, orderNo, openid, studentId, student.name, orderType, JSON.stringify(orderItems), totalAmount, discountVal, payableAmount, status, salespersonNorm, remark, is1v1Final, revenueExcludedFinal, currentTime, currentTime);

      // 直接录入已收款订单：立即结算并激活会员卡（settleOrder/grantOrderBenefits 内部按 reference_id 幂等去重）
      if (status === 'paid') {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
        // H3-3：paidAt 由客户端给，此前可把收入记到任意历史月份（影响月报/结转）。
        // 只接受毫秒时间戳，并夹取到 [建单时间 - 1 天, 当前时间]。
        let paidAtMs = Number(paidAt);
        if (!Number.isFinite(paidAtMs) || paidAtMs <= 0) paidAtMs = currentTime;
        const lower = currentTime - 24 * 3600 * 1000;
        const upper = Math.max(currentTime, Date.now());
        paidAtMs = Math.min(Math.max(paidAtMs, lower), upper);
        settleOrder(order, paidAtMs, channel);
      }

      // 建单即确定应收金额，status='paid' 时还会立即结算建卡发积分；
      // overrideAmount 可绕过项目标价任意定价，必须留痕（保留原始 totalAmount，让「被人为改过价」在审计里可见）
      const auditAfter = { orderNo, studentId, totalAmount, discountAmount, payableAmount, status };
      if (overrideAmount !== undefined && isFinite(Number(overrideAmount)) && Number(overrideAmount) >= 0) {
        auditAfter.overridden = true;
      }
      // 零价单（赠品 / 体验课 / 销售自主让价）单独打标：不需要审批，但必须可追溯。
      // 打标后审计页可按 zeroAmount / zeroAmountPaid 精确筛出「一分钱没收却发了权益」的单子。
      if (payableAmount === 0) {
        auditAfter.zeroAmount = true;
        if (status === 'paid') auditAfter.zeroAmountPaid = true;
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

    // 同时返回 id 与 orderId：其它创建接口统一用 data.id，此处补 id 以免调用方取不到；
    // orderId 保留以兼容既有调用方。
    res.json(success({ id, orderId: id, orderNo, totalAmount, payableAmount, discountAmount }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * 宽松金额解析：机构台账的金额列常见多种写法在**同一列内混用**
 * （199 / ¥199.00 / ￥29.90 / ¥2,699.00 / 29.90）。
 * 旧实现直接 `Number(r.amount)`，遇到「¥2,699.00」得到 NaN → 整行被拒，
 * 而错误文案只说「金额需为大于 0 的数字」，用户完全无法定位是货币符号导致的。
 * 处理：剥离货币符号（含全角）、千分位（中英文逗号）、空白与尾缀「元」；
 * 兼容会计负数写法 (100.00) → -100。
 * @returns {{ok: boolean, value?: number, raw: string}}
 */
/**
 * 导入行的「文件行号」：前端 csvToObjects 会给每条提交对象挂上原始文件行号 `_fileRow`
 *（含被跳过的标题行）。此前后端用 `idx + 2` 按提交数组下标推算，而必填缺失行会被前端先丢弃，
 * 缺失行夹在中间时偏移逐行累积，用户按提示回 Excel 找不到那一行。
 */
const fileRowOf = (r, idx) => {
  const n = Number(r && r._fileRow);
  return Number.isFinite(n) && n > 0 ? n : idx + 2;
};

function parseMoneyLoose(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, raw };
  let s = raw.replace(/[¥￥$＄]/g, '').replace(/[,，\s]/g, '').replace(/元$/, '');
  let negative = false;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) {
    negative = true;
    s = paren[1];
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, raw };
  return { ok: true, value: negative ? -n : n, raw };
}

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
    // 导入文件显式带 orderNo 的行命中已存在的订单号时记入这里（跳过而非报错）
    const skipped = [];
    // 非致命告警（如项目名查不到卡种）：订单照常入账，但权益未发放，必须让用户看到
    const warnings = [];

    const insertOrder = db.prepare(`
      INSERT INTO orders (id, order_no, user_id, student_id, student_name, order_type, items, total_amount, discount_amount, payable_amount, status, salesperson, remark, is_1v1, created_at, updated_at)
      VALUES (?, ?, '', ?, ?, 'membership', ?, ?, 0, ?, 'pending', ?, ?, 0, ?, ?)
    `);

    // orders.order_no 是 UNIQUE 列：重复导入同一份文件时若不先查重，会直接撞唯一约束抛异常，
    // 整批回滚并返回 500，用户既不知道哪几行重复、其余行也一起丢。先查后跳，属正常业务分支。
    const orderNoExists = db.prepare('SELECT 1 FROM orders WHERE order_no = ? LIMIT 1');
    // 本批内各收据单号出现次数：用于区分「批内同单号多明细行」（加后缀入账）与
    // 「跨批重复导入」（跳过），见下方单号分支
    const batchOrderNos = new Map();
    // 本批中被判定为「导入前已存在」的单号：该单号在本批的**后续行也要一起跳过**。
    // 否则重导同一份多行同号文件时，首行被跳过、第 2 行起却当成「批内首次重复」去生成
    // 一个尚不存在的后缀（R001-2 已存在就试 -3、-4…）并再次入账 —— 订单、流水、卡与积分
    // 全部重复一遍。
    const batchSkippedNos = new Set();

    // 整批导入单事务提交：任一行出现未预期异常即整体回滚，避免半批订单入库。
    // 行级校验失败只记入 failed 不影响其余行；校验通过的行走 settleOrder，
    // 补齐支付流水并激活应得权益（幂等）。
    db.transaction(() => {
      rows.forEach((r, idx) => {
        const studentName = String(r.studentName || '').trim();
        const phone = String(r.phone || '').trim();
        const itemName = String(r.itemName || '').trim();
        if (!studentName || !itemName) {
          failed.push({ row: fileRowOf(r, idx), reason: '成员姓名与项目必填' });
          return;
        }
        // 金额走宽松解析：台账里「¥2,699.00」「￥29.90」「199元」都要能吃下；
        // 失败时把原值回显，用户才知道是哪个写法不被接受。
        // 金额允许 0：赠品 / 0 元体验单是真实销售记录（实测 26销售 有 4 行 ¥0.00 被整行拒绝）
        const amountParsed = parseMoneyLoose(r.amount);
        if (!amountParsed.ok || amountParsed.value < 0) {
          const shown = String(r.amount == null ? '' : r.amount).trim();
          failed.push({ row: fileRowOf(r, idx), reason: `金额需为不小于 0 的数字（当前值「${shown || '空'}」）` });
          return;
        }
        const amount = amountParsed.value;
        // 与建单同一上限：导入此前只挡负数，可灌入 1e13 级流水污染月度汇总
        if (amount > 1e8) {
          failed.push({ row: fileRowOf(r, idx), reason: '金额超出单笔上限（1 亿元），请拆单后导入' });
          return;
        }

        // 仅对导入文件显式提供了 orderNo 的行查重：orderNo 为空时走下方随机生成逻辑，
        // 生成的订单号天然唯一，无法也无需查重。命中即跳过该行，不影响其余行与本批事务。
        // 收据单号在台账里常「一笔收款分多行登记」（实测 16 组重复单号共 20 行）。
        // 批内重复 = 同一笔业务的多个明细行 → 追加 -2/-3 后缀全部入账并记 warning；
        // 跨批重复（单号已在库中）= 真的重复导入 → 照旧跳过并明示。
        const rawOrderNo = String(r.orderNo || '').trim();
        let finalOrderNo = rawOrderNo;
        if (rawOrderNo) {
          const seen = (batchOrderNos.get(rawOrderNo) || 0) + 1;
          batchOrderNos.set(rawOrderNo, seen);
          // 整组跳过：本批中该单号已被判定为「导入前已存在」，后续同号行不再入账
          if (batchSkippedNos.has(rawOrderNo)) {
            skipped.push({ row: fileRowOf(r, idx), orderNo: rawOrderNo, reason: '订单号已存在，已跳过' });
            return;
          }
          // 只有「本批内首次出现」才查库判跨批重复：批内第 2 行起，第 1 行已在本事务里插入，
          // 直接查库会把同批的多明细行误判成「订单号已存在」而全部跳过。
          if (seen === 1 && orderNoExists.get(rawOrderNo)) {
            batchSkippedNos.add(rawOrderNo);
            skipped.push({ row: fileRowOf(r, idx), orderNo: rawOrderNo, reason: '订单号已存在，已跳过' });
            return;
          }
          if (seen > 1) {
            // 后缀值也要避开库里已存在的号（上次导入可能已生成过 0854197-2）
            let n = seen;
            let candidate = `${rawOrderNo}-${n}`;
            while (orderNoExists.get(candidate)) { n += 1; candidate = `${rawOrderNo}-${n}`; }
            finalOrderNo = candidate;
            warnings.push({
              row: fileRowOf(r, idx),
              reason: `订单号「${rawOrderNo}」与本批其他行重复，本行已按「${finalOrderNo}」入账`,
            });
          }
        }

        // 匹配成员：优先姓名+电话，其次姓名
        let student = null;
        if (phone) {
          student = db.prepare(`
            SELECT s.id, s.name FROM students s
            JOIN parent_bindings pb ON pb.student_id = s.id
            WHERE s.name = ? AND pb.parent_phone = ? AND ${ACTIVE_STUDENT_SQL} LIMIT 1
          `).get(studentName, normalizePhone(phone));
        }
        if (!student) {
          // 退而按姓名匹配：同样必须排除已删除/已归档学员；students 补别名 s 以复用 ACTIVE_STUDENT_SQL
          student = db.prepare(`SELECT s.id, s.name FROM students s WHERE s.name = ? AND ${ACTIVE_STUDENT_SQL} ORDER BY s.created_at DESC LIMIT 1`).get(studentName);
        }
        if (!student) {
          failed.push({ row: fileRowOf(r, idx), reason: `未找到成员「${studentName}」` });
          return;
        }

        const id = generateId('ORD');
        const t = now();
        // 购买日期走统一解析（YYYY-M-D / M/D/YY / Excel 序列号 / YYYYMMDD / 中文日期）。
        // 此前解析失败会**静默回退为当前时间**，整批记录的时间全部落在导入当天，
        // 销售趋势与按月统计随之全错而界面看不出异常；现改为该行入 failed 并说明原因。
        let paidTs = t;
        if (String(r.paidDate == null ? '' : r.paidDate).trim()) {
          const pd = normalizeDateInput(r.paidDate);
          if (!pd.ok) {
            failed.push({ row: fileRowOf(r, idx), reason: `购买日期无法识别：${pd.reason}` });
            return;
          }
          const ms = new Date(pd.value + 'T12:00:00').getTime();
          if (!Number.isFinite(ms)) {
            failed.push({ row: fileRowOf(r, idx), reason: `购买日期无法识别：${pd.reason || '解析失败'}` });
            return;
          }
          paidTs = ms;
        }
        // 入账时间必须是合理历史区间：允许导入历史台账，但拒绝未来日期（会篡改未来月份报表）
        // 与过早日期（1900 年会让摊销/月报出现极端值）。此前接受 1900–2999 任意日期。
        const _minPaid = new Date('2000-01-01T00:00:00').getTime();
        const _maxPaid = Date.now() + 86400000;
        if (paidTs < _minPaid || paidTs > _maxPaid) {
          failed.push({ row: fileRowOf(r, idx), reason: '购买日期需在 2000-01-01 至今天之间' });
          return;
        }
        const orderNo = finalOrderNo || `ORD${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        // 按项目名反查卡种：导入的 items 此前缺 itemId，grantOrderBenefits 两个循环都在
        // `if (!item.itemId) continue` 处整体跳过 → 发卡与积分静默不发，而订单入账、接口仍返回成功
        //（典型「账实相符但权益丢失」）。命中则写 itemType:'membershipCard' + itemId；查不到不静默成功，记入 warnings。
        const cardType = db.prepare('SELECT id FROM membership_cards WHERE name = ? LIMIT 1').get(itemName);
        const items = [{
          itemType: cardType ? 'membershipCard' : 'product',
          itemId: cardType ? cardType.id : undefined,
          itemName,
          quantity: 1,
          unitPrice: amount,
          totalPrice: amount,
        }];
        if (!cardType) {
          warnings.push({ row: fileRowOf(r, idx), reason: `项目「${itemName}」在产品库中不存在，订单已入账但未开通会员卡，请手工补发` });
        }
        // 业绩归属与建单同口径：非管理员强制本人（此前直接采信文件内容，销售可冒名他人业绩）
        const importSalesperson = isAdminReq(req) ? String(r.salesperson || '').trim() : myStaffName(req);
        insertOrder.run(id, orderNo, student.id, student.name, JSON.stringify(items), amount, amount, importSalesperson, String(r.remark || '').trim(), t, t);
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

    // skipped 为「订单号已存在」被跳过的行数，skippedRows 给出具体行号与订单号，供界面提示用户
    res.json(success({ success: okCount.length, failed, created: okCount.length, skipped: skipped.length, skippedRows: skipped, warnings }));
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
    // 收款渠道：与建单自动结算（settleOrder）统一走 normalizeChannel，避免现金/转账被硬编码记成微信。
    const channel = normalizeChannel(req.body && req.body.channel);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.json(fail('订单不存在'));
    // F2：区分「员工代收」与「家长自助支付」。
    // 此前只看 isAdminReq —— 销售（前台收现金/微信转账后录入）与家长被一并拦下，
    // 「签单→收款」断在收银环节，只能找管理员代点。
    // 注意：这条与 H3（status 白名单）必须一起改 —— H3 收口后「建单即 paid」的旁路没了，
    // 若只修 H3 不修本条，销售收款会彻底断流。
    // 口径：员工只能代收**自己可操作**的订单（本人建单 / 本人业绩归属），管理员不限。
    // 不用 `canSales(req)` 一刀切 —— 那会让任一销售能给任意人的订单收款，
    // 把既有的 IDOR 防护（T7：非订单所有者支付被拒）打开一个口子。
    // 覆盖的真实场景是「销售建单 → 同一位销售收款」，这正是此前断掉的那一环。
    const isStaffCollect = canOperateOrder(req, order);

    // 家长自助：仍须订单归属本人或其绑定学员
    if (!isStaffCollect) {
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
    // 只认显式开启：此前「未设置 SIMULATED_PAY_DISABLED 且非 production」也算开启，
    // 而日常启动脚本（start-all.sh / npm start）根本不设 NODE_ENV —— 等于默认开放，
    // 家长可以零成本把自己的待支付订单置为已付并发卡发分。
    const simulatedPayEnabled = process.env.SIMULATED_PAY_DISABLED === '0';
    // 员工代收不受此闸门约束（收的是真实现金/转账，不是"模拟支付"）；家长自助仍 fail-closed
    if (!isStaffCollect && !simulatedPayEnabled) {
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
        .run(generateId('PAY'), paidOrder.id, paidOrder.order_no, paidOrder.user_id, paidOrder.payable_amount, channel, 'success', currentTime, currentTime);
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
          paymentMethod: channel,
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
    if (order.status !== 'paid') {
      // P2-23：已退款的单再点退款时，不能再笼统说「只有已支付订单可退款」——
      // 用户看到的是「我这单明明付过钱」，会误以为系统丢了支付记录。
      return res.json(fail(order.status === 'refunded' ? '该订单已全额退款，无需再次退款' : '只有已支付订单可退款'));
    }

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
    let revertedRecognitions = 0; // 全额退款时冲销的已结转收入行数（审计用）
    // Refund runs in one transaction with an optimistic lock on refunded_amount
    // to prevent concurrent double refunds.
    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!order) return { err: '订单不存在' };
      if (order.status !== 'paid') {
        return { err: order.status === 'refunded' ? '该订单已全额退款，无需再次退款' : '只有已支付订单可退款' };
      }

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
      // last_refunded_at 记录「最后一次退款发生时间」：月报按它归集退款，改备注/取消订单都不得写它，
      // 否则一笔 3 月的退款会因 5 月改备注被搬到 5 月。部分退款与全额退款都要刷新。
      const upd = db.prepare("UPDATE orders SET refunded_amount = ?, status = CASE WHEN ? >= ? THEN 'refunded' ELSE status END, last_refunded_at = ?, updated_at = ? WHERE id = ? AND refunded_amount = ?")
        .run(newRefunded, newRefunded, paidAmount, currentTime, currentTime, order.id, refundedSoFar);
      if (upd.changes === 0) return { conflict: true };

      if (isFull) {
        // 全额退款：将关联的会员卡标记为已退款，并回收卡内剩余权益
        // 必须与下方「部分退款」分支保持同一口径：只置 status='refunded' 而不清零剩余课时/有效期，
        // 会出现「退全款反而保留课时」的倒置——学员拿走全部退款，卡内剩余权益却原样留着。
        const cards = db.prepare('SELECT * FROM member_cards WHERE order_id = ?').all(order.id);
        for (const card of cards) {
          if ((card.billing_mode || 'time') === 'count') {
            // 次数卡：回收的课时计入 used_classes，维持 total = remaining + used 恒等式
            // （SQL 中两处赋值均基于更新前的行值，先后顺序不影响结果）。
            db.prepare('UPDATE member_cards SET status = ?, used_classes = used_classes + remaining_classes, remaining_classes = 0, updated_at = ? WHERE id = ?').run('refunded', currentTime, card.id);
          } else {
            // 时效卡：清零剩余有效期，与部分退款分支一致
            db.prepare('UPDATE member_cards SET status = ?, expires_at = ?, updated_at = ? WHERE id = ?').run('refunded', currentTime, currentTime, card.id);
          }
        }
        if (cards.length > 0) clawback = '全额退款已同步回收卡内剩余权益';
        // 全额退款必须冲销该订单已结转的收入：学员已消课部分此前已从合同负债结转为收入，
        // 退款后若不冲销，collected 归零而结转记录仍在 → 该订单对合同负债的贡献变成负数，
        // 量大时整体 liability 为负。口径与 utils/attendance-revert 的 revertRevenueRecognition 一致：
        // 按 order_id 删除该订单的结转行（DELETE 天然幂等，重复退款安全）。
        // revenue_recognitions 由迁移 017 建立，老库可能不存在 —— 先判表存在，不存在时静默跳过。
        try {
          const hasRecognitionTable = db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revenue_recognitions'"
          ).get();
          if (hasRecognitionTable) {
            revertedRecognitions = db.prepare('DELETE FROM revenue_recognitions WHERE order_id = ?').run(order.id).changes;
          }
        } catch (e) {
          console.error('[orders refund] 冲销结转记录失败', e && e.message);
        }
        // 全额退款：回收购买赠送的积分（按 订单+商品 维度查找，支持多商品订单）
        const rewardLogs = db.prepare("SELECT * FROM point_logs WHERE reference_id GLOB ? AND type = 'earn'").all('order_' + order.id + '*');
        let totalReward = 0;
        for (const log of rewardLogs) {
          totalReward += Number(log.amount) || 0;
          // 翻转 earn → refund 保留：既让该笔奖励不再计入「本周获得积分」，
          // 也使重复退款时下面的 type='earn' 查询落空（幂等保护）。
          db.prepare("UPDATE point_logs SET type = 'refund', description = '订单退款回收积分' WHERE id = ?").run(log.id);
        }
        if (totalReward > 0) {
          // 回收额以「实际生效量」为准：余额只有 30 而要回收 100 时，余额只能扣到 0
          // （实扣 30），流水就必须记 -30。旧实现余额按 MAX(0,…) 截断到 0、流水却按
          // 全额 100 计，SUM(point_logs.amount) 与 points.balance 从此永久相差 70 且无自愈。
          const acc = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(order.student_id);
          const actual = Math.min(totalReward, (acc && acc.balance) || 0);
          if (actual > 0) {
            const newBal = ((acc && acc.balance) || 0) - actual; // actual ≤ balance，结果自然 ≥ 0
            db.prepare(`
              UPDATE points SET
                total_earned = MAX(0, total_earned - ?),
                balance = ?,
                updated_at = ?
              WHERE student_id = ?
            `).run(actual, newBal, currentTime, order.student_id);
            db.prepare(`
              INSERT INTO point_logs (id, student_id, type, amount, balance, reference_id, reason, description, created_at)
              VALUES (?, ?, 'refund', ?, ?, ?, '订单退款回收积分', '订单退款回收积分', ?)
            `).run(generateId('PLG'), order.student_id, -actual, newBal, 'order_' + order.id, currentTime);
          }
        }
      } else if (appliedSuggestion && (suggestion.mode === 'custom' || suggestion.mode === 'ratio')) {
        // 注意：**不能**带 `suggestion.started &&`。
        // beforeStart='percent' 的规则分支（refund.js）在定义上就是「未开始消耗」，started 恒为 false，
        // 带上这个条件会让「开课前按 (100−X)% 退现金」整体跳过权益回收 ——
        // 学员拿回大部分现金却保留整张卡，等价于 X 折买卡。次数卡与时效卡都会中招。
        // 语义：凡**按规则建议值**退款（appliedSuggestion 为真）且该退款对应「交出剩余权益」
        // 的，都要同步回收卡权益——否则学员既拿到现金退款、又保留全部剩余课时/有效期。
        // mode==='ratio' 是 afterStart='percent' 的规则扣费退（退款额 = remain×(1−pct%)），
        // 此前只回收 custom 分支，ratio 分支既不回收权益也不标记 refunded → 直接资金漏洞。
        // 只有协商金额（appliedSuggestion 为假，即显式 confirmOverride 偏离规则）才视为
        // 自愿折扣，保留卡权益。
        // P1-35：必须回收订单下**全部**卡。此前只回收 suggestion.cardId 一张，
        // 多卡订单会出现「退款按全部卡计算、权益只终止一张」，学员保留其余卡的课时/有效期。
        const refundCards = db.prepare('SELECT * FROM member_cards WHERE order_id = ?').all(order.id);
        const clawbacks = [];
        const notes = [];
        for (const card of refundCards) {
          if (!card || card.status === 'refunded') continue;
          if ((card.billing_mode || 'time') === 'count') {
            // 次数卡：只把剩余课时成对回收进 used（remaining 归零即自然不可用），
            // **不改 status** —— 部分退款只是「买回一部分权益」，卡本身没作废；
            // 只有全额退款（上方 isFull 分支）才置 status='refunded'。
            // 恒等式 total = remaining + used 由这一次 UPDATE 同时保证。
            db.prepare('UPDATE member_cards SET used_classes = used_classes + remaining_classes, remaining_classes = 0, updated_at = ? WHERE id = ?').run(currentTime, card.id);
            clawbacks.push(`卡内剩余 ${card.remaining_classes || 0} 次课时`);
          } else {
            // 时效卡：部分退款**不改 status、不改 expires_at**（保留原摊销区间）。
            // 第二轮 P0-4：改写 expires_at=当前时间会让 totalMs→0、原区间丢失，剩余金额
            // 永不确认、退款额反被当收入（负债变负）。已确认收入由 revenue.js 的
            // 「净收上限（实付−已退）+ 负数冲销行」按比例回冲，无需在此作废卡。
            notes.push('时效卡保留原有效期（已确认收入按退款比例回冲）');
          }
        }
        if (clawbacks.length) clawback = `已同步回收：${clawbacks.join('、')}`;
        if (notes.length) clawback = (clawback ? clawback + '；' : '') + notes.join('、');
      }

      // Refund payment record
      // P1-7：渠道不能硬编码 'wechat' —— 现金/转账收款单会被记成微信退款，
      // 渠道对账与手续费核算随之失真。取原支付流水渠道，缺失时记 'manual'。
      const paidRow = db.prepare(`
        SELECT channel FROM payments
        WHERE order_id = ? AND status <> 'refunded'
        ORDER BY COALESCE(paid_at, created_at) DESC LIMIT 1
      `).get(order.id);
      const refundChannel = (paidRow && paidRow.channel) || 'manual';
      const paymentId = generateId('REF');
      db.prepare('INSERT INTO payments (id, order_id, order_no, user_id, amount, channel, status, paid_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(paymentId, order.id, order.order_no, order.user_id, amount, refundChannel, 'refunded', currentTime, currentTime);

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
          revertedRecognitions,
          reason,
          payment_id: paymentId,
        },
      });

      return { ok: true, amount, full: isFull, reason };
      // .immediate()：退款是资金写操作，多进程部署下必须一开始就拿写锁串行化，
      // 否则两个连接可能都读到旧 refunded_amount，乐观锁在快照隔离下无法可靠拦截（重复退款）。
    }).immediate();

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
    const { payableAmount, salesperson, remark, revenueExcluded } = req.body;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.json(fail('订单不存在'));
    // 归属校验：非管理员仅可修改自己名下订单（与 pay/cancel 同构，堵住销售篡改他人订单金额）
    if (!canOperateOrder(req, order)) return res.status(403).json(safeFail('仅可操作自己名下的订单'));
    if (order.status === 'refunded' || order.status === 'cancelled') {
      return res.json(fail('已取消或已退款的订单不可修改'));
    }

    const fields = [];
    const params = [];
    let syncPaymentAmount = null;
    if (payableAmount !== undefined) {
      const amount = Number(payableAmount);
      if (!isFinite(amount) || amount < 0) return res.json(fail('金额不合法'));
      // 改价同样受单笔上限约束（此前只挡负数，100 元卡可改成 5,000 万，污染营收/退款上限/提成基数）
      if (amount > 1e8) return res.json(fail('金额超出单笔上限（1 亿元），请拆单'));
      // Never below what was already refunded
      const refundedSoFar = Number(order.refunded_amount) || 0;
      if (amount < refundedSoFar) return res.json(fail(`金额不能低于已退款金额 ¥${refundedSoFar}`));
      fields.push('payable_amount = ?');
      params.push(amount);
      syncPaymentAmount = amount;
    }
    if (salesperson !== undefined) { fields.push('salesperson = ?'); params.push(String(salesperson).trim()); }
    if (remark !== undefined) { fields.push('remark = ?'); params.push(String(remark)); }
    // 核销/赠卡类订单不计入营收统计（财务各口径统一排除）
    // 布尔必须真值归一：字符串 "0" 在 JS 中为真值，直接写入会把订单踢出全部营收统计
    if (revenueExcluded !== undefined) { fields.push('revenue_excluded = ?'); params.push(flag01(revenueExcluded)); }
    if (fields.length === 0) return res.json(fail('没有需要修改的内容'));

    const prevPayable = Number(order.payable_amount) || 0;
    params.push(now(), id);
    // 改价与支付流水同步必须同事务：中途失败会留下「订单已改价、流水仍旧金额」的对账裂缝
    db.transaction(() => {
      if (syncPaymentAmount !== null) {
        // 退款流水必须排除（payments.status='refunded'），否则改价会连带改写退款金额/符号，账目净额算错
        db.prepare("UPDATE payments SET amount = ? WHERE order_id = ? AND status <> 'refunded'").run(syncPaymentAmount, id);
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
            salesperson: salesperson !== undefined ? String(salesperson).trim() : order.salesperson,
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

    // 权限：管理员可取消任意订单；销售仅可取消自己名下的订单；家长仅可取消自己的待支付订单
    if (!isAdminReq(req)) {
      if (canSales(req)) {
        if (!canOperateOrder(req, order)) return res.status(403).json(safeFail('仅可取消自己名下的订单'));
      } else {
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
    }

    const currentTime = now();
    // 并发下本次取消是否真正生效；失败时 dupReason 给出原因（事务内赋值，事务外统一返回）
    let cancelled = true;
    let dupReason = null;
    // 已支付订单的资金回滚（会员卡、积分、支付流水、订单状态）整体事务化：
    // 中途抛错不再留下「卡已回收但订单仍 paid」的半回滚状态
    db.transaction(() => {
      // 事务内重读订单：事务外那份快照在并发下可能已过期（典型：并发的 POST /:id/pay
      // 刚把 pending 置为 paid）。若仍按旧快照判断，会把「已支付」误判成「未支付」，
      // 跳过卡/积分/流水回滚只置 cancelled —— 卡仍 active、流水仍 success、积分未回收，
      // 且此后 refund 要求 status==='paid' 已够不到，卡和钱都追不回。
      const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!fresh) { cancelled = false; dupReason = '订单不存在'; return; }
      if (fresh.status === 'cancelled' || fresh.status === 'refunded') {
        cancelled = false; dupReason = '订单已取消或已退款'; return;
      }

      // 原子认领：仅当状态仍是刚重读到的值时才置 cancelled，防止与并发 pay/refund 撕裂。
      // 先认领再回滚权益——认领失败说明状态已被他人改动，此时绝不能回滚别人的权益。
      const claim = db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = ?")
        .run(currentTime, id, fresh.status);
      if (claim.changes === 0) {
        // 重读后仍失败：状态被并发请求改写，重新判定并给出恰当结果
        const cur = db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
        cancelled = false;
        dupReason = (cur && (cur.status === 'cancelled' || cur.status === 'refunded'))
          ? '订单已取消或已退款'
          : '订单状态已变更，请刷新后重试';
        return;
      }

      if (fresh.status === 'paid') {
        // 回滚会员卡：必须同时回收暂停中的卡（status='paused'）——只回收 active 会让
        // 「钱退了、卡暂停着还能恢复使用」，权益逃逸。
        const cards = db.prepare("SELECT * FROM member_cards WHERE order_id = ? AND status IN ('active','paused')").all(id);
        for (const card of cards) {
          // P1-21：状态置 cancelled 之外还要清零剩余权益，与退款分支同一台账口径。
          // 只置状态会让「剩余课时/有效期」留在卡上，台账与恒等式(total=remaining+used)失真。
          if ((card.billing_mode || 'time') === 'count') {
            db.prepare("UPDATE member_cards SET status = 'cancelled', used_classes = used_classes + remaining_classes, remaining_classes = 0, updated_at = ? WHERE id = ?").run(currentTime, card.id);
          } else {
            db.prepare("UPDATE member_cards SET status = 'cancelled', expires_at = ?, updated_at = ? WHERE id = ?").run(currentTime, currentTime, card.id);
          }
        }
        // 回收购买赠送的积分（按 订单+商品 维度查找）
        const logs = db.prepare("SELECT * FROM point_logs WHERE reference_id GLOB ? AND type = 'earn'").all('order_' + id + '*');
        let totalCancelReward = 0;
        for (const l of logs) {
          totalCancelReward += Number(l.amount) || 0;
          // 翻转 earn → refund 保留：既让该笔奖励不再计入「本周获得积分」，
          // 也使重复取消时下面的 type='earn' 查询落空（幂等保护）。
          db.prepare("UPDATE point_logs SET type = 'refund', description = '订单取消回收积分' WHERE id = ?").run(l.id);
        }
        if (totalCancelReward > 0) {
          // 与全额退款回收同一口径：余额不足时只能扣到 0，流水必须记实际生效量 -actual，
          // 否则 SUM(point_logs.amount) 与 points.balance 永久对不上。
          const acc = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(fresh.student_id);
          const actual = Math.min(totalCancelReward, (acc && acc.balance) || 0);
          if (actual > 0) {
            const newBal = ((acc && acc.balance) || 0) - actual; // actual ≤ balance，结果自然 ≥ 0
            db.prepare(`
              UPDATE points SET
                total_earned = MAX(0, total_earned - ?),
                balance = ?,
                updated_at = ?
              WHERE student_id = ?
            `).run(actual, newBal, currentTime, fresh.student_id);
            db.prepare(`
              INSERT INTO point_logs (id, student_id, type, amount, balance, reference_id, reason, description, created_at)
              VALUES (?, ?, 'refund', ?, ?, ?, '订单取消回收积分', '订单取消回收积分', ?)
            `).run(generateId('PLG'), fresh.student_id, -actual, newBal, 'order_' + id, currentTime);
          }
        }
        db.prepare("UPDATE payments SET status = 'refunded' WHERE order_id = ?").run(id);
        // 已付订单的「取消」在资金上就是一次全额退款：必须落退款额与退款时间。
        // 否则该单会从财务口径（status IN ('paid','refunded')）里整体消失 ——
        // 原支付月份的收入被静默改写，且没有任何退款行抵消。
        db.prepare(`
          UPDATE orders SET status = 'refunded', refunded_amount = payable_amount,
            last_refunded_at = ?, updated_at = ?
          WHERE id = ?
        `).run(currentTime, currentTime, id);
        // 冲销该单已确认的收入结转：不删会出现「已收归零、已确认保留」→ 合同负债为负。
        // 表由迁移 017 建立，老库可能不存在 —— 先判存在，不存在时静默跳过（与退款路径同口径）。
        try {
          const hasRecognitionTable = db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revenue_recognitions'"
          ).get();
          if (hasRecognitionTable) {
            db.prepare('DELETE FROM revenue_recognitions WHERE order_id = ?').run(id);
          }
        } catch (e) {
          console.error('[orders cancel] 冲销结转记录失败', e && e.message);
        }
        // Cancelling a paid order rolls back money — same audit as refund
        recordAudit(db, {
          entity: 'order',
          entityId: id,
          action: 'cancel_paid',
          actorId: getOpenId(req),
          actorRole: req.userRole || '',
          before: { status: 'paid', payable_amount: fresh.payable_amount },
          after: { status: 'refunded', refunded_amount: fresh.payable_amount },
        });
      } else {
        // 取消未支付订单：无资金回滚，但仍是状态变更，留痕以便追溯「谁取消了谁的单」
        recordAudit(db, {
          entity: 'order',
          entityId: id,
          action: 'cancel',
          actorId: getOpenId(req),
          actorRole: req.userRole || '',
          before: { status: fresh.status },
          after: { status: 'cancelled' },
        });
      }
    })();
    if (!cancelled) return res.json(fail(dupReason || '订单无法取消'));
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
    // 与 finance/summary 同一口径：收入按支付时间(paid_at)、退款按退款发生时间(last_refunded_at)，
    // 两段各自落在区间内再相减。此前用 status='paid' + SUM(payable-refunded) 且按 paid_at 过滤，
    // 导致「跨月/跨年退款」在订单页完全不扣（看板/财务扣了），同一笔业务两套账。
    // 同时补销售作用域：销售只能看本人业绩（此前 /stats 返回全机构，与列表隔离自相矛盾）。
    const admin = isAdminReq(req);
    const myName = admin ? '' : myStaffName(req);
    const scope = admin ? '' : " AND COALESCE(TRIM(salesperson), '') = ?";
    const scopeParams = admin ? [] : [myName];
    const REFUND_TS = 'COALESCE(NULLIF(last_refunded_at, 0), updated_at)';
    const netFor = (from, to) => {
      const inc = db.prepare(`SELECT COALESCE(SUM(payable_amount),0) AS t FROM orders
        WHERE status IN ('paid','refunded') AND order_type != 'refund' AND revenue_excluded = 0
          AND paid_at >= ? AND paid_at < ?${scope}`).get(from, to, ...scopeParams).t;
      const ref = db.prepare(`SELECT COALESCE(SUM(COALESCE(refunded_amount,0)),0) AS t FROM orders
        WHERE status IN ('paid','refunded') AND order_type != 'refund' AND revenue_excluded = 0
          AND COALESCE(refunded_amount,0) > 0
          AND ${REFUND_TS} >= ? AND ${REFUND_TS} < ?${scope}`).get(from, to, ...scopeParams).t;
      return inc - ref;
    };
    res.json(success({
      today: netFor(dayStartMs(today), dayEndMs(today)),
      month: netFor(monthStartMs(month), nextMonthStartMs(month)),
      year: netFor(yearStartMs(year), nextYearStartMs(year)),
    }));
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
    // 业绩隔离：非管理员销售仅见自己名下订单（user_id=本人 openid 或 salesperson=本人昵称）。
    // 需要「销售主管看全团队」时，为其显式授予 sales_all 权限键（默认不开），
    // 避免用「看不见」代替角色区分。
    if (!isAdminReq(req) && canSales(req) && !hasPerm(getReqUser(req), 'sales_all')) {
      const openid = getOpenId(req);
      const me = openid ? db.prepare('SELECT nickname FROM users WHERE openid = ?').get(openid) : null;
      const myName = me && me.nickname ? String(me.nickname).trim() : '';
      where += ' AND (user_id = ? OR salesperson = ?)';
      params.push(openid || '', myName);
    }

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

/**
 * GET /api/orders/:id — 订单详情（P0-12）
 *
 * ⚠️ 必须注册在 `/my`、`/stats`、`/` 之后：Express 按注册顺序匹配，`/:id` 会吞掉它们。
 * 此前缺这个接口，支付后无法按 ID 回读状态/实付/退款累计，订单页、退款单页、对账页链路断开。
 */
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const order = db.prepare('SELECT * FROM orders WHERE id = ? OR order_no = ?').get(id, id);
    if (!order) return res.json(fail('订单不存在'));

    // 权限：管理员与销售可查全部；家长只能查自己孩子的订单
    if (!isAdminReq(req) && !canSales(req)) {
      const openid = getOpenId(req);
      const isOwner = openid && db.prepare(
        'SELECT 1 FROM parent_bindings WHERE student_id = ? AND parent_openid = ? LIMIT 1'
      ).get(order.student_id, openid);
      if (!isOwner) return res.status(403).json(safeFail('无权查看该订单'));
    }

    const cards = db.prepare(`
      SELECT id, card_type_name, billing_mode, status,
             total_classes, remaining_classes, used_classes, activated_at, expires_at
      FROM member_cards WHERE order_id = ? ORDER BY created_at ASC
    `).all(order.id);
    const payments = db.prepare(`
      SELECT id, amount, channel, status, paid_at, created_at
      FROM payments WHERE order_id = ? ORDER BY created_at ASC
    `).all(order.id);

    let items = [];
    try { items = JSON.parse(order.items || '[]'); } catch (e) { items = []; }

    const paidAmount = Number(order.payable_amount) || 0;
    const refundedAmount = Number(order.refunded_amount) || 0;
    res.json(success({
      ...order,
      items,
      paid_amount: paidAmount,
      refunded_amount: refundedAmount,
      refundable: Math.max(0, paidAmount - refundedAmount),
      cards,
      payments,
    }));
  } catch (err) {
    console.error('[orders detail]', err);
    res.status(500).json(safeFail('操作失败，请稍后重试'));
  }
});

// 供支付回调等路径复用：仅在订单已 paid 后授予会员卡/积分（不在本模块外重复标记订单状态）
router.grantOrderBenefits = grantOrderBenefits;

module.exports = router;
