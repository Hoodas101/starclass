/**
 * 增长路由 — 销售漏斗 / 线索管理 / 流失预警 / 续费预警 / 转介绍 / 积分管理
 * 全部接口仅管理员可访问
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, now, parsePagination, hasPerm, getReqUser, escapeLike, isAdminReq, recordAudit, getActor, getOpenId } = require('../utils');
const leadSuggestions = require('../utils/lead-suggestions');
const { getChurnRules } = require('../utils/churn');
// 建档查重（与 POST /api/students 同一判据）
const { findDuplicateStudents } = require('../utils/duplicate');
// 续费 / 课时预警的统一口径常量（与 followups.js 共用同一来源，避免两处阈值各写一份）
const { RENEWAL_WARN_DAYS, LOW_CLASS_THRESHOLD, EXPIRED_WINDOW_DAYS } = require('../utils/renewal');
// 已删除 / 已归档学员的排除条件（三处预警共用同一判据，避免各写一份后逐渐走样）
const { ACTIVE_STUDENT_SQL } = require('../utils/student-state');
const { computeExpiry } = require('../utils/points-expiry');

// 增长中心权限：管理员或拥有「growth」权限的员工（销售等）
function canGrowth(req) {
  return isAdminReq(req) || hasPerm(getReqUser(req), 'growth');
}

// leads 表由 db/init.js 创建，stage_changed_at 列已收编至 migrations/014
// （此前此处另有 CREATE TABLE / CREATE INDEX / ALTER，均为冗余或静默空操作）

const STAGE_TEXT = { new: '新线索', contacted: '已联系', trial: '体验中', deal: '已成交', lost: '已流失' };

// 业绩归属（salesperson）是自由文本且无外键，写入前统一 trim：否则同一员工手输
// 「张三」/「张三 」会在报表（admin.js / finance.js 的 GROUP BY salesperson）里
// 分裂成两个业绩组。此处先保证写入侧不产生新脏数据；读取侧的 TRIM 归一建议见交付报告。
const normSalesperson = (v) => String(v == null ? '' : v).trim();

function formatLead(row) {
  if (!row) return null;
  return {
    ...row,
    stageText: STAGE_TEXT[row.stage] || row.stage,
  };
}

// 会员编号生成：与 students.js 的 nextMemberNo 完全一致 —— 只从现有最大编号继续递增，
// 绝不重排已有编号（编号被 auth.js bindStudent 用于区分同名学员，重排会破坏对账与绑定）。
// 受「本次仅可改动本文件」的范围约束，此处为必要复制；若后续放宽范围，建议抽到 utils 共享。
function nextMemberNo() {
  const rows = db.prepare("SELECT member_no FROM students WHERE member_no LIKE 'NO-%'").all();
  const max = rows
    .map((x) => { const m = /^NO-(\d+)$/.exec(x.member_no || ''); return m ? parseInt(m[1], 10) : 0; })
    .reduce((a, b) => Math.max(a, b), 0);
  return `NO-${String(max + 1).padStart(4, '0')}`;
}

// 线索「已成交」的统一判据 —— 漏斗与转介绍共用同一份，避免两处各用 stage/status 导致
// 同一批线索在漏斗里算成交、在转介绍里不算（两字段可独立漂移：手工改库、旧数据）。
// 选 status='converted' 而非 stage='deal'：status 是「生命周期终态」，PUT /leads/:id 与
// /leads/:id/stage 与 convert 三条写入路径都会同步它；而 stage 只是管道位置，可被任意改回。
const LEAD_CONVERTED_SQL = "status = 'converted'";

/**
 * GET /api/growth/funnel — 销售漏斗概览
 *
 * 口径（本次统一，均为**全量**，响应字段 window 中明确标注）：
 *  - 各阶段计数按 stage 维度，但「已成交」改用 LEAD_CONVERTED_SQL（与转介绍同源）；
 *    「已流失」同理按 status='lost' 计数。排除 status 为 'invalid'/'deleted' 的作废线索，
 *    它们既非在跟、也非成交/流失，计入任何一档都会失真。
 *  - 转化率分母含 lost：deal / (在跟各阶段 + deal + lost)。此前分母不含 lost，
 *    失效率越高转化率反而越好看（把线索丢进 lost 即可「提升」转化率）。
 *  - 另给 lostRate，让失效率单独可见。
 *  - 试听转化率由 trial_bookings 关联计算（试听预约数 → 成交数），与线索漏斗分开，
 *    不再用线索漏斗近似试听效果。
 *  - monthOrder / monthLeads 仍是**当月**口径（经营看板需要当月数字），
 *    故额外给出 monthStages 当月漏斗，避免同屏跨期混算。
 */
router.get('/funnel', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));

    const stages = ['new', 'contacted', 'trial', 'deal', 'lost'];
    // 已成交/已流失按统一的生命周期判据计数；其余阶段按 stage 计数并排除终态线索
    const countByStage = (s) => {
      if (s === 'deal') return db.prepare(`SELECT COUNT(*) c FROM leads WHERE ${LEAD_CONVERTED_SQL}`).get().c;
      if (s === 'lost') return db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'lost'").get().c;
      return db.prepare(
        "SELECT COUNT(*) c FROM leads WHERE stage = ? AND COALESCE(status,'active') NOT IN ('converted','lost','invalid','deleted')"
      ).get(s).c;
    };
    const counts = {};
    for (const s of stages) counts[s] = countByStage(s);

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

    // 当月漏斗：与 monthLeads / monthOrder 同一时间窗（按 created_at），避免全量漏斗与当月成交跨期混算
    const monthCounts = {};
    for (const s of stages) {
      monthCounts[s] = s === 'deal'
        ? db.prepare(`SELECT COUNT(*) c FROM leads WHERE ${LEAD_CONVERTED_SQL} AND created_at >= ?`).get(monthStart.getTime()).c
        : s === 'lost'
          ? db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'lost' AND created_at >= ?").get(monthStart.getTime()).c
          : db.prepare(
            "SELECT COUNT(*) c FROM leads WHERE stage = ? AND COALESCE(status,'active') NOT IN ('converted','lost','invalid','deleted') AND created_at >= ?"
          ).get(s, monthStart.getTime()).c;
    }

    const totalActive = counts.new + counts.contacted + counts.trial;
    // 分母含 lost：失效率越高转化率越低，符合直觉
    const denom = totalActive + counts.deal + counts.lost;
    const conversion = denom > 0 ? Math.round((counts.deal / denom) * 1000) / 10 : 0;
    const lostRate = denom > 0 ? Math.round((counts.lost / denom) * 1000) / 10 : 0;

    // 试听转化率：试听预约（trial_bookings）→ 成交。成交判据为 status='converted'
    // （由 POST /api/trial/:id/convert 写入），与线索漏斗分开统计。
    const trialStat = db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END), 0) AS converted
      FROM trial_bookings
    `).get();
    const trialConversion = trialStat.total
      ? Math.round((trialStat.converted / trialStat.total) * 1000) / 10
      : 0;

    res.json(success({
      stages: stages.map((s) => ({ stage: s, label: STAGE_TEXT[s], count: counts[s] })),
      followUp,
      monthOrder,
      monthLeads,
      conversion,
      lostRate,
      monthStages: stages.map((s) => ({ stage: s, label: STAGE_TEXT[s], count: monthCounts[s] })),
      trial: { total: trialStat.total, converted: trialStat.converted, conversion: trialConversion },
      window: { stages: 'all', monthStages: 'current_month' },
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
    `).run(id, name, phone, source, stage, Math.min(5, Math.max(1, parseInt(intentLevel) || 3)), nextFollowAt || null, note, normSalesperson(salesperson), studentId || '', t, t);
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
      salesperson: salesperson !== undefined ? normSalesperson(salesperson) : row.salesperson,
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
 * POST /api/growth/leads/:id/convert — 线索转成交
 * Body: { rewardPoints, rewardReason, createStudent, createOrder }
 *
 * 向后兼容：不传 createStudent / createOrder 时行为与旧版完全一致 —— 仅把线索翻转为
 * 「已成交」并可选发放奖励积分，响应仍是 { id, converted, bonus }。
 * createStudent === true 且线索尚未关联成员时：同事务内创建成员并回写 leads.student_id；
 * createOrder === true 时：同事务内为该成员建一张 pending 草稿订单（金额 0，待收银台补全）。
 * 缺少必要信息时跳过对应动作，并在返回中给出 studentSkipped / orderSkipped 原因，绝不写占位值。
 */
router.post('/leads/:id/convert', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!row) return res.json(fail('线索不存在'));
    if (row.status === 'converted') return res.json(fail('该线索已成交，请勿重复转化'));
    const t = now();
    const { rewardPoints, rewardReason = '线索成交奖励', createStudent, createOrder, confirmDuplicate, linkStudentId } = req.body || {};
    // 状态流转、建成员、建订单、发奖励同事务：此前分两步，发奖失败时线索已标记成交，
    // 再点会命中「已成交」拒绝，奖励永远补不上（且读-改-写积分账户存在竞态）。
    const result = db.transaction(() => {
      const guarded = db.prepare(`
        UPDATE leads SET stage = 'deal', status = 'converted', converted_at = ?, updated_at = ?
        WHERE id = ? AND status != 'converted'
      `).run(t, t, req.params.id);
      if (guarded.changes === 0) return { err: '该线索已成交，请勿重复转化' };

      const out = { bonus: null, studentId: row.student_id || '', studentSkipped: null, orderId: '', orderSkipped: null };

      // 1) 可选：创建成员（仅在明确要求且线索当前未关联成员时）
      if (createStudent === true && !row.student_id) {
        const name = String(row.name || '').trim();
        const phone = String(row.phone || '').trim();
        if (!name) {
          out.studentSkipped = '线索缺少姓名，未创建成员';
        } else if (!/^1[3-9]\d{9}$/.test(phone)) {
          // 手机号是线索唯一可用的联系方式：缺失/非法时创建出的成员无法绑定家长、无法触达，
          // 故按「缺少必填信息」跳过，不写占位手机号（字段清单与 students.js 创建成员一致）。
          out.studentSkipped = '线索缺少有效手机号，未创建成员';
        } else {
          // 建档查重：线索转成交是最容易重复建档的入口 —— 销售往往不知道这孩子是否已有档案。
          // 判据与 POST /api/students 一致（家长手机号相同 = 强重复）。
          //
          // 注意「一个家长手机号绑定多个孩子」（兄弟姐妹）是真实场景，
          // 因此命中多个候选时**不能替用户决定**，必须回传候选让其指定。
          // confirmDuplicate：操作者已看到候选并坚持新建（如双胞胎共用同一家长手机号）
          const dup = confirmDuplicate ? { list: [], hasStrong: false } : findDuplicateStudents({ name, phone });
          const strong = dup.list.filter((x) => x.strength === 'strong');
          let targetId = String(linkStudentId || '').trim();
          // 只允许链接到本次命中的候选，避免传入任意 ID 产生越权关联
          if (targetId && !strong.some((x) => x.id === targetId)) targetId = '';
          // 唯一命中：直接复用已有档案，从源头消掉重复录入（而不是建完再让用户去合并）
          if (!targetId && strong.length === 1) targetId = strong[0].id;

          if (targetId) {
            db.prepare('UPDATE leads SET student_id = ?, updated_at = ? WHERE id = ?').run(targetId, t, req.params.id);
            out.studentId = targetId;
            out.studentLinked = true; // 复用已有档案（未新建）
            out.duplicate = dup.list;
          } else if (strong.length > 1) {
            out.studentSkipped = '该手机号关联了多名成员，请指定要关联的成员';
            out.duplicate = dup.list;
          } else {
          const studentId = generateId('stu_');
          // join_date 为 TEXT 列，必须绑字符串：绑数字时 better-sqlite3 按 REAL 写入，
          // 落库为 '1788059200000.0'，前端按 epoch 解析失败 → 整列显示 `-`
          db.prepare(`
            INSERT INTO students (id, name, gender, birthday, school, grade, hobby, level, height, weight, bmi, remark, status, join_date, member_no, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
          `).run(studentId, name, '', '', '', '', '', '', 0, 0, 0, '', String(t), nextMemberNo(), t, t);

          // 家长账号与绑定：与 students.js 创建成员保持一致，保证手机号登录后可见该成员
          const parentNameVal = `${name}家长`;
          const openid = `phone_${phone}`;
          const existingUser = db.prepare('SELECT id, openid FROM users WHERE phone = ?').get(phone);
          if (!existingUser) {
            db.prepare(`
              INSERT INTO users (id, openid, phone, nickname, avatar, role, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, '', 'parent', 'active', ?, ?)
            `).run(generateId('user_'), openid, phone, parentNameVal, t, t);
          } else if (!String(existingUser.openid || '').startsWith('wx_')) {
            // 保留微信身份账号的 openid（wx_ 前缀），避免再次微信登录时账号分裂
            db.prepare('UPDATE users SET openid = ? WHERE phone = ?').run(openid, phone);
          }
          const bindOpenid = existingUser ? String(existingUser.openid || '') : openid;
          const dupBind = db.prepare('SELECT 1 FROM parent_bindings WHERE student_id = ? AND parent_phone = ?').get(studentId, phone);
          if (!dupBind) {
            db.prepare(`
              INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at)
              VALUES (?, ?, ?, ?, ?, '家长', 1, ?)
            `).run(studentId, name, parentNameVal, bindOpenid, phone, t);
          }

          db.prepare('UPDATE leads SET student_id = ?, updated_at = ? WHERE id = ?').run(studentId, t, req.params.id);
            out.studentId = studentId;
            out.studentCreated = true;
          } // 无重复（或已确认要新建）→ 建立新档案
        }
      }

      // 2) 可选：创建草稿订单（字段与 orders.js 建单逻辑一致；仅建 pending，金额留 0）
      if (createOrder === true) {
        const orderStudentId = out.studentId || row.student_id || '';
        const student = orderStudentId ? db.prepare('SELECT name FROM students WHERE id = ?').get(orderStudentId) : null;
        if (!student) {
          out.orderSkipped = '线索未关联成员，未创建订单';
        } else {
          const orderId = generateId('ORD');
          const orderNo = `ORD${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
          db.prepare(`
            INSERT INTO orders (id, order_no, user_id, student_id, student_name, order_type, items, total_amount, discount_amount, payable_amount, status, salesperson, remark, is_1v1, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'pending', ?, ?, 0, ?, ?)
          `).run(orderId, orderNo, getOpenId(req), orderStudentId, student.name, 'membership', JSON.stringify([]),
            normSalesperson(row.salesperson), '线索成交自动生成，金额待收银台补全', t, t);
          out.orderId = orderId;
        }
      }

      // 3) 奖励积分：原逻辑不变。out.studentId 在旧调用路径下恒等于 row.student_id，
      //    故不传新参数时行为与旧版逐条一致。
      if (rewardPoints && parseInt(rewardPoints) > 0 && out.studentId) {
        const student = db.prepare('SELECT name FROM students WHERE id = ?').get(out.studentId);
        if (student) {
          const existAcc = db.prepare('SELECT id FROM points WHERE student_id = ?').get(out.studentId);
          if (!existAcc) {
            db.prepare('INSERT INTO points (id, student_id, student_name, total_earned, balance, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
              .run(generateId('PTS'), out.studentId, student.name, rewardPoints, rewardPoints, t);
          } else {
            db.prepare('UPDATE points SET total_earned = total_earned + ?, balance = balance + ?, updated_at = ? WHERE student_id = ?')
              .run(rewardPoints, rewardPoints, t, out.studentId);
          }
          const balance = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(out.studentId).balance;
          db.prepare('INSERT INTO point_logs (id, student_id, type, amount, balance, reason, created_at, expire_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(generateId('PLG'), out.studentId, 'earn', rewardPoints, balance, rewardReason, t, computeExpiry(t));
          out.bonus = { points: rewardPoints, balance };
        }
      }

      // 转化是 CRM 主链路的关键节点（可能连带建成员/建订单），必须留痕
      const actor = getActor(req);
      recordAudit(db, {
        entity: 'lead',
        entityId: req.params.id,
        action: 'lead_convert',
        actorId: actor.id,
        actorRole: actor.role,
        before: { stage: row.stage, status: row.status, student_id: row.student_id || '' },
        after: {
          stage: 'deal',
          status: 'converted',
          studentId: out.studentId || '',
          orderId: out.orderId || '',
          studentSkipped: out.studentSkipped || null,
          orderSkipped: out.orderSkipped || null,
          rewardPoints: out.bonus ? out.bonus.points : 0,
        },
      });

      return out;
    })();

    if (result.err) return res.json(fail(result.err));
    const payload = { id: req.params.id, converted: true, bonus: result.bonus };
    // 扩展字段仅在调用方显式使用新参数时返回：旧调用方（不传 createStudent/createOrder）
    // 收到的响应与改造前逐字节一致，便于灰度期间前端/测试做严格比对。
    if (createStudent === true || createOrder === true) {
      if (result.studentId) payload.studentId = result.studentId;
      // 复用已有档案（未新建）——前端据此提示"已关联到已有成员"
      if (result.studentLinked) payload.studentLinked = true;
      if (result.studentCreated) payload.studentCreated = true;
    }
    // 疑似重复档案候选：唯一命中时已自动复用；多个命中（如兄弟姐妹共用家长手机号）需人工指定
    if (result.duplicate && result.duplicate.length) payload.duplicate = result.duplicate;
    if (result.studentSkipped) payload.studentSkipped = result.studentSkipped;
    if (result.orderId) payload.orderId = result.orderId;
    if (result.orderSkipped) payload.orderSkipped = result.orderSkipped;
    res.json(success(payload));
  } catch (err) {
    console.error('[lead convert]', err);
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
 * GET /api/growth/churn — 流失预警（连续未到课达到 churn_rules.churnDays，或会员卡已过期未续费）
 * 风险分级：未到课超过 churnDays → medium；超过 churnDays 的 2 倍（默认 30/60）或卡已过期 → high。
 */
router.get('/churn', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const t = now();
    // 流失阈值统一取自 churn_rules（默认 churnDays=30）；原 `since` 变量是 30 天硬编码的
    // 遗留死代码（未被任何 SQL 使用），此处一并移除。
    const { churnDays } = getChurnRules(db);

    const rows = db.prepare(`
      SELECT s.id, s.name,
        (SELECT MAX(a.date) FROM attendances a WHERE a.student_id = s.id) as last_attendance,
        (SELECT MAX(c.expires_at) FROM member_cards c WHERE c.student_id = s.id AND c.status IN ('active','paused')) as last_expires_at
      FROM students s
      WHERE EXISTS (SELECT 1 FROM member_cards c WHERE c.student_id = s.id)
        AND ${ACTIVE_STUDENT_SQL}
    `).all();

    const list = rows.map((r) => {
      const lastDate = r.last_attendance ? `${r.last_attendance}` : null;
      const lastTs = lastDate ? new Date(lastDate.replace(/-/g, '/')).getTime() : 0;
      const daysSince = lastTs ? Math.floor((t - lastTs) / 86400000) : 999;
      const expired = r.last_expires_at && r.last_expires_at < t;
      // 高危线沿用原有的 2 倍关系（30:60），随 churnDays 一起可配：
      // 默认 churnDays=30 时与原硬编码 30 / 60 的判定结果逐条一致。
      const risk = daysSince > churnDays || expired ? (daysSince > churnDays * 2 || expired ? 'high' : 'medium') : 'low';
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
 * 查询某学员当前是否有未完成的跟进任务（用于预警清单显示「跟进中」，避免重复打扰）
 * @returns {{ id: string, status: string, taskType: string, reason: string } | null}
 */
function findPendingFollowUp(studentId, taskTypes) {
  if (!studentId) return null;
  const ph = taskTypes.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT id, status, task_type, reason FROM follow_ups
    WHERE target_type = 'student' AND target_id = ? AND status = 'pending'
      AND task_type IN (${ph})
    ORDER BY created_at DESC LIMIT 1
  `).get(studentId, ...taskTypes);
  return row ? { id: row.id, status: row.status, taskType: row.task_type, reason: row.reason } : null;
}

/**
 * GET /api/growth/renewal — 续费预警（到期前 warnIn 天内 + 已过期 expiredWithin 天内未续费）
 */
router.get('/renewal', (req, res) => {
  try {
    if (!canGrowth(req)) return res.status(403).json(safeFail('无增长中心权限'));
    const t = now();
    const warnIn = Math.max(1, parseInt(req.query.warnIn) || RENEWAL_WARN_DAYS);
    const expiredWithin = Math.max(1, parseInt(req.query.expiredWithin) || EXPIRED_WINDOW_DAYS);
    const warnMs = warnIn * 86400000;
    const backMs = expiredWithin * 86400000;
    const rows = db.prepare(`
      SELECT c.id, c.student_id, c.card_type_name, c.expires_at, c.status, s.name as student_name,
        (SELECT COUNT(*) FROM attendances a WHERE a.student_id = c.student_id AND a.date >= date('now', 'localtime', '-30 days')) as recent_count
      FROM member_cards c
      JOIN students s ON s.id = c.student_id
      WHERE c.status IN ('active','paused','expired')
        AND ${ACTIVE_STUDENT_SQL}
        AND c.expires_at IS NOT NULL
        AND c.expires_at <= ? + ?
        AND c.expires_at >= ? - ?
        AND NOT EXISTS (
          SELECT 1 FROM member_cards c3
          WHERE c3.student_id = c.student_id
            AND c3.status IN ('active','paused')
            AND c3.expires_at > ? + ?
        )
        AND c.expires_at = (
          SELECT MAX(c2.expires_at) FROM member_cards c2
          WHERE c2.student_id = c.student_id
            AND c2.status IN ('active','paused','expired')
            AND c2.expires_at IS NOT NULL
            AND c2.expires_at <= ? + ?
            AND c2.expires_at >= ? - ?
        )
      ORDER BY c.expires_at ASC
    `).all(t, warnMs, t, backMs, t, warnMs, t, warnMs, t, backMs);
    // 上面两条附加条件不可删：
    //  1) NOT EXISTS —— 该学员如果已经有一张到期日更远的有效卡（说明已经续过费了），就不再提醒，避免误报。
    //  2) c.expires_at = (SELECT MAX ...) —— 同一学员在窗口内有多张卡时只保留最晚到期的那张，避免同一个人重复出现两行。
    const list = rows.map((r) => ({
      cardId: r.id,
      studentId: r.student_id,
      studentName: r.student_name,
      cardType: r.card_type_name,
      expiresAt: r.expires_at,
      daysLeft: Math.ceil((r.expires_at - t) / 86400000),
      expired: r.expires_at < t,
      recentAttendance: r.recent_count,
      status: r.status,
      followUp: findPendingFollowUp(r.student_id, ['renewal', 'low_class']),
    }));
    res.json(success({ list, total: list.length, warnIn, expiredWithin }));
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
    const threshold = Math.max(1, parseInt(req.query.threshold) || LOW_CLASS_THRESHOLD);
    const rows = db.prepare(`
      SELECT mc.id, mc.student_id, mc.card_type_name, mc.billing_mode, mc.remaining_classes, mc.expires_at, mc.status,
        s.name as student_name,
        (SELECT COUNT(*) FROM attendances a WHERE a.student_id = mc.student_id AND a.date >= date('now', 'localtime', '-30 days')) as recent_count
      FROM member_cards mc
      JOIN students s ON s.id = mc.student_id
      WHERE mc.status = 'active' AND mc.billing_mode = 'count' AND mc.remaining_classes <= ? AND mc.remaining_classes > 0
        AND ${ACTIVE_STUDENT_SQL}
      ORDER BY mc.remaining_classes ASC
    `).all(threshold);
    // 同时保留 snake_case 原字段（既有调用方在用）与 camelCase 别名（与续费清单统一，前端可复用同一套渲染逻辑）
    const list = rows.map((r) => ({
      ...r,
      cardId: r.id,
      studentId: r.student_id,
      studentName: r.student_name,
      cardType: r.card_type_name,
      remainingClasses: r.remaining_classes,
      expiresAt: r.expires_at,
      recentAttendance: r.recent_count,
      followUp: findPendingFollowUp(r.student_id, ['low_class', 'renewal']),
    }));
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
    // 总数与已转化数按全量 COUNT 统计，不受下面列表 LIMIT 影响：
    // 原先用 rows.length 当分母，线索超过 200 条后 total 与 conversion 会静默算错，
    // 而接口对外声称 total 就是全部，属于"显示的数字与实际不符"。
    // 已转化判据与漏斗共用 LEAD_CONVERTED_SQL（status='converted'），不再与漏斗各用一套。
    const stat = db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN ${LEAD_CONVERTED_SQL} THEN 1 ELSE 0 END), 0) AS converted
      FROM leads WHERE source = 'referral'
    `).get();
    const total = stat.total;
    const converted = stat.converted;

    // 列表仍保留 LIMIT 200，避免一次拉取过多；同时返回 listTotal/truncated，
    // 调用方据此可知列表是否被截断（truncated 为 true 时 total 大于 list.length）。
    const rows = db.prepare(`SELECT * FROM leads WHERE source = 'referral' ORDER BY created_at DESC LIMIT 200`).all();
    res.json(success({
      total,
      converted,
      conversion: total ? Math.round((converted / total) * 1000) / 10 : 0,
      listTotal: rows.length,
      truncated: rows.length < total,
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
    // 收紧为仅管理员：积分可影响学员权益与促销，此前任意持有 growth 权限的销售
    // 都能对【任意学员】（非自己名下）发放积分（上限 9999、无审批），属资损风险。
    // 若确有销售赠送场景，应改为「申请 → 管理员审批」。
    if (!isAdminReq(req)) return res.status(403).json(safeFail('积分调整仅管理员可操作'));
    const { studentId, type, amount, reason = '' } = req.body;
    if (!studentId || !type || !amount || amount <= 0) return res.json(fail('参数不完整'));
    if (!['earn', 'consume'].includes(type)) return res.json(fail('类型无效'));
    const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
    if (!student) return res.json(fail('成员不存在'));
    const t = now();
    const beforeBalance = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId)?.balance || 0;

    // 重复提交拦截：本接口没有幂等键，请求超时重试、或用户关掉弹窗再开一次重发，
    // 都会把同一笔加减分再写一遍；而流水里两笔完全相同，事后无从分辨哪一笔是误发。
    // 故在任何写入之前，按「操作者 + 学员 + 类型 + 金额 + 原因」查最近 60 秒内是否已有同样的调整，命中即拒绝。
    // point_logs 无操作者列，操作者取自同一接口写入的 audit_log（entity='points' / action='adjust'）。
    const DUP_WINDOW_MS = 60 * 1000;
    const dupCutoff = t - DUP_WINDOW_MS;
    const dupActor = getOpenId(req);
    const duplicated = db.prepare(`
      SELECT 1 FROM point_logs pl
      WHERE pl.student_id = ? AND pl.type = ? AND pl.amount = ? AND IFNULL(pl.reason, '') = ?
        AND pl.created_at >= ?
        AND EXISTS (
          SELECT 1 FROM audit_log al
          WHERE al.entity = 'points' AND al.entity_id = pl.student_id
            AND al.action = 'adjust' AND al.actor_id = ? AND al.created_at >= ?
        )
      LIMIT 1
    `).get(studentId, type, amount, reason || '', dupCutoff, dupActor, dupCutoff);
    if (duplicated) {
      return res.json(fail('疑似重复提交：60 秒内已有一笔相同的手工积分调整，本次未执行；如确需再调整，请稍候或更改金额/原因'));
    }

    // 余额变更与流水必须同生共死：若分两步，一旦流水写入失败就会出现「余额已扣/已加但无流水」，
    // 事后既对不上账也无从追溯。返回响应的代码留在事务之外。
    let balance = 0;
    let insufficient = false;
    db.transaction(() => {
      if (type === 'consume') {
        const p = db.prepare('SELECT * FROM points WHERE student_id = ?').get(studentId);
        if (!p || p.balance < amount) { insufficient = true; return; }
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
      balance = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId)?.balance || 0;
      const expAt = type === 'earn' ? computeExpiry(t) : null;
      db.prepare('INSERT INTO point_logs (id, student_id, type, amount, balance, reason, created_at, expire_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(generateId('PLG'), studentId, type, amount, balance, reason, t, expAt);
    })();
    if (insufficient) return res.json(fail('积分余额不足'));
    // 积分可兑换属有价资产，手工调整必须可追责：记录操作者与调整前后余额
    recordAudit(db, {
      entity: 'points',
      entityId: studentId,
      action: 'adjust',
      actorId: getOpenId(req),
      actorRole: req.userRole || '',
      before: { points: beforeBalance },
      after: { points: balance, delta: type === 'consume' ? -amount : amount },
    });
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
      FROM points WHERE (frozen = 0 OR frozen IS NULL) ORDER BY balance DESC LIMIT ?
    `).all(limit).map((r, i) => ({ rank: i + 1, studentId: r.student_id, studentName: r.student_name, balance: r.balance, totalEarned: r.total_earned }));
    res.json(success({ list }));
  } catch (err) {
    res.status(500).json(safeFail('获取排行榜失败'));
  }
});

module.exports = router;
