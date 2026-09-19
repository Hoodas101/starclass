/**
 * 签到路由 — 教师签到确认、家长扫码签到、签到记录、自动标记缺席
 * POST /api/checkin/teacher    — 教师批量签到确认
 * POST /api/checkin/parent     — 家长扫码签到
 * GET  /api/checkin/records    — 签到记录查询
 * GET  /api/checkin/today      — 今日签到状态
 * POST /api/checkin/auto-absent — 自动标记缺席
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, getActor, recordAudit, now, formatDate, isCoachReq, isAdminReq, isStaffReq, canViewStudentData } = require('../utils');
const { requireStaffPerm } = require('../middleware/authz');
// 每次课消耗的课时数（courses.consume_classes）：与手工扣课路径共用同一实现
const { resolveConsumeClasses } = require('../utils/deduction');
// 订单明细（orders.items）解析：全后端唯一实现，兼容「数组元素为 JSON 字符串」的双重编码形态。
// 收入结转需要从订单明细里取行小计推导单位课时价，禁止在本文件自行 JSON.parse。
const { parseItems, itemLineTotal, itemQuantity } = require('../utils/items');
// 「推送规则 → 缺席通知」的读取与文案渲染：与续费/训练提醒共用同一实现（utils/reminders.js）
const { getNotificationRule, resolveRuleTemplate, renderNotificationTemplate } = require('../utils/reminders');
const { getTerms } = require('../utils/terms');

/**
 * 读取积分规则 —— 签到积分的唯一取值入口（替代原先散落在两处的硬编码 10 / 5）。
 *
 * settings.points_rules 的真实形态是**规则数组**（backend/routes/settings.js:100
 * 的 DEFAULT_POINTS_RULES 即其规范默认值）：
 *   [{ name: '训练签到', enabled: true, points: 10, description: '…' }, …]
 * 设置页写入的也是这一形态，因此按 `name` 关键字匹配：
 *   · 「签到」档（名称含「签到」且不含「迟到」）→ present
 *   · 「迟到」档（名称含「迟到」）            → late（真实默认集里没有该档 → 回退 5）
 * 兼容形态：若某天该键被写成对象 `{ present, late }`，同样按字段读取。
 *
 * 兜底原则：键不存在 / JSON 畸形 / 字段非数字，一律回退默认档 present=10、late=5；
 * 任何异常都不得让签到流程失败。不缓存 —— 管理员在设置页改动后下一次点名即生效。
 *
 * @returns {{present: number, late: number}} 非负整数积分
 */
function getPointsRule() {
  const DEF = { present: 10, late: 5 };
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('points_rules');
    if (!row || row.value === undefined || row.value === null || row.value === '') return DEF;
    let parsed;
    try { parsed = JSON.parse(row.value); } catch (e) { return DEF; }

    // 非负整数兜底：非法值（NaN / 负数 / 非数字）回退默认档
    const num = (v, dft) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dft;
    };

    // 对象形态（宽松兼容，真实数据中未出现）
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { present: num(parsed.present, DEF.present), late: num(parsed.late, DEF.late) };
    }
    if (!Array.isArray(parsed)) return DEF;

    const match = (kw, excludeKw) => parsed.find((r) => {
      if (!r || typeof r !== 'object') return false;
      const name = typeof r.name === 'string' ? r.name : '';
      if (!name.includes(kw)) return false;
      return !(excludeKw && name.includes(excludeKw));
    });
    // enabled === false 视为管理员停发该档积分（字段缺省视为启用）
    const pointsOf = (rule, dft) => {
      if (!rule) return dft;
      if (rule.enabled === false) return 0;
      return num(rule.points, dft);
    };

    return {
      present: pointsOf(match('签到', '迟到'), DEF.present),
      late: pointsOf(match('迟到'), DEF.late),
    };
  } catch (e) {
    console.error('[checkin points rule]', e && e.stack ? e.stack : e);
    return DEF;
  }
}

/**
 * POST /api/checkin/teacher — 教师批量签到确认
 * Body: { scheduleId, attendances: [{ studentId, status, checkinMethod }] }
 * status: present / late / absent / leave
 */
router.post('/teacher', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可确认签到'));
    if (!requireStaffPerm(req, res, 'checkin', '点名签到')) return;
    const { scheduleId, attendances } = req.body;
    if (!scheduleId || !attendances?.length) return res.json(fail('缺少排期ID或签到数据'));

    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId);
    if (!schedule) return res.json(fail('排期不存在'));
    const actor = getActor(req);

    // 教练归属校验：非管理员必须为本排期的授课教练，避免跨教练篡改考勤/课时
    if (!isAdminReq(req)) {
      const openid = getOpenId(req);
      let allowed = schedule.teacher_id === openid;
      if (!allowed) {
        const u = openid ? db.prepare('SELECT phone FROM users WHERE openid = ?').get(openid) : null;
        const coach = u && u.phone ? db.prepare("SELECT id FROM teachers WHERE phone = ?").get(u.phone) : null;
        allowed = !!(coach && coach.id === schedule.teacher_id);
      }
      if (!allowed) return res.status(403).json(safeFail('无权操作非本人授课的排期'));
    }

    const results = [];
    const dateStr = schedule.date;

    // 单学员点名处理（由下方批次事务逐个调用；事务边界提升到整批一层）
    const processOne = (att) => {
      const { studentId, status, checkinMethod = 'manual' } = att;
      const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
      if (!student) return;
      const beforeAtt = db.prepare('SELECT status, points_earned FROM attendances WHERE schedule_id = ? AND student_id = ?').get(scheduleId, studentId);

      // 清除记录：删除签到并回滚积分与扣课（供教练纠正误签到/误点名）
      if (status === 'clear') {
        const existing = db.prepare(
          'SELECT * FROM attendances WHERE schedule_id = ? AND student_id = ?'
        ).get(scheduleId, studentId);
        if (!existing) {
          results.push({ studentId, status: 'cleared', pointsEarned: 0 });
          return;
        }
        const t = now();
        // 回滚签到积分（含累计，记录负流水）
        if ((existing.points_earned || 0) > 0) {
          const acc = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId);
          if (acc) {
            const back = existing.points_earned;
            // 记账必须按「实际生效量」而非「请求扣除量」：
            // 余额只有 3 而 back 是 10 时，余额只能扣到 0（实扣 3），流水就必须记 -3。
            // 旧实现把请求量 back 写进流水、余额却截到 0，实扣 3 却记 -10，
            // 从此 SUM(point_logs.amount) 与 points.balance 永久对不上且无自愈
            // ——积分可兑换、属有价资产，兑换时即账实不符。
            // 业务语义不变：余额不足时仍是「扣到 0 为止、不报失败」。
            const actual = Math.min(back, acc.balance || 0);
            const newBal = (acc.balance || 0) - actual; // actual ≤ balance，结果自然 ≥ 0
            // total_earned 是累计获得口径，同样按实际生效量扣；MAX(0, …) 仅防御历史脏数据
            // （正常情况下 total_earned ≥ balance ≥ actual，不会触发截断）。
            db.prepare(`
              UPDATE points SET total_earned = MAX(0, total_earned - ?), balance = ?, updated_at = ?
              WHERE student_id = ?
            `).run(actual, newBal, t, studentId);
            db.prepare(`
              INSERT INTO point_logs (id, student_id, type, amount, balance, reference_id, reason, description, created_at)
              VALUES (?, ?, 'checkin', ?, ?, ?, '清除签到记录，回滚积分', '清除签到记录回滚积分', ?)
            `).run(generateId('plog_'), studentId, -actual, newBal, scheduleId, t);
          }
        }
        // 回滚次数卡扣课（若已扣）
        const ded = db.prepare(
          'SELECT * FROM deduction_logs WHERE schedule_id = ? AND student_id = ?'
        ).get(scheduleId, studentId);
        if (ded) {
          // 回滚课时：以扣课时记下的真实扣减量为准（迁移 019 的 deduction_logs.count）。
          // 旧实现在此按 resolveConsumeClasses(scheduleId) 于回滚那一刻重新推导，
          // 与当初真实扣减量不符时（手动按 classes=N 扣课、或扣课后课程配置被改），
          // 每次「签到 → 改缺席/清除」都会让卡内课时凭空增减。
          // 迁移前的历史行 count 为 NULL，回退到旧的推导方式，行为与改动前一致。
          const back = ded.count != null ? ded.count : resolveConsumeClasses(scheduleId);
          db.prepare(`
            UPDATE member_cards SET remaining_classes = remaining_classes + ?,
              used_classes = MAX(0, used_classes - ?), updated_at = ?
            WHERE id = ?
          `).run(back, back, t, ded.card_id);
          db.prepare('DELETE FROM deduction_logs WHERE id = ?').run(ded.id);
        }
        // 课时已退回卡内 → 对应已结转的收入必须同步冲销，否则「清除签到」后
        // 合同负债会被系统性低估（钱退回了卡里，收入却还挂在账上）。
        revertRevenueRecognition(scheduleId, studentId);
        db.prepare('DELETE FROM attendances WHERE schedule_id = ? AND student_id = ?')
          .run(scheduleId, studentId);
        recordAudit(db, {
          entity: 'attendance',
          entityId: `${scheduleId}:${studentId}`,
          action: 'checkin_clear',
          actorId: actor.id,
          actorRole: actor.role,
          before: beforeAtt,
          after: null,
        });
        results.push({ studentId, status: 'cleared', pointsEarned: 0 });
        return;
      }

      // 积分取值改为读设置项 points_rules（原先硬编码 10 / 5，管理员在设置页改了不生效）
      const pointsRule = getPointsRule();
      const pointsEarned = status === 'present' ? pointsRule.present : (status === 'late' ? pointsRule.late : 0);

      // 单学员「upsert + 积分 + 扣课」逻辑：状态变更时的积分/课时补偿原子化，避免数据虚高或漏发。
      // 事务边界在整批一层（见下方 runBatch），此处不再单独开事务。
      {
        const existing = db.prepare(
          'SELECT * FROM attendances WHERE schedule_id = ? AND student_id = ?'
        ).get(scheduleId, studentId);

        if (existing) {
          // 已存在记录：按状态机做积分/课时补偿，再更新考勤行
          const oldStatus = existing.status;
          const oldPointsEarned = existing.points_earned || 0;
          const oldIsEarn = (oldStatus === 'present' || oldStatus === 'late');
          const newIsEarn = (status === 'present' || status === 'late');

          if (oldIsEarn && !newIsEarn) {
            // 旧=签到 → 新=非签到：反向扣回旧积分、退还课时、删除扣课记录
            if (oldPointsEarned > 0) {
              reversePoints(studentId, oldPointsEarned, scheduleId, '签到状态变更回滚积分');
            }
            const ded = db.prepare(
              'SELECT * FROM deduction_logs WHERE schedule_id = ? AND student_id = ?'
            ).get(scheduleId, studentId);
            if (ded) {
              // 同上：以扣课时记录的真实扣减量为准，历史行（count 为 NULL）回退到推导
              const back = ded.count != null ? ded.count : resolveConsumeClasses(scheduleId);
              db.prepare(`
                UPDATE member_cards SET remaining_classes = remaining_classes + ?,
                  used_classes = MAX(0, used_classes - ?), updated_at = ?
                WHERE id = ?
              `).run(back, back, now(), ded.card_id);
              db.prepare('DELETE FROM deduction_logs WHERE id = ?').run(ded.id);
            }
            // 同上：课时退回 → 同步冲销已结转收入，保持结转台账与课时台账一致
            revertRevenueRecognition(scheduleId, studentId);
          } else if (!oldIsEarn && newIsEarn) {
            // 旧=非签到 → 新=签到：发放新积分，并镜像首次签到的扣课逻辑（幂等不变）
            if (pointsEarned > 0) {
              addPoints(studentId, student.name, pointsEarned, 'checkin', scheduleId, `${status === 'late' ? '迟到' : '签到'}获得积分`);
            }
            if (status === 'present' || status === 'late') {
              try {
                applyArrivalDeduction(studentId, scheduleId, now());
              } catch (e) {
                // 仅忽略幂等冲突（同一排期+学员重复扣课）；no such column / SQLITE_BUSY 等真实故障必须暴露
                if (!isUniqueViolation(e)) {
                  console.error('[checkin deduction]', e && e.stack ? e.stack : e);
                  throw e;
                }
              }
            }
          } else if (oldIsEarn && newIsEarn) {
            // 旧新均为签到（如 late→present）：仅调整积分差，扣课已按"每排期每学员一次"记录，保持不变
            const diff = pointsEarned - oldPointsEarned;
            if (diff > 0) {
              addPoints(studentId, student.name, diff, 'checkin', scheduleId + '_adjust', `${status === 'late' ? '迟到' : '签到'}补发积分`);
            } else if (diff < 0) {
              reversePoints(studentId, -diff, scheduleId + '_adjust', '签到状态变更回滚积分');
            }
          }

          // 更新考勤行（保持 points_earned 与最终状态一致）
          db.prepare(`
            UPDATE attendances SET status = ?, checkin_method = ?, checkin_time = ?, points_earned = ?, updated_at = ?
            WHERE schedule_id = ? AND student_id = ?
          `).run(status, checkinMethod, now(), pointsEarned, now(), scheduleId, studentId);
        } else {
          const id = generateId('att_');
          db.prepare(`
            INSERT INTO attendances (id, schedule_id, student_id, student_name, course_id, course_name,
              status, checkin_method, checkin_time, checkin_by, points_earned, date, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'teacher', ?, ?, ?, ?)
          `).run(id, scheduleId, studentId, student.name, schedule.course_id, schedule.course_name,
            status, checkinMethod, now(), pointsEarned, dateStr, now(), now());
          // 仅首次签到发放积分，重复提交不重复计分
          if (pointsEarned > 0) {
            addPoints(studentId, student.name, pointsEarned, 'checkin', scheduleId, `${status === 'late' ? '迟到' : '签到'}获得积分`);
          }
          // 次数卡学员首次签到自动扣课（幂等：同一排期+学员只扣一次；时效卡仅记录不扣次）
          // 补课/调课登记的学员不扣课时（原排期已扣或请假已扣）
          if (status === 'present' || status === 'late') {
            try {
              applyArrivalDeduction(studentId, scheduleId, now());
            } catch (e) {
              // 仅忽略幂等冲突（同一排期+学员重复扣课）；no such column / SQLITE_BUSY 等真实故障必须暴露
              if (!isUniqueViolation(e)) {
                console.error('[checkin deduction]', e && e.stack ? e.stack : e);
                throw e;
              }
            }
          }
        }

        results.push({ studentId, status, pointsEarned });
      }

      recordAudit(db, {
        entity: 'attendance',
        entityId: `${scheduleId}:${studentId}`,
        action: `checkin_${status}`,
        actorId: actor.id,
        actorRole: actor.role,
        before: beforeAtt,
        after: { status, points_earned: pointsEarned },
      });
    };

    // T1/T2/T4：整个批量点名（含 clear 清退分支的全部写入）收敛到**单个** immediate 事务 ——
    // 一次提交；任一学员中途失败则整批回滚，不会留下「部分学员已改、部分未改」的半完成账目。
    const runBatch = db.transaction(() => {
      for (const att of attendances) processOne(att);
    });
    runBatch.immediate();

    res.json(success({ count: results.length, results }));
  } catch (err) {
    console.error('[checkin teacher]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * Deduct courses.consume_classes (default 1) from a count card on first arrival.
 * Shared with the teacher roll-call path; idempotent per (schedule, student);
 * must be called inside a transaction.
 * Also skips when a leave deduction has already been posted for the same
 * (schedule, student) — see T7: the two ledgers (deduction_logs /
 * leave_deduction_logs) must not deduct the same class twice.
 *
 * 课时数此前硬编码 1，配置为「每次消耗 2 课时」的课程永远只扣 1，卡内余额被高估。
 * 现统一取排期所属课程的 courses.consume_classes（缺省 1，见 utils/deduction）。
 * 卡内余量不足 N 时**不扣课**（而非部分扣减）：部分扣减会让「签到→改缺席」的回滚
 * 无法复原到同一个数值（deduction_logs 无 count 列可记录实际扣减量），
 * 宁可少扣一次也不能让课时余额被回滚路径虚增。
 */
function applyArrivalDeduction(studentId, scheduleId, t) {
  const dedup = db.prepare('SELECT 1 FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').get(scheduleId, studentId);
  if (dedup) return;
  // T7：同一排期+学员若已按请假规则扣过课，则签到侧不得再次扣课。
  // 「先请假获批扣课 → 后改为签到」曾会扣两次课时；两套账本交叉校验后只扣一次。
  // leave_deduction_logs 的记录保留不动（请假路径的幂等依赖该行），此处仅跳过签到侧扣课。
  const leaveDed = db.prepare('SELECT 1 FROM leave_deduction_logs WHERE schedule_id = ? AND student_id = ?').get(scheduleId, studentId);
  if (leaveDed) return;
  const makeupEnroll = db.prepare(
    "SELECT 1 FROM enrollments WHERE schedule_id = ? AND student_id = ? AND enroll_type IN ('makeup', 'reschedule') AND status = 'active'"
  ).get(scheduleId, studentId);
  if (makeupEnroll) {
    db.prepare(`
      UPDATE makeup_records SET status = 'completed', updated_at = ?
      WHERE makeup_schedule_id = ? AND student_id = ? AND status = 'pending'
    `).run(t, scheduleId, studentId);
    return;
  }
  // 每次课消耗的课时数：courses.consume_classes，缺省 1（course_temp 的 0 也归一到 1）
  const per = resolveConsumeClasses(scheduleId);
  const card = db.prepare(`
    SELECT * FROM member_cards
    WHERE student_id = ? AND status = 'active' AND billing_mode = 'count'
      AND expires_at > ? AND remaining_classes >= ?
    ORDER BY expires_at ASC LIMIT 1
  `).get(studentId, t, per);
  if (!card) return;
  db.prepare(`
    UPDATE member_cards SET remaining_classes = remaining_classes - ?, used_classes = used_classes + ?, updated_at = ?
    WHERE id = ?
  `).run(per, per, t, card.id);
  // 一次扣课一行流水：deduction_logs 上有 UNIQUE(schedule_id, student_id)，
  // 消耗 N 课时不写成 N 行，而是记在 count 列（迁移 019）。回滚路径读该列还原 N，
  // 不再依赖「回滚时重新推导」，也就不会因中途改过课程配置而多还或少还。
  db.prepare(`
    INSERT INTO deduction_logs (schedule_id, student_id, card_id, deducted_at, count)
    VALUES (?, ?, ?, ?, ?)
  `).run(scheduleId, studentId, card.id, t, per);

  // 扣课成功 → 在同一事务内追加一条收入结转（合同负债 → 收入）。
  // 位置紧贴 deduction_logs 写入之后：上面任一 early return（无卡 / 补课调课 / 已扣过）
  // 都代表「本次没有真实消课」，此时不得结转，否则会凭空虚增已确认收入。
  recordRevenueRecognition({ card, scheduleId, classes: per, t });
}

/**
 * POST /api/checkin/parent — parent QR check-in
 * Body: { scheduleId, studentId }
 *
 * Enforces: binding ownership, enrollment in this schedule, a time window
 * (2h before start to 2h after end), and normal count-card deduction — same
 * as the teacher roll-call path. No QR nonce needed: identity comes from the
 * parent's JWT and the checks above already bind each check-in to a
 * legitimate student.
 */
router.post('/parent', (req, res) => {
  try {
    const { scheduleId, studentId } = req.body;
    const openid = getOpenId(req);
    if (!scheduleId || !studentId) return res.json(fail('缺少参数'));
    const actor = getActor(req);

    // 验证家长绑定关系
    const binding = db.prepare(
      'SELECT * FROM parent_bindings WHERE student_id = ? AND parent_openid = ?'
    ).get(studentId, openid);
    if (!binding) return res.json(fail('无权为该成员签到'));

    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId);
    if (!schedule) return res.json(fail('排期不存在'));

    const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
    if (!student) return res.json(fail('成员不存在'));

    // 报名校验：家长只能为已报名该排期的成员签到（补课/调课登记同样视为已报名）
    const enrolled = db.prepare(
      "SELECT 1 FROM enrollments WHERE schedule_id = ? AND student_id = ? AND status = 'active' LIMIT 1"
    ).get(scheduleId, studentId);
    if (!enrolled) return res.json(fail('该成员未报名本次活动，无法签到，请联系机构'));

    // 时间窗口校验：仅允许在活动开始前 2 小时至结束后 2 小时之间签到，且活动未结束
    // 防止家长在非活动时段"补签到"刷积分
    const nowMs = Date.now();
    const startMs = new Date(`${schedule.date}T${schedule.start_time || '00:00'}`).getTime();
    const endMs = new Date(`${schedule.date}T${schedule.end_time || '23:59'}`).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      if (nowMs < startMs - 2 * 3600000) {
        return res.json(fail('活动尚未开始，暂不能签到'));
      }
      if (nowMs > endMs + 2 * 3600000) {
        return res.json(fail('活动已结束超过 2 小时，无法补签到'));
      }
    }

    // 家长扫码签到 = 「签到」档（present）；原先硬编码 10，管理员在设置页改了不生效
    const pointsEarned = getPointsRule().present;
    const t = now();
    // Attendance + points + class deduction in one immediate transaction:
    // the existence check above and the INSERT below are a check-then-act pair,
    // so take the write lock up front (T4) instead of upgrading mid-transaction.
    const outcome = db.transaction(() => {
      const existing = db.prepare(
        'SELECT * FROM attendances WHERE schedule_id = ? AND student_id = ?'
      ).get(scheduleId, studentId);
      if (existing) return { err: '已签到，无需重复签到' };

      const id = generateId('att_');
      db.prepare(`
        INSERT INTO attendances (id, schedule_id, student_id, student_name, course_id, course_name,
          status, checkin_method, checkin_time, checkin_by, points_earned, date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'present', 'qrcode', ?, 'parent', ?, ?, ?, ?)
      `).run(id, scheduleId, studentId, student.name, schedule.course_id, schedule.course_name,
        t, pointsEarned, schedule.date, t, t);

      addPoints(studentId, student.name, pointsEarned, 'checkin', scheduleId, '家长扫码签到获得积分');
      // 次数卡扣课（与教练点名同一规则，幂等）
      try {
        applyArrivalDeduction(studentId, scheduleId, t);
      } catch (e) {
        // 仅忽略幂等冲突；真实故障（no such column / SQLITE_BUSY）必须暴露并回滚本次签到
        if (!isUniqueViolation(e)) {
          console.error('[checkin deduction]', e && e.stack ? e.stack : e);
          throw e;
        }
      }

      return { attendanceId: id };
    }).immediate();
    if (outcome.err) return res.json(fail(outcome.err));

    recordAudit(db, {
      entity: 'attendance',
      entityId: `${scheduleId}:${studentId}`,
      action: 'checkin_present',
      actorId: actor.id,
      actorRole: actor.role,
      before: null,
      after: { status: 'present', points_earned: pointsEarned },
    });

    res.json(success({ attendanceId: outcome.attendanceId, pointsEarned }));
  } catch (err) {
    console.error('[checkin parent]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/checkin/records — 签到记录查询
 * Query: { studentId, scheduleId, date, status, page, pageSize }
 */
router.get('/records', (req, res) => {
  try {
    const { studentId, scheduleId, date, month, status } = req.query;
    // Without studentId this is an org-wide query — staff only;
    // parents must pass studentId and go through the ownership check below.
    if (!studentId && !isStaffReq(req)) {
      return res.status(403).json(safeFail('无权查看全部签到记录'));
    }
    // 员工查询需持有签到权限；家长（带 studentId）由下方归属校验控制，不受员工权限清单约束
    if (!requireStaffPerm(req, res, 'checkin', '签到记录')) return;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    let where = 'WHERE 1=1';
    const params = [];

    if (studentId) {
      // 防越权：家长仅可查看自己绑定的成员；管理端工作人员可查看
      if (!canViewStudentData(req, studentId)) {
        return res.status(403).json(safeFail('无权查看该成员的签到记录'));
      }
      where += ' AND a.student_id = ?'; params.push(studentId);
    }
    if (scheduleId) { where += ' AND a.schedule_id = ?'; params.push(scheduleId); }
    if (date) { where += ' AND a.date = ?'; params.push(date); }
    if (month) { where += ' AND a.date LIKE ?'; params.push(`${month}%`); }
    if (status) { where += ' AND a.status = ?'; params.push(status); }

    const total = db.prepare(`SELECT COUNT(*) as count FROM attendances a ${where}`).get(...params).count;
    const list = db.prepare(`
      SELECT a.*, s.start_time, s.end_time
      FROM attendances a
      LEFT JOIN schedules s ON s.id = a.schedule_id
      ${where}
      ORDER BY a.checkin_time DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    console.error('[checkin records]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/checkin/today — 今日签到状态
 */
router.get('/today', (req, res) => {
  try {
    const today = formatDate(now());
    const { studentId } = req.query;
    // 不带 studentId 时为全机构今日状态，仅限管理端工作人员（同 /records 防横向越权）
    if (!studentId && !isStaffReq(req)) {
      return res.status(403).json(safeFail('无权查看全部签到状态'));
    }
    // 员工查询需持有签到权限；家长（带 studentId）不受员工权限清单约束
    if (!requireStaffPerm(req, res, 'checkin', '签到状态')) return;

    let where = 'WHERE a.date = ?';
    const params = [today];

    // 如果传入 studentId 则按成员过滤（家长端只能看自己孩子）
    if (studentId) {
      // 防越权：家长仅可查看自己绑定的成员；管理端工作人员可查看
      if (!canViewStudentData(req, studentId)) {
        return res.status(403).json(safeFail('无权查看该成员的签到状态'));
      }
      where += ' AND a.student_id = ?';
      params.push(studentId);
    }

    const records = db.prepare(`
      SELECT a.*, s.start_time, s.end_time, s.course_name
      FROM attendances a
      JOIN schedules s ON s.id = a.schedule_id
      ${where}
      ORDER BY s.start_time ASC
    `).all(...params);

    const stats = {
      total: records.length,
      present: records.filter(r => r.status === 'present').length,
      late: records.filter(r => r.status === 'late').length,
      absent: records.filter(r => r.status === 'absent').length,
      leave: records.filter(r => r.status === 'leave').length,
    };

    res.json(success({ date: today, stats, records }));
  } catch (err) {
    console.error('[checkin today]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * POST /api/checkin/auto-absent — 自动标记缺席
 * 将今日已结束活动中未签到的登记成员标记为缺席
 * Body: { date }（可选，默认今日）
 */
/**
 * 自动标记缺席（供路由与每日定时任务复用）
 * 将已结束活动且未签到的登记成员标记为缺席
 */
function runAutoAbsent(dateStr) {
  const targetDate = dateStr || formatDate(now());
  const currentTime = formatDate(now()) === targetDate ? _currentTimeStr() : '23:59';

  // 「推送规则 → 缺席通知」：设置页上的开关与文案必须真的生效。
  // 规则缺失 / JSON 畸形时回退默认（启用 + 默认文案），不因读不到配置就漏发通知。
  const absentRule = getNotificationRule('缺席通知');
  const absentNotifyEnabled = !(absentRule && absentRule.enabled === false);
  const absentTemplate = resolveRuleTemplate(absentRule, '缺席通知');
  const { terms } = getTerms(db);

  const schedules = db.prepare(`
    SELECT * FROM schedules
    WHERE date = ? AND end_time < ? AND status = 'scheduled'
  `).all(targetDate, currentTime);

  let markedCount = 0;

  // 单个排期的缺席标记（由下方批次事务逐个调用）
  const markSchedule = (schedule) => {
    const missingStudents = db.prepare(`
      SELECT e.student_id, e.student_name
      FROM enrollments e
      LEFT JOIN attendances a ON a.schedule_id = e.schedule_id AND a.student_id = e.student_id
      WHERE e.schedule_id = ? AND e.status = 'active' AND a.id IS NULL
    `).all(schedule.id);

    for (const stu of missingStudents) {
      const id = generateId('att_');
      db.prepare(`
        INSERT INTO attendances (id, schedule_id, student_id, student_name, course_id, course_name,
          status, checkin_method, date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'absent', 'auto', ?, ?, ?)
      `).run(id, schedule.id, stu.student_id, stu.student_name, schedule.course_id, schedule.course_name, targetDate, now(), now());
      markedCount++;

      recordAudit(db, {
        entity: 'attendance',
        entityId: `${schedule.id}:${stu.student_id}`,
        action: 'checkin_absent_auto',
        actorId: 'system',
        actorRole: 'system',
        before: null,
        after: { status: 'absent' },
      });

      // 自动缺席后通知家长（站内信），避免家长不知情；
      // 「缺席通知」规则被禁用时只记录缺席、不发通知（考勤记录不受开关影响）
      if (absentNotifyEnabled) {
        try {
          const parent = db.prepare(`
            SELECT parent_openid FROM parent_bindings
            WHERE student_id = ? AND is_main = 1 LIMIT 1
          `).get(stu.student_id);
          if (parent && parent.parent_openid) {
            const noticeId = generateId('NTF');
            const title = '出勤提醒：未参加今日训练';
            // 文案来自「缺席通知」规则的 template（设置页可改），
            // 可用占位符：{{studentName}}/{{courseName}}/{{date}}/{{time}} + 机构称呼占位符
            const content = renderNotificationTemplate(absentTemplate, {
              studentName: stu.student_name || '',
              courseName: schedule.course_name || '',
              date: targetDate,
              time: `${schedule.start_time}-${schedule.end_time}`,
            }, terms);
            db.prepare(`
              INSERT INTO notifications (id, user_id, title, content, priority, category, summary, channel, status, sent_at, created_at)
              VALUES (?, ?, ?, ?, 'important', 'attendance', ?, 'inapp', 'sent', ?, ?)
            `).run(noticeId, parent.parent_openid, title, content, content.slice(0, 60), now(), now());
          }
        } catch (e) {
          console.error('[checkin auto-absent notify]', e && e.stack ? e.stack : e);
        }
      }
    }
  };

  // E6/T4：整批自动缺席（考勤 INSERT + 审计 + 家长通知）收敛到单个 immediate 事务，
  // 一次提交；中途失败整批回滚，不再逐条独立提交留下半完成状态。
  const runAbsentBatch = db.transaction(() => {
    for (const schedule of schedules) markSchedule(schedule);
  });
  runAbsentBatch.immediate();

  return { date: targetDate, markedCount };
}

router.post('/auto-absent', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可执行自动缺席'));
    if (!requireStaffPerm(req, res, 'checkin', '自动缺席')) return;
    const result = runAutoAbsent(req.body?.date);
    res.json(success(result));
  } catch (err) {
    console.error('[checkin auto-absent]', err && err.stack ? err.stack : err);
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

// ============ 内部辅助函数 ============

/**
 * 增加积分（内部使用）
 */
function addPoints(studentId, studentName, amount, type, referenceId, description) {
  let account = db.prepare('SELECT * FROM points WHERE student_id = ?').get(studentId);
  if (!account) {
    const id = generateId('pt_');
    db.prepare(`
      INSERT INTO points (id, student_id, student_name, total_earned, total_consumed, balance, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(id, studentId, studentName, amount, amount, now());
    account = db.prepare('SELECT * FROM points WHERE student_id = ?').get(studentId);
  } else {
    db.prepare(`
      UPDATE points SET total_earned = total_earned + ?, balance = balance + ?, updated_at = ? WHERE student_id = ?
    `).run(amount, amount, now(), studentId);
    account = db.prepare('SELECT * FROM points WHERE student_id = ?').get(studentId);
  }

  // 记录流水
  const logId = generateId('plog_');
  db.prepare(`
    INSERT INTO point_logs (id, student_id, type, amount, balance, reference_id, reason, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(logId, studentId, type, amount, account.balance, referenceId, description, description, now());
}

/**
 * 反向扣回积分（内部使用）：用于签到状态由「已签到/迟到」改为「非签到」时回滚已发放积分。
 * 仅做减法：扣减 balance 与 total_earned，并写一条负 amount 的 point_logs。
 * reference_id 复用原签到值（scheduleId），便于去重与审计追溯。
 */
function reversePoints(studentId, amount, referenceId, description) {
  if (!(amount > 0)) return;
  const acc = db.prepare('SELECT * FROM points WHERE student_id = ?').get(studentId);
  if (!acc) return; // 账户不存在则无需回滚
  // 与「清除签到回滚」同一口径：流水只记实际生效的扣减量。
  // 余额只有 3 却要回滚 10 时，实扣 3 就必须记 -3；记 -10 会让
  // SUM(point_logs.amount) 与 points.balance 永久相差 7 且无自愈。
  // 业务语义不变：余额不足时仍是「扣到 0 为止、不报失败」。
  const actual = Math.min(amount, acc.balance || 0);
  const newBal = (acc.balance || 0) - actual; // actual ≤ balance，结果自然 ≥ 0
  // total_earned 同按实际生效量扣；MAX(0, …) 仅防御历史脏数据
  // （正常情况下 total_earned ≥ balance ≥ actual，不会触发截断）。
  db.prepare(`
    UPDATE points SET total_earned = MAX(0, total_earned - ?), balance = ?, updated_at = ?
    WHERE student_id = ?
  `).run(actual, newBal, now(), studentId);
  db.prepare(`
    INSERT INTO point_logs (id, student_id, type, amount, balance, reference_id, reason, description, created_at)
    VALUES (?, ?, 'checkin', ?, ?, ?, ?, ?, ?)
  `).run(generateId('plog_'), studentId, -actual, newBal, referenceId, description, description, now());
}

/**
 * 获取当前时间字符串 HH:mm
 */
function _currentTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 是否为唯一约束冲突（幂等重复写入）。
 * 只有这类错误可以安全忽略：并发/重复提交导致的 UNIQUE 冲突本就是「已扣过课」的语义。
 * 其余错误（no such column、SQLITE_BUSY、磁盘/IO 故障）必须向上抛出，避免账目静默漂移。
 */
function isUniqueViolation(e) {
  const code = (e && e.code) ? String(e.code) : '';
  const msg = (e && e.message) ? String(e.message) : '';
  return code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || /UNIQUE constraint failed/i.test(msg);
}

// ============ 收入结转（合同负债）辅助函数 ============

/**
 * revenue_recognitions 表是否存在（迁移 017 未执行时为 false）。
 * 新增的是旁路台账：老库尚未迁移时只跳过结转，绝不让既有签到流程报错。
 * 不做结果缓存 —— 建表后无需重启即生效，且这是一次极廉价的 sqlite_master 点查
 * （只在「扣课成功」这一低频分支上发生）。
 */
function hasRevenueRecognitionTable() {
  try {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revenue_recognitions'"
    ).get();
  } catch (e) {
    return false;
  }
}

/**
 * 从卡的**关联订单**推导单位课时价（元/课时）。
 * 关联关系取 member_cards.order_id —— 由 orders.js / membership.js 建卡时写入，
 * 是唯一能确定「这张卡到底是按哪笔钱买的」的凭据。
 * 刻意**不**跨订单模糊匹配（例如按 student_id + card_type_id 去别的订单里找）：
 * 同一学员可能以不同价格买过同类卡，那样推导出的单价是猜的。
 *
 * @returns {{unit:number, lineTotal:number, totalClasses:number, orderId:string}|null}
 *          null 表示无法可靠推导 —— 调用方必须写 amount=0 / basis='unresolved'
 */
function deriveUnitPrice(card) {
  if (!card || !card.order_id) return null;
  const order = db.prepare('SELECT id, items, total_amount, payable_amount FROM orders WHERE id = ?').get(card.order_id);
  if (!order) return null;
  // 整单折扣比例（实付 / 标价）。与退卡（membership.js）同一口径：
  // 结转基数是**实际收到的钱**，不是标价。若按标价结转，折扣单的累计结转额
  // 会超过订单实付，合同负债（已收未结转）因此出现负数。
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
  // 总课时数优先取卡上登记值（售出时的真实课时数），取不到才回退订单项数量
  const totalClasses = Number(card.total_classes) > 0 ? Number(card.total_classes) : itemQuantity(item);
  if (!(lineTotal > 0) || !(totalClasses > 0)) return null;
  return { unit: lineTotal / totalClasses, lineTotal, totalClasses, orderId: order.id };
}

/**
 * 写一条收入结转记录。**必须由调用方置于「扣课成功」的同一事务内**，
 * 使课时台账（member_cards / deduction_logs）与结转台账原子一致。
 * 本函数不自开事务 —— 内层再开事务会与外层 immediate 事务嵌套报错。
 *
 * 金额口径：amount = round(单位课时价 × 本次结转课时数)，单位为**整数元**。
 * 无法可靠推导单价时写 amount = 0 且 basis = 'unresolved'（只留痕、不计金额），
 * **绝不猜测金额**。
 *
 * 错误处理遵循本文件既有约定（见 applyArrivalDeduction / isUniqueViolation 注释）：
 * 只对「表不存在」做优雅降级，其余真实故障一律向上抛出、让整批回滚，
 * 避免出现「课时扣了、结转却没记」的静默账目漂移。
 */
function recordRevenueRecognition({ card, scheduleId, classes, t }) {
  if (!hasRevenueRecognitionTable()) return;
  const schedule = db.prepare('SELECT course_id, course_name FROM schedules WHERE id = ?').get(scheduleId);
  // 考勤行在上方已写入（家长/教师两条路径均是先 INSERT 考勤再扣课），此处回查以填充 attendance_id
  const att = db.prepare('SELECT id FROM attendances WHERE schedule_id = ? AND student_id = ?')
    .get(scheduleId, card.student_id);

  const derived = deriveUnitPrice(card);
  let amount = 0;
  let basis = 'unresolved';
  if (derived) {
    amount = Math.round(derived.unit * classes);
    basis = `unit=${derived.unit}元/课时(行小计${derived.lineTotal}/总课时${derived.totalClasses}); order=${derived.orderId}; classes=${classes}`;
  }

  db.prepare(`
    INSERT INTO revenue_recognitions (id, order_id, student_id, schedule_id, attendance_id,
      course_id, course_name, classes, amount, recognized_at, basis, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateId('rr_'),
    derived ? derived.orderId : (card.order_id || null),
    card.student_id,
    scheduleId,
    (att && att.id) || null,
    (schedule && schedule.course_id) || null,
    (schedule && schedule.course_name) || null,
    classes,
    amount,
    t,
    basis,
    t
  );
}

/**
 * 冲销某排期+学员的结转记录（课时回滚时调用：清除签到、签到改为缺席/请假）。
 * DELETE 天然幂等，重复调用安全。表不存在时静默跳过。
 */
function revertRevenueRecognition(scheduleId, studentId) {
  if (!hasRevenueRecognitionTable()) return;
  db.prepare('DELETE FROM revenue_recognitions WHERE schedule_id = ? AND student_id = ?')
    .run(scheduleId, studentId);
}

module.exports = router;
module.exports.runAutoAbsent = runAutoAbsent;
