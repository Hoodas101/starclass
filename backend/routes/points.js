/**
 * 积分路由 — 积分余额、加积分、消耗积分、积分流水、排行榜
 * GET  /api/points/balance  — 积分余额
 * POST /api/points/add      — 加积分
 * POST /api/points/consume  — 消耗积分
 * GET  /api/points/logs     — 积分流水
 * GET  /api/points/ranking  — 排行榜
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, now, parsePagination, isAdminReq, isStaffReq, canViewStudentData, recordAudit } = require('../utils');
const { computeExpiry } = require('../utils/points-expiry');
// P1-9：已归档/已删除学员不得发放积分（与上课链路同一判定）
const { ACTIVE_STUDENT_SQL } = require('../utils/student-state');

/**
 * GET /api/points/balance — 积分余额
 * Query: { studentId } 或通过 openid 查询主绑定成员
 */
router.get('/balance', (req, res) => {
  try {
    const openid = getOpenId(req);
    const { studentId } = req.query;

    let points;
    if (studentId) {
      // 防越权：家长仅可查看自己绑定的成员；管理端工作人员可查看
      if (!canViewStudentData(req, studentId)) {
        return res.status(403).json(safeFail('无权查看该成员的积分'));
      }
      points = db.prepare('SELECT * FROM points WHERE student_id = ?').get(studentId);
    } else if (openid) {
      // 查找主绑定成员
      const bind = db.prepare(
        'SELECT student_id FROM parent_bindings WHERE parent_openid = ? AND is_main = 1'
      ).get(openid);
      if (bind) {
        points = db.prepare('SELECT * FROM points WHERE student_id = ?').get(bind.student_id);
      }
    }

    res.json(success(points || { total_earned: 0, total_consumed: 0, balance: 0 }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * POST /api/points/add — 加积分
 * Body: { studentId, amount, reason, referenceId }
 * 支持幂等：传入 referenceId 时若已存在则不重复加
 */
router.post('/add', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可发放积分'));
    const { studentId, reason = '', referenceId = '' } = req.body;
    let amount = req.body.amount;
    // P0-7：ID 传对象/数组会一路传到 sqlite 绑定层抛 TypeError → HTTP 500（误报成服务故障）
    if (typeof studentId !== 'string' && typeof studentId !== 'number') {
      return res.json(fail('成员ID格式不正确'));
    }
    if (amount === undefined || amount === null || amount === '') return res.json(fail('成员ID和积分数不能为空'));
    // P1-4 / P1-12：积分必须是正整数。此前只判 >0，1.5 可穿透 → points.balance 出现小数，
    // 而消费流水按整数记，导致 SUM(point_logs.amount) ≠ points.balance 永久失配且无自愈。
    amount = Number(amount);
    if (!Number.isInteger(amount) || amount <= 0) return res.json(fail('积分必须为正整数'));
    if (amount > 100000) return res.json(fail('单次积分不能超过 100000'));

    const student = db.prepare(`SELECT s.name FROM students s WHERE s.id = ? AND ${ACTIVE_STUDENT_SQL}`).get(studentId);
    if (!student) return res.json(fail('成员不存在或已归档'));

    const currentTime = now();
    // 幂等检查 + 建账/累加 + 流水写入同事务原子完成：
    // 读-改-写分离时并发发放会丢更新，referenceId 去重也存在检查后插入的竞态窗口。
    const result = db.transaction(() => {
      if (referenceId) {
        const exist = db.prepare('SELECT id FROM point_logs WHERE reference_id = ?').get(referenceId);
        if (exist) {
          const acc = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId);
          return { duplicated: true, balance: acc ? acc.balance : 0 };
        }
      }
      const existAcc = db.prepare('SELECT id, balance FROM points WHERE student_id = ?').get(studentId);
      const beforeBalance = existAcc ? existAcc.balance : 0;
      if (!existAcc) {
        db.prepare('INSERT INTO points (id, student_id, student_name, total_earned, balance, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(generateId('PTS'), studentId, student.name, amount, amount, currentTime);
      } else {
        db.prepare('UPDATE points SET total_earned = total_earned + ?, balance = balance + ?, updated_at = ? WHERE student_id = ?')
          .run(amount, amount, currentTime, studentId);
      }
      const points = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId);
      db.prepare('INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, created_at, expire_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(generateId('PLG'), studentId, 'earn', amount, points.balance, reason, referenceId, currentTime, computeExpiry(currentTime));
      // 积分可兑换属有价资产，管理员手工发放必须留痕，事后可查到是谁加了多少
      recordAudit(db, {
        entity: 'points',
        entityId: studentId,
        action: 'add',
        actorId: getOpenId(req),
        actorRole: req.userRole || '',
        before: { points: beforeBalance },
        after: { points: points.balance, delta: amount },
      });
      return { balance: points.balance, added: amount };
    })();

    res.json(success(result));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * POST /api/points/consume — 消耗积分
 * Body: { studentId, amount, reason, referenceId }
 */
router.post('/consume', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可扣减积分'));
    const { studentId, reason = '', referenceId = '' } = req.body;
    let amount = req.body.amount;
    // P0-7：ID 传对象/数组会一路传到 sqlite 绑定层抛 TypeError → HTTP 500（误报成服务故障）
    if (typeof studentId !== 'string' && typeof studentId !== 'number') {
      return res.json(fail('成员ID格式不正确'));
    }
    if (amount === undefined || amount === null || amount === '') return res.json(fail('成员ID和积分数不能为空'));
    // P1-4 / P1-12：积分必须是正整数。此前只判 >0，1.5 可穿透 → points.balance 出现小数，
    // 而消费流水按整数记，导致 SUM(point_logs.amount) ≠ points.balance 永久失配且无自愈。
    amount = Number(amount);
    if (!Number.isInteger(amount) || amount <= 0) return res.json(fail('积分必须为正整数'));
    if (amount > 100000) return res.json(fail('单次积分不能超过 100000'));

    const points = db.prepare('SELECT * FROM points WHERE student_id = ?').get(studentId);
    if (!points || points.balance < amount) return res.json(fail('积分余额不足'));

    // 余额校验与扣减、流水写入在同一事务内原子完成：
    // better-sqlite3 单写连接下，事务持有写锁，避免并发扣减绕过余额检查。
    const currentTime = now();
    db.transaction(() => {
      const current = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId);
      if (!current || current.balance < amount) {
        const err = new Error('积分余额不足');
        err.code = 'INSUFFICIENT';
        throw err;
      }
      db.prepare('UPDATE points SET total_consumed = total_consumed + ?, balance = balance - ?, updated_at = ? WHERE student_id = ?')
        .run(amount, amount, currentTime, studentId);
      const updated = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId);
      // 记录流水
      db.prepare('INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, created_at, expire_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(generateId('PLG'), studentId, 'consume', amount, updated.balance, reason, referenceId, currentTime, null);
      // 积分可兑换属有价资产，管理员手工扣减必须留痕，事后可查到是谁扣了多少
      recordAudit(db, {
        entity: 'points',
        entityId: studentId,
        action: 'consume',
        actorId: getOpenId(req),
        actorRole: req.userRole || '',
        before: { points: current.balance },
        after: { points: updated.balance, delta: -amount },
      });
      return updated.balance;
    })();

    const finalBalance = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId);
    res.json(success({ balance: finalBalance.balance, consumed: amount }));
  } catch (err) {
    if (err && err.code === 'INSUFFICIENT') return res.json(fail('积分余额不足'));
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/points/logs — 积分流水
 * Query: { studentId, type, page, pageSize }
 */
router.get('/logs', (req, res) => {
  try {
    const { studentId: rawStudentId, type } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);

    // 未指定成员时，仅允许查看自己主绑定成员的流水；无绑定则返回空，避免越权查看他人数据
    let studentId = rawStudentId;
    // 指定成员时同样校验归属，防止家长传他人 studentId 越权查看
    if (studentId && !canViewStudentData(req, studentId)) {
      return res.status(403).json(safeFail('无权查看该成员的积分流水'));
    }
    if (!studentId) {
      const openid = getOpenId(req);
      const bind = openid
        ? db.prepare('SELECT student_id FROM parent_bindings WHERE parent_openid = ? AND is_main = 1').get(openid)
        : null;
      if (!bind) return res.json(success({ list: [], total: 0, page, pageSize }));
      studentId = bind.student_id;
    }

    let where = 'WHERE 1=1';
    const params = [];

    if (studentId) { where += ' AND student_id = ?'; params.push(studentId); }
    if (type) { where += ' AND type = ?'; params.push(type); }

    const total = db.prepare(`SELECT COUNT(*) as count FROM point_logs ${where}`).get(...params).count;
    const list = db.prepare(`
      SELECT * FROM point_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/points/ranking — 排行榜
 * Query: { limit }（默认 20）
 */
router.get('/ranking', (req, res) => {
  try {
    if (!isStaffReq(req)) return res.status(403).json(safeFail('无积分排行榜查看权限'));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    // 当前登录者（家长）的主绑定成员，用于排行榜"我"的高亮
    let myStudentId = null;
    const openid = getOpenId(req);
    if (openid) {
      const bind = db.prepare(
        'SELECT student_id FROM parent_bindings WHERE parent_openid = ? AND is_main = 1'
      ).get(openid);
      if (bind) myStudentId = bind.student_id;
    }

    // 本周一 00:00 起（排行榜口径：本周获得积分，而非总余额）
    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    const wd = weekStart.getDay();
    weekStart.setDate(weekStart.getDate() - (wd === 0 ? 6 : wd - 1));
    const weekStartTs = weekStart.getTime();

    const list = db.prepare(`
      SELECT p.student_id, p.student_name, p.balance AS balance,
        -- checkin 是签到积分（最大的来源），只算 earn 会让活跃学员在排行榜上全是 0
        COALESCE(SUM(CASE WHEN pl.created_at >= ? AND pl.type IN ('earn', 'checkin') THEN pl.amount ELSE 0 END), 0) AS points
      FROM points p
      LEFT JOIN point_logs pl ON pl.student_id = p.student_id
      GROUP BY p.student_id
      ORDER BY points DESC, p.balance DESC
      LIMIT ?
    `).all(weekStartTs, limit);

    const ranked = list.map((item, index) => ({
      rank: index + 1,
      studentId: item.student_id,
      studentName: item.student_name,
      points: item.points || 0,
      // balance 必须是 points.balance（当前可用余额），不能用本周获得 points 顶替 ——
      // 否则排行榜显示的「余额」与积分页/档案页的可用余额对不上（兑换时尤其困惑）。
      balance: item.balance || 0,
      isMe: myStudentId ? item.student_id === myStudentId : false,
    }));

    res.json(success({ list: ranked }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * 读取「分享训练」积分 —— 与 checkin.js 的 getPointsRule() 同口径的唯一取值入口。
 *
 * settings.points_rules 的真实形态是**规则数组**（见 settings.js 的 DEFAULT_POINTS_RULES）：
 *   [{ name: '训练签到', enabled: true, points: 10, description: '…' }, …]
 * 设置页写入的也是这一形态，故按 `name` 关键字「分享」匹配「分享训练」档。
 *
 * 兜底原则（与签到保持一致）：
 *   · 键不存在 / JSON 畸形 / 非数组 / 无匹配档 / points 非数字 → 回退 20（老部署行为不变）
 *   · enabled === false → 返回 0，即管理员在设置页停用了该档 → 不发分
 * 不缓存 —— 管理员在设置页改动后下一次分享即生效。
 *
 * @returns {number} 非负整数积分（0 表示该档已停用）
 */
function getSharePointsRule() {
  const DEF = 20;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('points_rules');
    if (!row || row.value === undefined || row.value === null || row.value === '') return DEF;
    let parsed;
    try { parsed = JSON.parse(row.value); } catch (e) { return DEF; }
    if (!Array.isArray(parsed)) return DEF;

    const rule = parsed.find((r) => r && typeof r === 'object'
      && typeof r.name === 'string' && r.name.includes('分享'));
    if (!rule) return DEF;
    // enabled === false 视为管理员停发该档积分（字段缺省视为启用）
    if (rule.enabled === false) return 0;

    const n = Number(rule.points);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEF;
  } catch (e) {
    console.error('[points share rule]', e && e.stack ? e.stack : e);
    return DEF;
  }
}

/**
 * 分享凭证（2026-10-17）
 *
 * 此前 `POST /api/points/share` 没有任何凭证：任一登录用户每周调一次即可白拿积分，
 * 而积分可兑换实物/课程，等于可脚本化套现。
 *
 * 现要求「先申请一次性凭证 → 再凭凭证领取」：凭证与 openid + 自然周绑定，10 分钟过期、
 * 只能用一次。它能挡掉「直接打领取接口」的批量刷分，并让每次领取可追溯到具体凭证。
 *
 * 局限（如实记录）：微信不提供「分享成功」回调，所以这仍是客户端自证 —— 凭证本身
 * 不能证明用户真的分享了。若要强证明，需改为「分享链接被**他人**打开后才计入」。
 */
const SHARE_TICKETS = new Map();
const SHARE_TICKET_TTL = 10 * 60 * 1000;

function pruneShareTickets(ts) {
  if (SHARE_TICKETS.size < 500) return;
  for (const [k, v] of SHARE_TICKETS) if (v.expiresAt < ts) SHARE_TICKETS.delete(k);
}

/** POST /api/points/share/ticket — 申请分享凭证（分享动作发起前调用） */
router.post('/share/ticket', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const ts = Date.now();
    pruneShareTickets(ts);
    const weekKey = Math.floor(ts / (7 * 86400000));
    const ticket = crypto.randomBytes(16).toString('hex');
    SHARE_TICKETS.set(ticket, { openid, weekKey, expiresAt: ts + SHARE_TICKET_TTL, used: false });
    res.json(success({ ticket, expiresAt: ts + SHARE_TICKET_TTL }));
  } catch (err) {
    res.status(500).json(safeFail('操作失败，请稍后重试'));
  }
});

/**
 * POST /api/points/share — 分享训练获得积分（每周 1 次，积分数读设置项，未配置回退 20，幂等）
 * 家长分享小程序/训练页面成功后调用
 */
router.post('/share', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));

    const weekKey = Math.floor(Date.now() / (7 * 86400000));
    const refId = `share_${openid}_${weekKey}`;

    // 分享凭证：必须由 /share/ticket 签发，且与本人、本自然周绑定，单次有效
    const { ticket } = req.body || {};
    const tk = typeof ticket === 'string' ? SHARE_TICKETS.get(ticket) : null;
    // F4-1：把「已使用」与「无效/过期/跨周/跨人」拆开。
    // 此前两者混在一个分支，家长手指连点或再次打开同一张分享卡片时，
    // 会被告知「凭证无效」并引导反复重新分享 —— 而真实情况是「本周已经领过了」。
    // 注意顺序：先校验凭证本身是否属于本人/本周/未过期，再看是否已使用。
    if (!tk || tk.expiresAt < Date.now() || tk.openid !== openid || tk.weekKey !== weekKey) {
      return res.json(fail('分享凭证无效或已过期，请重新发起分享'));
    }
    if (tk.used) {
      const already = db.prepare('SELECT id FROM point_logs WHERE reference_id = ?').get(refId);
      // 已使用且本周确实到账 → 幂等成功（不再误导为凭证失效）
      if (already) return res.json(success({ added: 0, duplicated: true, message: '本周已领取分享积分' }));
      // 已使用但本周没有流水（上次发分失败 / 规则被停用）→ 仍要求重新发起，避免"白领"
      return res.json(fail('分享凭证已使用，请重新发起分享'));
    }
    tk.used = true;

    // 积分取值改为读设置项 points_rules（原先硬编码 20，管理员在设置页改了不生效）
    const amount = getSharePointsRule();
    // 该档被管理员停用：不发分，且与「本周已领取」区分开，避免误导家长以为已领过
    if (amount <= 0) {
      return res.json(success({ added: 0, disabled: true, message: '分享积分规则已停用' }));
    }

    // 幂等检查 + 发分 + 流水在同一事务内原子完成：
    // 避免并发分享请求同时通过幂等检查而重复发分（reference_id 会被其他业务复用，故不加唯一索引）。
    const currentTime = now();
    const added = db.transaction(() => {
      const exist = db.prepare('SELECT id FROM point_logs WHERE reference_id = ?').get(refId);
      if (exist) return 0;

      const bind = db.prepare(
        'SELECT student_id FROM parent_bindings WHERE parent_openid = ? AND is_main = 1 LIMIT 1'
      ).get(openid);
      if (!bind) {
        const err = new Error('请先绑定成员');
        err.code = 'NOT_BOUND';
        throw err;
      }

      const student = db.prepare('SELECT name FROM students WHERE id = ?').get(bind.student_id);
      const acc = db.prepare('SELECT id FROM points WHERE student_id = ?').get(bind.student_id);
      if (!acc && student) {
        db.prepare('INSERT INTO points (id, student_id, student_name, total_earned, balance, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(generateId('PTS'), bind.student_id, student.name, amount, amount, currentTime);
      } else {
        db.prepare('UPDATE points SET total_earned = total_earned + ?, balance = balance + ?, updated_at = ? WHERE student_id = ?')
          .run(amount, amount, currentTime, bind.student_id);
      }
      const balance = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(bind.student_id)?.balance || amount;
      db.prepare('INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(generateId('PLG'), bind.student_id, 'earn', amount, balance, '分享训练获得积分', refId, '分享训练（每周1次）', currentTime);
      return { amount, balance };
    })();

    if (added === 0) return res.json(success({ duplicated: true, message: '本周已领取分享积分' }));
    res.json(success({ added: added.amount, balance: added.balance }));
  } catch (err) {
    if (err && err.code === 'NOT_BOUND') return res.json(fail('请先绑定成员'));
    res.status(500).json(safeFail('操作失败，请稍后重试'));
  }
});

/**
 * GET /api/points/rules — 积分规则（家长端可见，读取 Web 管理端配置，未配置时返回默认规则）
 */
router.get('/rules', (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'points_rules'").get();
    let configured = [];
    if (row && row.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) configured = parsed;
      } catch (e) { /* 损坏配置走默认 */ }
    }

    const PER_DAY_HINT = {
      '训练签到': '每次活动',
      '分享训练': '每周1次',
      '购买产品送积分': '体验10 / 月卡20 / 季卡50 / 年卡120',
    };
    const ICON_MAP = {
      '训练签到': 'check',
      '分享训练': 'share',
      '购买产品送积分': 'card',
    };
    const DEFAULT_RULES = [
      { icon: 'check', action: '训练签到', points: '+10', desc: '参与活动训练由管理端/教练端点名签到', perDay: '每次活动' },
      { icon: 'share', action: '分享训练', points: '+20', desc: '分享训练至微信好友或群', perDay: '每周1次' },
      { icon: 'card', action: '购买产品送积分', points: '10-120', desc: '购买产品与服务由管理端销售登记发放', perDay: '体验10 / 月卡20 / 季卡50 / 年卡120' },
    ];

    const enabled = configured.filter((r) => r && r.enabled !== false);
    const list = enabled.length
      ? enabled.map((r) => ({
          icon: ICON_MAP[r.name] || 'star',
          action: r.name || '积分规则',
          points: r.points != null ? `+${String(r.points).replace(/^\+/, '')}` : '+10',
          desc: r.description || '',
          perDay: PER_DAY_HINT[r.name] || '',
        }))
      : DEFAULT_RULES;

    res.json(success({ list }));
  } catch (err) {
    res.status(500).json(safeFail('获取积分规则失败'));
  }
});

module.exports = router;
