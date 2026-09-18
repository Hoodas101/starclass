/**
 * 增长路由 — 销售漏斗 / 线索管理 / 流失预警 / 续费预警 / 转介绍 / 积分管理
 * 全部接口仅管理员可访问
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, now, parsePagination, hasPerm, getReqUser, escapeLike, isAdminReq } = require('../utils');
const leadSuggestions = require('../utils/lead-suggestions');

// 增长中心权限：管理员或拥有「growth」权限的员工（销售等）
function canGrowth(req) {
  return isAdminReq(req) || hasPerm(getReqUser(req), 'growth');
}

// leads 表由 db/init.js 创建，stage_changed_at 列已收编至 migrations/014
// （此前此处另有 CREATE TABLE / CREATE INDEX / ALTER，均为冗余或静默空操作）

const STAGE_TEXT = { new: '新线索', contacted: '已联系', trial: '体验中', deal: '已成交', lost: '已流失' };

function formatLead(row) {
  if (!row) return null;
  return {
    ...row,
    stageText: STAGE_TEXT[row.stage] || row.stage,
  };
}

/**
 * GET /api/growth/funnel — 销售漏斗概览
 */
router.get('/funnel', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));

    const stages = ['new', 'contacted', 'trial', 'deal', 'lost'];
    const counts = {};
    for (const s of stages) {
      counts[s] = db.prepare('SELECT COUNT(*) as count FROM leads WHERE stage = ?').get(s).count;
    }

    // 待跟进线索（next_follow_at <= now 或为空且近期新建）
    const followUp = db.prepare(`
      SELECT COUNT(*) as count FROM leads
      WHERE status = 'active' AND stage IN ('new','contacted','trial')
        AND (next_follow_at IS NULL OR next_follow_at <= ?)
    `).get(now()).count;

    // 本月成交（orders）
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const monthOrder = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(payable_amount), 0) as amount FROM orders
      WHERE status = 'paid' AND paid_at >= ?
    `).get(monthStart.getTime());

    // 本月新增线索
    const monthLeads = db.prepare('SELECT COUNT(*) as count FROM leads WHERE created_at >= ?').get(monthStart.getTime()).count;

    const totalActive = counts.new + counts.contacted + counts.trial;
    const conversion = totalActive + counts.deal > 0
      ? Math.round((counts.deal / (totalActive + counts.deal)) * 1000) / 10
      : 0;

    res.json(success({
      stages: stages.map((s) => ({ stage: s, label: STAGE_TEXT[s], count: counts[s] })),
      followUp,
      monthOrder,
      monthLeads,
      conversion,
    }));
  } catch (err) {
    res.status(500).json(safeFail('获取漏斗数据失败'));
  }
});

/**
 * GET /api/growth/leads — 线索列表
 * Query: { keyword, stage, source, status, page, pageSize }
 */
router.get('/leads', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const { keyword, stage, source, status, startDate, endDate } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);

    let where = 'WHERE 1=1';
    const params = [];
    if (keyword) { where += ` AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')`; params.push(`%${escapeLike(keyword)}%`, `%${escapeLike(keyword)}%`); }
    if (stage) { where += ' AND stage = ?'; params.push(stage); }
    if (source) { where += ' AND source = ?'; params.push(source); }
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (startDate) { where += ' AND created_at >= ?'; params.push(new Date(startDate + 'T00:00:00').getTime()); }
    if (endDate) { where += ' AND created_at <= ?'; params.push(new Date(endDate + 'T23:59:59.999').getTime()); }

    const total = db.prepare(`SELECT COUNT(*) as count FROM leads ${where}`).get(...params).count;
    const list = db.prepare(`
      SELECT * FROM leads ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset).map(formatLead);

    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    res.status(500).json(safeFail('获取线索失败'));
  }
});

/**
 * POST /api/growth/leads — 新建线索
 */
router.post('/leads', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const { name, phone = '', source = 'natural', stage = 'new', intentLevel = 3, nextFollowAt, note = '', salesperson = '', studentId = '' } = req.body;
    if (!name) return res.json(fail('姓名不能为空'));
    const t = now();
    const id = generateId('LEAD');
    db.prepare(`
      INSERT INTO leads (id, name, phone, source, stage, intent_level, next_follow_at, note, salesperson, student_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, name, phone, source, stage, Math.min(5, Math.max(1, parseInt(intentLevel) || 3)), nextFollowAt || null, note, salesperson, studentId || '', t, t);
    res.json(success({ id }));
  } catch (err) {
    res.status(500).json(safeFail('创建线索失败'));
  }
});

/**
 * PUT /api/growth/leads/:id — 更新线索
 */
router.put('/leads/:id', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!row) return res.json(fail('线索不存在'));
    const { name, phone, source, stage, intentLevel, nextFollowAt, note, salesperson, status, studentId } = req.body;
    const merged = {
      name: name !== undefined ? name : row.name,
      phone: phone !== undefined ? phone : row.phone,
      source: source !== undefined ? source : row.source,
      stage: stage !== undefined ? stage : row.stage,
      intentLevel: intentLevel !== undefined ? Math.min(5, Math.max(1, parseInt(intentLevel) || 3)) : row.intent_level,
      nextFollowAt: nextFollowAt !== undefined ? nextFollowAt : row.next_follow_at,
      note: note !== undefined ? note : row.note,
      salesperson: salesperson !== undefined ? salesperson : row.salesperson,
      status: status !== undefined ? status : row.status,
      studentId: studentId !== undefined ? studentId : (row.student_id || ''),
    };
    // 阶段与转化状态同步：任一入口（Web/小程序）把阶段推进到 deal/lost 时，
    // 统一标记 converted/lost 与转化时间，保证转介绍统计与漏斗口径一致
    if (stage === 'deal') {
      merged.status = 'converted';
      if (!row.converted_at) merged.convertedAt = now();
    } else if (stage === 'lost') {
      merged.status = 'lost';
    }
    db.prepare(`
      UPDATE leads SET name = ?, phone = ?, source = ?, stage = ?, intent_level = ?, next_follow_at = ?, note = ?, salesperson = ?, student_id = ?, status = ?,
        converted_at = COALESCE(?, converted_at), updated_at = ?
      WHERE id = ?
    `).run(merged.name, merged.phone, merged.source, merged.stage, merged.intentLevel, merged.nextFollowAt, merged.note, merged.salesperson, merged.studentId, merged.status, merged.convertedAt || null, now(), req.params.id);
    res.json(success({ id: req.params.id }));
  } catch (err) {
    res.status(500).json(safeFail('更新线索失败'));
  }
});

/**
 * DELETE /api/growth/leads/:id — 删除线索
 */
router.delete('/leads/:id', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
    res.json(success({ id: req.params.id }));
  } catch (err) {
    res.status(500).json(safeFail('删除线索失败'));
  }
});

/**
 * POST /api/growth/leads/:id/convert — 线索转成交（可选发放奖励积分）
 * Body: { rewardPoints, rewardReason }
 */
router.post('/leads/:id/convert', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!row) return res.json(fail('线索不存在'));
    if (row.status === 'converted') return res.json(fail('该线索已成交，请勿重复转化'));
    const t = now();
    const { rewardPoints, rewardReason = '线索成交奖励' } = req.body;
    // 状态流转与奖励发放同事务：此前分两步，发奖失败时线索已标记成交，
    // 再点会命中「已成交」拒绝，奖励永远补不上（且读-改-写积分账户存在竞态）。
    const bonus = db.transaction(() => {
      const guarded = db.prepare(`
        UPDATE leads SET stage = 'deal', status = 'converted', converted_at = ?, updated_at = ?
        WHERE id = ? AND status != 'converted'
      `).run(t, t, req.params.id);
      if (guarded.changes === 0) return { err: '该线索已成交，请勿重复转化' };

      if (rewardPoints && parseInt(rewardPoints) > 0 && row.student_id) {
        const student = db.prepare('SELECT name FROM students WHERE id = ?').get(row.student_id);
        if (student) {
          const existAcc = db.prepare('SELECT id FROM points WHERE student_id = ?').get(row.student_id);
          if (!existAcc) {
            db.prepare('INSERT INTO points (id, student_id, student_name, total_earned, balance, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
              .run(generateId('PTS'), row.student_id, student.name, rewardPoints, rewardPoints, t);
          } else {
            db.prepare('UPDATE points SET total_earned = total_earned + ?, balance = balance + ?, updated_at = ? WHERE student_id = ?')
              .run(rewardPoints, rewardPoints, t, row.student_id);
          }
          const balance = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(row.student_id).balance;
          db.prepare('INSERT INTO point_logs (id, student_id, type, amount, balance, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(generateId('PLG'), row.student_id, 'earn', rewardPoints, balance, rewardReason, t);
          return { points: rewardPoints, balance };
        }
      }
      return null;
    })();
    if (bonus && bonus.err) return res.json(fail(bonus.err));
    res.json(success({ id: req.params.id, converted: true, bonus }));
  } catch (err) {
    res.status(500).json(safeFail('转化失败'));
  }
});

/**
 * POST /api/growth/leads/:id/stage — 推进线索阶段（销售管道）
 * 借鉴 trycompai/crm 的 Deal pipeline：新线索 → 已联系 → 体验中 → 已成交/已流失
 */
router.post('/leads/:id/stage', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const { stage } = req.body;
    if (!STAGE_TEXT[stage]) return res.json(fail('无效的阶段'));
    const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!row) return res.json(fail('线索不存在'));
    const t = now();
    db.prepare(`
      UPDATE leads SET stage = ?, stage_changed_at = ?, updated_at = ?,
        status = CASE WHEN ? = 'deal' THEN 'converted' WHEN ? = 'lost' THEN 'lost' ELSE status END,
        converted_at = CASE WHEN ? = 'deal' THEN ? ELSE converted_at END
      WHERE id = ?
    `).run(stage, t, t, stage, stage, stage, t, req.params.id);
    res.json(success({ id: req.params.id, stage, stageText: STAGE_TEXT[stage] }));
  } catch (err) {
    console.error('[lead stage]', err);
    res.status(500).json(safeFail('推进阶段失败'));
  }
});

/**
 * GET /api/growth/suggestions — 跟进建议看板（证据→建议，业务层单一计算源）
 * Query: { limit, onlyActionable=0|1 }
 */
router.get('/suggestions', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const onlyActionable = req.query.onlyActionable === '1';
    const list = leadSuggestions.getLeadSuggestions(db, { limit, onlyActionable });
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取跟进建议失败'));
  }
});

/**
 * GET /api/growth/leads/:id/suggestion — 单条线索的跟进建议
 */
router.get('/leads/:id/suggestion', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const s = leadSuggestions.getLeadSuggestion(db, req.params.id);
    if (!s) return res.json(fail('线索不存在'));
    res.json(success(s));
  } catch (err) {
    res.status(500).json(safeFail('获取线索建议失败'));
  }
});

/**
 * GET /api/growth/churn — 流失预警（近 30 天无签到 或 会员卡已过期未续费）
 */
router.get('/churn', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const t = now();
    const since = t - 30 * 86400000;

    const rows = db.prepare(`
      SELECT s.id, s.name,
        (SELECT MAX(a.date) FROM attendances a WHERE a.student_id = s.id) as last_attendance,
        (SELECT MAX(c.expires_at) FROM member_cards c WHERE c.student_id = s.id AND c.status IN ('active','paused')) as last_expires_at
      FROM students s
      WHERE EXISTS (SELECT 1 FROM member_cards c WHERE c.student_id = s.id)
    `).all();

    const list = rows.map((r) => {
      const lastDate = r.last_attendance ? `${r.last_attendance}` : null;
      const lastTs = lastDate ? new Date(lastDate.replace(/-/g, '/')).getTime() : 0;
      const daysSince = lastTs ? Math.floor((t - lastTs) / 86400000) : 999;
      const expired = r.last_expires_at && r.last_expires_at < t;
      const risk = daysSince > 30 || expired ? (daysSince > 60 || expired ? 'high' : 'medium') : 'low';
      return {
        studentId: r.id,
        name: r.name,
        lastAttendance: lastDate || '从未签到',
        daysSince: lastTs ? daysSince : null,
        expired: !!expired,
        risk,
      };
    }).filter((r) => r.risk !== 'low');

    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取流失预警失败'));
  }
});

/**
 * GET /api/growth/renewal — 续费预警（有效期 15 天内 / 已过期未续费）
 */
router.get('/renewal', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const t = now();
    const warnIn = Math.max(1, parseInt(req.query.warnIn) || 15) * 86400000;
    const rows = db.prepare(`
      SELECT c.id, c.student_id, c.card_type_name, c.expires_at, c.status, s.name as student_name,
        (SELECT COUNT(*) FROM attendances a WHERE a.student_id = c.student_id AND a.date >= date('now', 'localtime', '-30 days')) as recent_count
      FROM member_cards c
      JOIN students s ON s.id = c.student_id
      WHERE c.status IN ('active','paused')
      ORDER BY c.expires_at ASC
    `).all();
    const list = rows
      .filter((r) => r.expires_at <= t + warnIn)
      .map((r) => ({
        cardId: r.id,
        studentId: r.student_id,
        studentName: r.student_name,
        cardType: r.card_type_name,
        expiresAt: r.expires_at,
        daysLeft: Math.ceil((r.expires_at - t) / 86400000),
        expired: r.expires_at < t,
        recentAttendance: r.recent_count,
        status: r.status,
      }));
    res.json(success({ list, total: list.length, warnIn }));
  } catch (err) {
    res.status(500).json(safeFail('获取续费预警失败'));
  }
});

/**
 * GET /api/growth/low-classes — 低课时预警（剩余课时不足）
 * Query: { threshold }（默认 5）
 */
router.get('/low-classes', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const threshold = Math.max(1, parseInt(req.query.threshold) || 5);
    const list = db.prepare(`
      SELECT mc.id, mc.student_id, mc.card_type_name, mc.billing_mode, mc.remaining_classes, mc.expires_at, mc.status,
        s.name as student_name,
        (SELECT COUNT(*) FROM attendances a WHERE a.student_id = mc.student_id AND a.date >= date('now', 'localtime', '-30 days')) as recent_count
      FROM member_cards mc
      JOIN students s ON s.id = mc.student_id
      WHERE mc.status = 'active' AND mc.billing_mode = 'count' AND mc.remaining_classes <= ? AND mc.remaining_classes > 0
      ORDER BY mc.remaining_classes ASC
    `).all(threshold);
    res.json(success({ list, total: list.length, threshold }));
  } catch (err) {
    res.status(500).json(safeFail('获取低课时预警失败'));
  }
});

/**
 * GET /api/growth/referrals — 转介绍统计
 */
router.get('/referrals', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const rows = db.prepare(`SELECT * FROM leads WHERE source = 'referral' ORDER BY created_at DESC LIMIT 200`).all();
    const converted = rows.filter((r) => r.status === 'converted').length;
    res.json(success({
      total: rows.length,
      converted,
      conversion: rows.length ? Math.round((converted / rows.length) * 1000) / 10 : 0,
      list: rows.map(formatLead),
    }));
  } catch (err) {
    res.status(500).json(safeFail('获取转介绍统计失败'));
  }
});

/**
 * GET /api/growth/points/summary — 积分总览
 */
router.get('/points/summary', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const s = db.prepare(`
      SELECT COUNT(*) as accounts, COALESCE(SUM(total_earned), 0) as totalEarned,
        COALESCE(SUM(total_consumed), 0) as totalConsumed, COALESCE(SUM(balance), 0) as totalBalance
      FROM points
    `).get();
    res.json(success({
      accounts: s.accounts,
      totalEarned: s.totalEarned,
      totalConsumed: s.totalConsumed,
      totalBalance: s.totalBalance,
      avgBalance: s.accounts ? Math.round(s.totalBalance / s.accounts) : 0,
    }));
  } catch (err) {
    res.status(500).json(safeFail('获取积分总览失败'));
  }
});

/**
 * GET /api/growth/points/list — 学员积分列表
 * Query: { keyword, page, pageSize }
 */
router.get('/points/list', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const { keyword } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);
    let where = 'WHERE 1=1';
    const params = [];
    if (keyword) {
      where += ` AND (p.student_name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM parent_bindings pb JOIN users u ON u.openid = pb.parent_openid
                   WHERE pb.student_id = p.student_id AND u.phone LIKE ? ESCAPE '\\'))`;
      params.push(`%${escapeLike(keyword)}%`, `%${escapeLike(keyword)}%`);
    }
    const total = db.prepare(`SELECT COUNT(*) as count FROM points p ${where}`).get(...params).count;
    const list = db.prepare(`
      SELECT p.*, (
        SELECT u.phone FROM parent_bindings pb JOIN users u ON u.openid = pb.parent_openid
        WHERE pb.student_id = p.student_id AND pb.is_main = 1 LIMIT 1
      ) as phone FROM points p
      ${where} ORDER BY p.balance DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    res.status(500).json(safeFail('获取积分列表失败'));
  }
});

/**
 * GET /api/growth/points/logs — 积分明细
 * Query: { studentId, page, pageSize }
 */
router.get('/points/logs', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const { studentId } = req.query;
    if (!studentId) return res.json(fail('缺少成员ID'));
    const { page, pageSize, offset } = parsePagination(req.query);
    const total = db.prepare('SELECT COUNT(*) as count FROM point_logs WHERE student_id = ?').get(studentId).count;
    const list = db.prepare('SELECT * FROM point_logs WHERE student_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(studentId, pageSize, offset);
    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    res.status(500).json(safeFail('获取积分明细失败'));
  }
});

/**
 * POST /api/growth/points/adjust — 手动调整积分（加/减）
 * Body: { studentId, type: 'earn'|'consume', amount, reason }
 */
router.post('/points/adjust', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const { studentId, type, amount, reason = '' } = req.body;
    if (!studentId || !type || !amount || amount <= 0) return res.json(fail('参数不完整'));
    if (!['earn', 'consume'].includes(type)) return res.json(fail('类型无效'));
    const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
    if (!student) return res.json(fail('成员不存在'));
    const t = now();

    if (type === 'consume') {
      const p = db.prepare('SELECT * FROM points WHERE student_id = ?').get(studentId);
      if (!p || p.balance < amount) return res.json(fail('积分余额不足'));
      db.prepare('UPDATE points SET total_consumed = total_consumed + ?, balance = balance - ?, updated_at = ? WHERE student_id = ?')
        .run(amount, amount, t, studentId);
    } else {
      const existAcc = db.prepare('SELECT id FROM points WHERE student_id = ?').get(studentId);
      if (!existAcc) {
        db.prepare('INSERT INTO points (id, student_id, student_name, total_earned, balance, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(generateId('PTS'), studentId, student.name, amount, amount, t);
      } else {
        db.prepare('UPDATE points SET total_earned = total_earned + ?, balance = balance + ?, updated_at = ? WHERE student_id = ?')
          .run(amount, amount, t, studentId);
      }
    }
    const balance = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId)?.balance || 0;
    db.prepare('INSERT INTO point_logs (id, student_id, type, amount, balance, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(generateId('PLG'), studentId, type, amount, balance, reason, t);
    res.json(success({ balance }));
  } catch (err) {
    res.status(500).json(safeFail('调整积分失败'));
  }
});

/**
 * GET /api/growth/points/ranking — 积分排行榜
 */
router.get('/points/ranking', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const list = db.prepare(`
      SELECT student_id, student_name, balance, total_earned
      FROM points ORDER BY balance DESC LIMIT ?
    `).all(limit).map((r, i) => ({ rank: i + 1, studentId: r.student_id, studentName: r.student_name, balance: r.balance, totalEarned: r.total_earned }));
    res.json(success({ list }));
  } catch (err) {
    res.status(500).json(safeFail('获取排行榜失败'));
  }
});

module.exports = router;
