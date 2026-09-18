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

    for (const att of attendances) {
      const { studentId, status, checkinMethod = 'manual' } = att;
      const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
      if (!student) continue;
      const beforeAtt = db.prepare('SELECT status, points_earned FROM attendances WHERE schedule_id = ? AND student_id = ?').get(scheduleId, studentId);

      // 清除记录：删除签到并回滚积分与扣课（供教练纠正误签到/误点名）
      if (status === 'clear') {
        const existing = db.prepare(
          'SELECT * FROM attendances WHERE schedule_id = ? AND student_id = ?'
        ).get(scheduleId, studentId);
        if (!existing) {
          results.push({ studentId, status: 'cleared', pointsEarned: 0 });
          continue;
        }
        const t = now();
        // 回滚签到积分（含累计，记录负流水）
        if ((existing.points_earned || 0) > 0) {
          const acc = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(studentId);
          if (acc) {
            const back = existing.points_earned;
            const newBal = Math.max(0, (acc.balance || 0) - back);
            db.prepare(`
              UPDATE points SET total_earned = MAX(0, total_earned - ?), balance = ?, updated_at = ?
              WHERE student_id = ?
            `).run(back, newBal, t, studentId);
            db.prepare(`
              INSERT INTO point_logs (id, student_id, type, amount, balance, reference_id, reason, description, created_at)
              VALUES (?, ?, 'checkin', ?, ?, ?, '清除签到记录，回滚积分', '清除签到记录回滚积分', ?)
            `).run(generateId('plog_'), studentId, -back, newBal, scheduleId, t);
          }
        }
        // 回滚次数卡扣课（若已扣）
        const ded = db.prepare(
          'SELECT * FROM deduction_logs WHERE schedule_id = ? AND student_id = ?'
        ).get(scheduleId, studentId);
        if (ded) {
          db.prepare(`
            UPDATE member_cards SET remaining_classes = remaining_classes + 1,
              used_classes = MAX(0, used_classes - 1), updated_at = ?
            WHERE id = ?
          `).run(t, ded.card_id);
          db.prepare('DELETE FROM deduction_logs WHERE id = ?').run(ded.id);
        }
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
        continue;
      }

      const pointsEarned = status === 'present' ? 10 : (status === 'late' ? 5 : 0);

      // 单学员「upsert + 积分 + 扣课」包在同一事务：状态变更时的积分/课时补偿原子化，避免数据虚高或漏发
      db.transaction(() => {
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
              db.prepare(`
                UPDATE member_cards SET remaining_classes = remaining_classes + 1,
                  used_classes = MAX(0, used_classes - 1), updated_at = ?
                WHERE id = ?
              `).run(now(), ded.card_id);
              db.prepare('DELETE FROM deduction_logs WHERE id = ?').run(ded.id);
            }
          } else if (!oldIsEarn && newIsEarn) {
            // 旧=非签到 → 新=签到：发放新积分，并镜像首次签到的扣课逻辑（幂等不变）
            if (pointsEarned > 0) {
              addPoints(studentId, student.name, pointsEarned, 'checkin', scheduleId, `${status === 'late' ? '迟到' : '签到'}获得积分`);
            }
            if (status === 'present' || status === 'late') {
              try {
                const dedup = db.prepare('SELECT 1 FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').get(scheduleId, studentId);
                if (!dedup) {
                  const makeupEnroll = db.prepare(
                    "SELECT 1 FROM enrollments WHERE schedule_id = ? AND student_id = ? AND enroll_type IN ('makeup', 'reschedule') AND status = 'active'"
                  ).get(scheduleId, studentId);
                  if (!makeupEnroll) {
                    const card = db.prepare(`
                      SELECT * FROM member_cards
                      WHERE student_id = ? AND status = 'active' AND billing_mode = 'count'
                        AND expires_at > ? AND remaining_classes > 0
                      ORDER BY expires_at ASC LIMIT 1
                    `).get(studentId, now());
                    if (card) {
                      db.prepare(`
                        UPDATE member_cards SET remaining_classes = remaining_classes - 1, used_classes = used_classes + 1, updated_at = ?
                        WHERE id = ?
                      `).run(now(), card.id);
                      db.prepare(`
                        INSERT INTO deduction_logs (schedule_id, student_id, card_id, deducted_at)
                        VALUES (?, ?, ?, ?)
                      `).run(scheduleId, studentId, card.id, now());
                    }
                  } else {
                    db.prepare(`
                      UPDATE makeup_records SET status = 'completed', updated_at = ?
                      WHERE makeup_schedule_id = ? AND student_id = ? AND status = 'pending'
                    `).run(now(), scheduleId, studentId);
                  }
                }
              } catch (e) { /* 扣课失败不影响签到记录 */ }
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
              const dedup = db.prepare('SELECT 1 FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').get(scheduleId, studentId);
              if (!dedup) {
                // 检查是否为补课/调课登记（不扣课）
                const makeupEnroll = db.prepare(
                  "SELECT 1 FROM enrollments WHERE schedule_id = ? AND student_id = ? AND enroll_type IN ('makeup', 'reschedule') AND status = 'active'"
                ).get(scheduleId, studentId);

                if (!makeupEnroll) {
                  const card = db.prepare(`
                    SELECT * FROM member_cards
                    WHERE student_id = ? AND status = 'active' AND billing_mode = 'count'
                      AND expires_at > ? AND remaining_classes > 0
                    ORDER BY expires_at ASC LIMIT 1
                  `).get(studentId, now());
                  if (card) {
                    db.prepare(`
                      UPDATE member_cards SET remaining_classes = remaining_classes - 1, used_classes = used_classes + 1, updated_at = ?
                      WHERE id = ?
                    `).run(now(), card.id);
                    db.prepare(`
                      INSERT INTO deduction_logs (schedule_id, student_id, card_id, deducted_at)
                      VALUES (?, ?, ?, ?)
                    `).run(scheduleId, studentId, card.id, now());
                  }
                } else {
                  // 补课签到完成，更新补课记录状态
                  db.prepare(`
                    UPDATE makeup_records SET status = 'completed', updated_at = ?
                    WHERE makeup_schedule_id = ? AND student_id = ? AND status = 'pending'
                  `).run(now(), scheduleId, studentId);
                }
              }
            } catch (e) { /* 扣课失败不影响签到记录 */ }
          }
        }

        results.push({ studentId, status, pointsEarned });
      })();

      recordAudit(db, {
        entity: 'attendance',
        entityId: `${scheduleId}:${studentId}`,
        action: `checkin_${status}`,
        actorId: actor.id,
        actorRole: actor.role,
        before: beforeAtt,
        after: { status, points_earned: pointsEarned },
      });
    }

    res.json(success({ count: results.length, results }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * Deduct one class from a count card on first arrival.
 * Shared with the teacher roll-call path; idempotent per (schedule, student);
 * must be called inside a transaction.
 */
function applyArrivalDeduction(studentId, scheduleId, t) {
  const dedup = db.prepare('SELECT 1 FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').get(scheduleId, studentId);
  if (dedup) return;
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
  const card = db.prepare(`
    SELECT * FROM member_cards
    WHERE student_id = ? AND status = 'active' AND billing_mode = 'count'
      AND expires_at > ? AND remaining_classes > 0
    ORDER BY expires_at ASC LIMIT 1
  `).get(studentId, t);
  if (!card) return;
  db.prepare(`
    UPDATE member_cards SET remaining_classes = remaining_classes - 1, used_classes = used_classes + 1, updated_at = ?
    WHERE id = ?
  `).run(t, card.id);
  db.prepare(`
    INSERT INTO deduction_logs (schedule_id, student_id, card_id, deducted_at)
    VALUES (?, ?, ?, ?)
  `).run(scheduleId, studentId, card.id, t);
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

    const pointsEarned = 10;
    const t = now();
    // Attendance + points + class deduction in one transaction
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
      } catch (e) { /* 扣课失败不阻塞签到记录，与教练路径保持一致 */ }

      return { attendanceId: id };
    })();
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

  const schedules = db.prepare(`
    SELECT * FROM schedules
    WHERE date = ? AND end_time < ? AND status = 'scheduled'
  `).all(targetDate, currentTime);

  let markedCount = 0;
  for (const schedule of schedules) {
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

      // 自动缺席后通知家长（站内信），避免家长不知情
      try {
        const parent = db.prepare(`
          SELECT parent_openid FROM parent_bindings
          WHERE student_id = ? AND is_main = 1 LIMIT 1
        `).get(stu.student_id);
        if (parent && parent.parent_openid) {
          const noticeId = generateId('NTF');
          const title = '出勤提醒：未参加今日训练';
          const content = `学员「${stu.student_name}」今日（${targetDate}）未参加「${schedule.course_name}」训练（${schedule.start_time}-${schedule.end_time}），已按缺席记录。如有疑问请联系机构。`;
          db.prepare(`
            INSERT INTO notifications (id, user_id, title, content, priority, category, summary, channel, status, sent_at, created_at)
            VALUES (?, ?, ?, ?, 'important', 'attendance', ?, 'inapp', 'sent', ?, ?)
          `).run(noticeId, parent.parent_openid, title, content, content.slice(0, 60), now(), now());
        }
      } catch (e) { /* 通知失败不影响考勤记录 */ }
    }
  }
  return { date: targetDate, markedCount };
}

router.post('/auto-absent', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可执行自动缺席'));
    if (!requireStaffPerm(req, res, 'checkin', '自动缺席')) return;
    const result = runAutoAbsent(req.body?.date);
    res.json(success(result));
  } catch (err) {
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
  const newBal = Math.max(0, (acc.balance || 0) - amount);
  db.prepare(`
    UPDATE points SET total_earned = MAX(0, total_earned - ?), balance = ?, updated_at = ?
    WHERE student_id = ?
  `).run(amount, newBal, now(), studentId);
  db.prepare(`
    INSERT INTO point_logs (id, student_id, type, amount, balance, reference_id, reason, description, created_at)
    VALUES (?, ?, 'checkin', ?, ?, ?, ?, ?, ?)
  `).run(generateId('plog_'), studentId, -amount, newBal, referenceId, description, description, now());
}

/**
 * 获取当前时间字符串 HH:mm
 */
function _currentTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

module.exports = router;
module.exports.runAutoAbsent = runAutoAbsent;
