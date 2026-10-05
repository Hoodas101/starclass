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
// 每次课消耗的课时数（courses.consume_classes）与扣课选卡：与手工扣课路径共用同一实现
const { resolveConsumeClasses, pickCardForDeduction } = require('../utils/deduction');
// 考勤回滚共享原语（积分 / 扣课 / 收入结转的唯一实现）：
// 「取消排期」路径（routes/schedules.js）也回滚同一批副作用，必须共用同一份代码，
// 否则两条回滚路径会各写一份、口径日久漂移。
const { reversePoints, hasRevenueRecognitionTable, revertRevenueRecognition, revertDeduction } = require('../utils/attendance-revert');
// 单价推导（计次卡元/课时）：从卡的关联订单反推实付价，与时效卡摊销共用同一实现。
// 禁止在本文件自行 JSON.parse 订单明细（parseItems 等已收口到 utils/items / utils/revenue）。
const { deriveUnitPrice } = require('../utils/revenue');
// 积分过期时间：签到积分是最大来源，必须与订单/手工调整写入同一 expire_at，
// 否则「24 个月滚动过期」对日常签到获得的积分完全无效（积分只增不减）。
const { computeExpiry } = require('../utils/points-expiry');
// 请假扣课规则（扣课时 / 扣有效天数）：教师点名标 leave 与家长审批走同一实现，
// 否则同一「请假」两条路径两种资产结果。leave.js 不 require 本文件，无循环依赖。
const { applyLeaveDeduction } = require('../routes/leave');
// 「推送规则 → 缺席通知」的读取与文案渲染：与续费/训练提醒共用同一实现（utils/reminders.js）
// 收件人解析与通知 ID 后缀：**必须**复用 utils/reminders 的同一份实现。
// 缺席通知与续费/低课时/训练提醒是同一类需求（通知该学员的家长），若各写一套
// 收件人逻辑，改一处漏两处就会让「双家长家庭的另一方收不到通知」这类缺陷反复复发。
const { getNotificationRule, resolveRuleTemplate, renderNotificationTemplate, listParentOpenids, recipientIdSuffix } = require('../utils/reminders');
const { getTerms } = require('../utils/terms');
// 已删除 / 已归档学员的排除条件（自动缺席与 growth 预警共用同一判据）
const { ACTIVE_STUDENT_SQL } = require('../utils/student-state');

/**
 * 考勤状态白名单 —— 点名入口的唯一合法状态集。
 *
 * 此前 `POST /api/checkin/teacher` 的 `status` 传任意字符串（实测 `"hacked"`）都会
 * **直接落库**。而出勤率（`utils/index.js` 的 attendanceRate）、扣课、积分、薪资计薪
 * 判据（`utils/payroll.js` 的 PAYABLE_SCHEDULE_SQL）全部按 status 分支取值 ——
 * 一条既不是 present/late 也不是 absent/leave 的行，在这些统计里会被**静默排除**，
 * 于是「人算进去了但课时没扣 / 课算进去了但不计薪」这类账实不符无法被发现。
 * 故在入口就拒绝，宁可让脏数据进不来，也不要让它在账里潜伏。
 */
const ATTENDANCE_STATUSES = ['present', 'late', 'absent', 'leave', 'clear'];

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
      // 状态白名单校验（见文件顶部 ATTENDANCE_STATUSES 的注释）。
      // 只拒这一名学员、不中断整批：同批其他学员的合法点名不该被一条脏数据连带回滚。
      if (!ATTENDANCE_STATUSES.includes(status)) {
        results.push({ studentId, status: 'rejected', message: '无效的签到状态' });
        return;
      }
      const student = db.prepare('SELECT name, archived, status FROM students WHERE id = ?').get(studentId);
      if (!student) return;
      // 增量 P1-4：已归档 / 已删除（status='refunded'）学员不得被点名扣课，也不得发积分。
      // 判据与 utils/student-state 的 ACTIVE_STUDENT_SQL 同口径（该常量要求 SQL 中学员表
      // 别名为 s，这里是单行查询故内联展开）。students.js 归档只置 students 表、不动
      // member_cards/points —— 不拦的话已退费学员仍会被扣课并照发积分。
      if (Number(student.archived || 0) !== 0 || String(student.status || '') === 'refunded') {
        results.push({ studentId, status: 'rejected', message: '该学员已归档或已删除，无法点名' });
        return;
      }
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
        // 注意：此处**刻意**不复用 utils/attendance-revert 的 reversePoints。
        // 两者积分算术完全一致（同样按实际生效量扣减 balance/total_earned、写负流水），
        // 但落库文案不等价：这里 reason='清除签到记录，回滚积分' 与
        // description='清除签到记录回滚积分' 是两个不同的字符串，而 reversePoints
        // 把同一个 description 同时写进 reason 与 description 两列。直接替换会改写
        // 已产生流水行的审计文案，故按「不能证明等价就保留内联」处理。
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
        // 回滚次数卡扣课（若已扣）—— 共享实现（utils/attendance-revert），
        // 与「取消排期」回滚路径同一份代码，避免两处口径漂移。
        revertDeduction({ scheduleId, studentId, t });
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

      // P1-D1：时效卡「每周/每月到店次数上限」拦截。present/late 且命中上限时拒绝本次签到，
      // 返回明确文案由前端提示家长联系机构；不写考勤、不扣课、不发积分。
      // 校验在整批 immediate 事务内进行（本函数由 runBatch 调用），保证「计数 + 写入」原子。
      if (status === 'present' || status === 'late') {
        const limitMsg = checkTimeCardVisitLimit(studentId, now());
        if (limitMsg) {
          results.push({ studentId, status: 'rejected', message: limitMsg });
          return;
        }
      }

      // 积分取值改为读设置项 points_rules（原先硬编码 10 / 5，管理员在设置页改了不生效）
      const pointsRule = getPointsRule();
      let pointsEarned = status === 'present' ? pointsRule.present : (status === 'late' ? pointsRule.late : 0);
      // P2 语义收口：学员**仅有暂停卡**（无任何其他可用次数卡/时效卡）时，签到成功但不扣课、
      // 不发积分，响应 results 带 warning 供前端提示。此前暂停卡不会被扣课，积分却照发（白拿）。
      // 仅当「有暂停卡且无任何可用卡」才置 0；非会员（压根没卡）不受影响，保持既有行为。
      const onlyPaused = (status === 'present' || status === 'late')
        && hasNoUsableCardButPaused(studentId, now());
      if (onlyPaused) pointsEarned = 0;

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
            // 共享实现（utils/attendance-revert）：以扣课时记录的真实扣减量为准，
            // 历史行（count 为 NULL）回退到 resolveConsumeClasses 推导
            revertDeduction({ scheduleId, studentId });
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

        // P1-D7：教师点名直接标「请假」此前完全绕过请假扣课规则 —— 不产生
        // leave_deduction_logs、不扣任何课时/天数，于是同一「请假」在家长审批路径扣、
        // 在教师点名路径不扣，规则形同虚设。这里复用 leave.js 的 applyLeaveDeduction
        // （内部以 leave_deduction_logs 幂等，重复调用不会重复扣），仅对「非签到 → 请假」
        // 的转换生效（新建 leave / absent→leave），与审批路径口径一致；
        // present/late→leave 走的是上面的回滚分支（已退还该次课时），不再叠加请假扣课。
        if (status === 'leave'
          && !(existing && (existing.status === 'present' || existing.status === 'late'))) {
          applyLeaveDeduction(studentId, scheduleId, now());
        }

        results.push(onlyPaused
          ? { studentId, status, pointsEarned, warning: '会员卡已暂停，本次未扣课未计积分' }
          : { studentId, status, pointsEarned });
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

    // P1-D1 / 增量 P1-4：被拦截的学员（到店超上限 / 已归档）在 processOne 里 return、
    // 未写任何数据，但结果记在 results 里。只要有拦截即整体返回业务失败并给出明确原因，
    // 前端据此提示家长联系机构。
    // 注意：同一批中**未被拦截**学员的点名已在上面的 immediate 事务内正常提交 ——
    // 每个学员的写入相互独立（各自的考勤/积分/扣课），被拦者未写、通过者已写，不存在半截账目。
    const rejected = results.filter((r) => r.status === 'rejected');
    if (rejected.length) {
      return res.json(fail(rejected.map((r) => r.message).join('；'), 2));
    }

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
  // T7：同一排期+学员若已按请假规则**扣过课时**，则签到侧不得再次扣课。
  // 「先请假获批扣课 → 后改为签到」曾会扣两次课时；两套账本交叉校验后只扣一次。
  // leave_deduction_logs 的记录保留不动（请假路径的幂等依赖该行），此处仅跳过签到侧扣课。
  // 必须过滤 mode='class'：mode='days' 扣的是时效卡**有效天数**（并未消课），
  // 若不过滤，签到侧会把「只扣了有效期」误当成「已扣课时」而跳过 → 学员免费上一次课。
  // 口径与 membership.js 手工扣课的交叉校验一致。
  const leaveDed = db.prepare(
    "SELECT 1 FROM leave_deduction_logs WHERE schedule_id = ? AND student_id = ? AND mode = 'class'"
  ).get(scheduleId, studentId);
  if (leaveDed) return;
  // 只有 makeup（补课）才跳过扣课，reschedule（调课）必须走正常扣课路径：
  //   · makeup：学员缺席时课时已被扣过一次，补课是把这次消耗补偿回来，再扣一次就是重复扣课；
  //   · reschedule：调课的业务入口（routes/makeup.js 的 /reschedule）要求**原排期没有任何签到记录**
  //     （否则直接报「原排期已有签到记录，无法调课」），所以原排期必然从未扣过课时；
  //     若此处再跳过，就会出现「原排期没扣、新排期也不扣」的两头漏扣，学员白上一次课。
  //     enroll_type='reschedule' 在全后端仅由 makeup.js 的调课路径写入，语义唯一，可安全摘出。
  const makeupEnroll = db.prepare(
    "SELECT 1 FROM enrollments WHERE schedule_id = ? AND student_id = ? AND enroll_type = 'makeup' AND status = 'active'"
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
  // 选卡收口到 utils/deduction.pickCardForDeduction：按卡种 course_scope 匹配本课程，
  // 匹配者优先、其次 expires_at ASC，且无匹配时兜底（绝不因范围数据不规范而拒绝扣课）。
  const card = pickCardForDeduction(studentId, scheduleId, t, per);
  if (!card) return;                     // 无任何合格卡：维持原行为（不扣课）
  if (card.scopeMismatch) return;        // 有卡但课程范围不匹配：拒绝扣课，绝不静默扣错卡（如私教卡被团课消耗）
  // 余额条件必须写进 UPDATE 的 WHERE：此前「先 SELECT 校验余额、再按 id 无条件 UPDATE」，
  // 不同排期并发扣同一张卡时两请求会各自读到同一余额、各自扣减 → 余额变负。
  // 加上 remaining_classes >= per 后，UPDATE 由 SQLite 在写锁内原子判定，
  // changes === 0 即代表「并发下已被抢先扣走」，放弃本次扣课（不写流水、不写结转）。
  const upd = db.prepare(`
    UPDATE member_cards SET remaining_classes = remaining_classes - ?, used_classes = used_classes + ?, updated_at = ?
    WHERE id = ? AND remaining_classes >= ?
  `).run(per, per, t, card.id, per);
  if (upd.changes === 0) return;
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
 * 计算 t 时刻所在的自然周（周一为起点）与自然月边界。
 * 周界口径与项目既有实现对齐（admin.js 看板「本周收入」、schedules.js 教练课时统计、
 * points.js 排行榜均以周一为一周起点）：周日（getDay()===0）回退 6 天，否则回退 wd-1 天。
 * @returns {{weekStart:string, weekEnd:string, month:string}} 均为 YYYY-MM-DD / YYYY-MM
 */
function periodBounds(t) {
  const d = new Date(t);
  const wd = d.getDay(); // 0=周日
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (wd === 0 ? 6 : wd - 1));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return {
    weekStart: formatDate(monday.getTime()),
    weekEnd: formatDate(sunday.getTime()),
    month: formatDate(t).slice(0, 7),
  };
}

/**
 * 时效卡「每周/每月到店次数上限」校验（P1-D1）。
 *
 * 字段：member_cards.visit_limit_per_week / visit_limit_per_month（0/NULL = 不限次，
 * 向后兼容存量数据）。到店次数按 attendances.status IN ('present','late') 统计。
 *
 * 多张时效卡时取「限制最严」的那张：对每个周期分别取各卡上限中的**最小值**（忽略 0/不限）。
 * 理由：到店上限是机构对学员频次的约束，取最严的一档才能保证任何一张卡的限制都不被突破；
 * 若取最松的，等于让宽松卡「洗掉」严格卡的限制。
 *
 * @returns {string|null} 命中上限时返回明确文案，否则 null
 */
function checkTimeCardVisitLimit(studentId, t) {
  // 不限卡种：此前硬过滤 billing_mode='time'，导致「次卡」在卡种页可配到店限次却静默不生效
  //（经营者以为已约束、实则空转）。现对次卡与时效卡一并校验，取最严档。
  const cards = db.prepare(`
    SELECT visit_limit_per_week, visit_limit_per_month FROM member_cards
    WHERE student_id = ? AND status = 'active' AND expires_at > ?
  `).all(studentId, t);
  if (!cards.length) return null;

  const pos = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  let weekLimit = 0;
  let monthLimit = 0;
  for (const c of cards) {
    const w = pos(c.visit_limit_per_week);
    if (w && (!weekLimit || w < weekLimit)) weekLimit = w;
    const m = pos(c.visit_limit_per_month);
    if (m && (!monthLimit || m < monthLimit)) monthLimit = m;
  }
  if (!weekLimit && !monthLimit) return null; // 全部不限次

  const { weekStart, weekEnd, month } = periodBounds(t);
  if (weekLimit) {
    const c = db.prepare(`
      SELECT COUNT(*) c FROM attendances
      WHERE student_id = ? AND status IN ('present','late') AND date >= ? AND date <= ?
    `).get(studentId, weekStart, weekEnd).c;
    if (c >= weekLimit) return `本周到店已达上限（${weekLimit} 次），如需加课请联系机构`;
  }
  if (monthLimit) {
    const c = db.prepare(`
      SELECT COUNT(*) c FROM attendances
      WHERE student_id = ? AND status IN ('present','late') AND date LIKE ?
    `).get(studentId, month + '%').c;
    if (c >= monthLimit) return `本月到店已达上限（${monthLimit} 次），如需加课请联系机构`;
  }
  return null;
}

/**
 * 学员是否「仅有暂停卡」：存在暂停卡，且没有任何可用的次数卡/时效卡。
 * 用于 P2 语义收口 —— 仅暂停卡学员签到成功但不扣课、不发积分（响应带 warning）。
 * 「可用」判据与扣课选卡一致：active + 次数卡有余量 / 时效卡未过期。
 */
function hasNoUsableCardButPaused(studentId, t) {
  const usable = db.prepare(`
    SELECT 1 FROM member_cards
    WHERE student_id = ? AND status = 'active'
      AND ((billing_mode = 'count' AND remaining_classes > 0)
        OR (billing_mode = 'time' AND expires_at > ?))
    LIMIT 1
  `).get(studentId, t);
  if (usable) return false;
  const paused = db.prepare(
    "SELECT 1 FROM member_cards WHERE student_id = ? AND status = 'paused' LIMIT 1"
  ).get(studentId);
  return !!paused;
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

    const student = db.prepare('SELECT name, archived, status FROM students WHERE id = ?').get(studentId);
    if (!student) return res.json(fail('成员不存在'));
    // 增量 P1-4：已归档 / 已删除学员不得扫码签到（判据同 utils/student-state 的 ACTIVE_STUDENT_SQL）
    if (Number(student.archived || 0) !== 0 || String(student.status || '') === 'refunded') {
      return res.json(fail('该成员已归档或已删除，无法签到'));
    }

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

      // P1-D1：时效卡周期到店上限校验，在写入前于同一事务内判定，命中即拒绝签到
      const limitMsg = checkTimeCardVisitLimit(studentId, t);
      if (limitMsg) return { err: limitMsg };

      // P2：仅有暂停卡（无任何可用卡）时签到成功但不发积分（扣课本就不会发生），响应带 warning
      const onlyPaused = hasNoUsableCardButPaused(studentId, t);
      const earned = onlyPaused ? 0 : pointsEarned;

      const id = generateId('att_');
      db.prepare(`
        INSERT INTO attendances (id, schedule_id, student_id, student_name, course_id, course_name,
          status, checkin_method, checkin_time, checkin_by, points_earned, date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'present', 'qrcode', ?, 'parent', ?, ?, ?, ?)
      `).run(id, scheduleId, studentId, student.name, schedule.course_id, schedule.course_name,
        t, earned, schedule.date, t, t);

      addPoints(studentId, student.name, earned, 'checkin', scheduleId, '家长扫码签到获得积分');
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

      return { attendanceId: id, pointsEarned: earned, onlyPaused };
    }).immediate();
    if (outcome.err) return res.json(fail(outcome.err));

    recordAudit(db, {
      entity: 'attendance',
      entityId: `${scheduleId}:${studentId}`,
      action: 'checkin_present',
      actorId: actor.id,
      actorRole: actor.role,
      before: null,
      after: { status: 'present', points_earned: outcome.pointsEarned },
    });

    res.json(success({
      attendanceId: outcome.attendanceId,
      pointsEarned: outcome.pointsEarned,
      ...(outcome.onlyPaused ? { warning: '会员卡已暂停，本次未扣课未计积分' } : {}),
    }));
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
      JOIN students s ON s.id = e.student_id
      LEFT JOIN attendances a ON a.schedule_id = e.schedule_id AND a.student_id = e.student_id
      WHERE e.schedule_id = ? AND e.status = 'active' AND a.id IS NULL
        AND COALESCE(e.enroll_type, '') <> 'makeup'
        AND ${ACTIVE_STUDENT_SQL}
    `).all(schedule.id);
    // 上面这条排除不可删：删除学员只置 students.status='refunded'、不清理 enrollments，
    // 漏掉它的话定时任务会**每天**为已删学员插一条 absent 并给家长推送缺席通知，
    // 考勤统计与出勤率也随之失真（家长还会收到早已退学孩子的训练提醒）。
    //
    // enroll_type='makeup' 的排除（补课链修复）：补课排期上的学员是**为补一次已缺席的课**
    // 而来，若他没到场，把他再标成缺席，/makeup/eligible 就会认为他又产生了一次可补课的缺席
    // → 被安排「补课的补课」，链条无限延伸。补课未到场应视为该次补课作废，而非新缺席。
    // 判据用 COALESCE 兜底 NULL：enroll_type 为 NULL 时 `NULL <> 'makeup'` 在 SQL 三值逻辑下
    // 不为真，会误伤历史数据里的普通报名。
    // 只排除 makeup、不排除 reschedule：调课是把学员换到另一场次上正课，缺席照常标记。

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
          // 收件人 = 该学员的**全部有效家长**（去重去空），而不是「is_main=1 单家长」：
          // 双家长家庭里非主家长同样需要知情（接送/请假/续费决策）；且历史数据
          // 存在 is_main 全为 0 的学员，只取主家长会导致一条通知都发不出去。
          const recipients = listParentOpenids(stu.student_id);
          if (recipients.length === 0) {
            // 无法送达必须留下可排查的痕迹，不能静默丢弃 —— 运营需要知道哪些学员
            // 的相关通知是发不出去的（往往是建档时漏绑家长）。
            console.warn(
              `[checkin auto-absent] 学员 ${stu.student_id}（${stu.student_name || '未命名'}）` +
              `排期 ${schedule.id} 缺席通知无法送达：无任何有效家长绑定`
            );
          }
          for (const openid of recipients) {
            // ID 必须带收件人后缀：同一条缺席提醒给多个家长各插一行，
            // 若共用同一个 ID 会撞 notifications 主键，只建得出第一条。
            const noticeId = `${generateId('NTF')}_${recipientIdSuffix(openid)}`;
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
            `).run(noticeId, openid, title, content, content.slice(0, 60), now(), now());
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

  // 记录流水（expire_at：发放即写入 24 个月后的过期时间，供日调度回收）
  const logId = generateId('plog_');
  const logTs = now();
  db.prepare(`
    INSERT INTO point_logs (id, student_id, type, amount, balance, reference_id, reason, description, created_at, expire_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(logId, studentId, type, amount, account.balance, referenceId, description, description, logTs, computeExpiry(logTs));
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
// hasRevenueRecognitionTable / revertRevenueRecognition 已迁至 utils/attendance-revert.js
// （取消排期路径同样需要冲销结转，必须共用同一实现）。
// deriveUnitPrice 已迁至 utils/revenue.js —— 时效卡按时间摊销结转同样需要它，
// 且本文件是 routes/ 下的，若由 utils/revenue.js 反过来 require 本文件会成环，
// 故按「单向依赖：routes/checkin.js → utils/revenue.js」组织。

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

module.exports = router;
module.exports.runAutoAbsent = runAutoAbsent;
