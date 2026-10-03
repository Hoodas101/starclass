/**
 * 体测记录路由 — 学员体测档案（身高/体重/BMI + 纵跳/坐位体前屈/折返跑）
 * GET    /api/physical-tests?studentId=&startDate=&endDate=&page=&pageSize= — 某学员体测列表
 * POST   /api/physical-tests      — 录入体测（同一学员同一日期重复提交 = 更新，不新增）
 * PUT    /api/physical-tests/:id  — 修改一条体测记录
 * DELETE /api/physical-tests/:id  — 删除一条体测记录
 *
 * 背景（业务适配审计 P1-D4）：全库原本没有体测模块，学员只有单值 height/weight/bmi，
 * 没有历史、没有趋势。而「看得见的训练进步」正是儿童体育培训的核心卖点 ——
 * 家长为效果续费、教练靠体测对比建立专业信任，这些数据此前只能留在系统外。
 *
 * 授权策略（与 routes/students.js 保持一致）：
 *  - 读写均要求已登录（server.js 全局 JWT 中间件已拦截未登录）。
 *  - 写入（POST/PUT/DELETE）：管理员 / 教练（isCoachReq）。
 *  - 读取：家长仅可读自己绑定的学员（canViewStudentData），管理员/教练可读全部。
 *
 * 表结构见 migrations/024_physical_tests.js（指标列可空 —— 不同年龄段测的项目不同，
 * 强制填满只会逼出假数据）。
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, now, parsePagination, isCoachReq, canViewStudentData, getActor, recordAudit } = require('../utils');
// 「在册」判据唯一来源（archived=0 且 status≠refunded）。SQL 中学员表别名为 s。
const { ACTIVE_STUDENT_SQL } = require('../utils/student-state');

// 各指标的合理范围（写入侧统一在此校验，避免「同一个字段两种单位/两个口径」）
const RANGES = {
  heightCm: { min: 30, max: 250, label: '身高(cm)' },
  weightKg: { min: 5, max: 300, label: '体重(kg)' },
  bmi: { min: 5, max: 60, label: 'BMI' },
  jumpCm: { min: 0, max: 150, label: '纵跳(cm)' },
  sitReachCm: { min: -50, max: 60, label: '坐位体前屈(cm)' },
  shuttleRunS: { min: 1, max: 120, label: '折返跑(s)' },
};

/**
 * 校验 YYYY-MM-DD 是否为**真实存在**的日期。
 * 只跑正则不够：2015-02-29 会被 SQLite 宽松的 date() 静默归一成 2015-03-01 后入库，
 * 体测趋势的日期轴从此错一天。
 */
function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 校验可空数值字段：空值 → null；非空时必须是有限数且在范围内。 */
function parseNum(raw, { min, max, label }) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, message: `${label}必须是数字` };
  if (n < min || n > max) return { ok: false, message: `${label}需在 ${min}–${max} 之间` };
  return { ok: true, value: n };
}

/**
 * 解析并校验体测请求体（POST / PUT 共用）。
 * @returns {{ok:false, message:string} | {ok:true, data:object}}
 */
function parseBody(body = {}) {
  const studentId = String(body.studentId || '').trim();
  if (!studentId) return { ok: false, message: '缺少成员 ID' };
  // 学员必须存在且在册（已删除/已归档学员不得再录体测）
  const stu = db.prepare(`SELECT s.name AS name, ${ACTIVE_STUDENT_SQL} AS active FROM students s WHERE s.id = ?`).get(studentId);
  if (!stu) return { ok: false, message: '成员不存在' };
  if (!stu.active) return { ok: false, message: '该成员已删除或已归档，不能录入体测' };

  const testDate = String(body.testDate || '').trim();
  if (!isValidDateStr(testDate)) return { ok: false, message: `体测日期「${testDate || ''}」无效（格式 YYYY-MM-DD）` };

  const nums = {};
  for (const key of Object.keys(RANGES)) {
    const r = parseNum(body[key], RANGES[key]);
    if (!r.ok) return r;
    nums[key] = r.value;
  }

  // BMI 自动推导：身高体重都有、但未显式给 BMI 时按 kg/m² 计算（保留 1 位小数）
  let bmi = nums.bmi;
  if (bmi === null && nums.heightCm !== null && nums.weightKg !== null && nums.heightCm > 0) {
    bmi = Math.round((nums.weightKg / Math.pow(nums.heightCm / 100, 2)) * 10) / 10;
  }

  return {
    ok: true,
    data: {
      studentId,
      studentName: stu.name || '',
      testDate,
      heightCm: nums.heightCm,
      weightKg: nums.weightKg,
      bmi,
      jumpCm: nums.jumpCm,
      sitReachCm: nums.sitReachCm,
      shuttleRunS: nums.shuttleRunS,
      remark: String(body.remark || '').trim(),
      tester: String(body.tester || '').trim(),
    },
  };
}

/** 库行 → 前端 camelCase 结构 */
function fmt(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name || '',
    testDate: row.test_date || '',
    heightCm: row.height_cm,
    weightKg: row.weight_kg,
    bmi: row.bmi,
    jumpCm: row.jump_cm,
    sitReachCm: row.sit_reach_cm,
    shuttleRunS: row.shuttle_run_s,
    remark: row.remark || '',
    tester: row.tester || '',
    createdAt: row.created_at || 0,
    updatedAt: row.updated_at || 0,
  };
}

/**
 * GET /api/physical-tests — 某学员体测列表（按 test_date DESC）
 * Query: { studentId(必填), startDate?, endDate?, page, pageSize }
 * 体测是学员维度数据，全库列出无意义，故 studentId 必填。
 */
router.get('/', (req, res) => {
  try {
    const { studentId, startDate, endDate } = req.query;
    if (!studentId) return res.json(fail('缺少成员 ID'));
    // 家长仅可读自己绑定的学员；管理员/教练可读全部
    if (!canViewStudentData(req, studentId)) return res.status(403).json(safeFail('无权查看该成员的体测记录'));

    const { page, pageSize, offset } = parsePagination(req.query);

    let where = 'WHERE student_id = ?';
    const params = [studentId];
    if (startDate) { where += ' AND test_date >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND test_date <= ?'; params.push(endDate); }

    const total = db.prepare(`SELECT COUNT(*) AS count FROM physical_tests ${where}`).get(...params).count;
    const list = db.prepare(`
      SELECT * FROM physical_tests ${where}
      ORDER BY test_date DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset).map(fmt);

    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    console.error('[physical-tests list]', err);
    res.status(500).json(safeFail('获取体测记录失败'));
  }
});

/**
 * POST /api/physical-tests — 录入体测
 * 同一学员同一 testDate 重复提交时**更新已有记录**而非新增 ——
 * 否则同一天会攒出多条记录，趋势图出现锯齿（同一天两个点）。
 */
router.post('/', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可录入体测'));
    const parsed = parseBody(req.body);
    if (!parsed.ok) return res.json(fail(parsed.message));
    const d = parsed.data;

    const existing = db.prepare('SELECT id FROM physical_tests WHERE student_id = ? AND test_date = ?').get(d.studentId, d.testDate);
    const t = now();
    const actor = getActor(req);

    if (existing) {
      db.prepare(`
        UPDATE physical_tests SET student_name = ?, height_cm = ?, weight_kg = ?, bmi = ?, jump_cm = ?,
          sit_reach_cm = ?, shuttle_run_s = ?, remark = ?, tester = ?, updated_at = ?
        WHERE id = ?
      `).run(d.studentName, d.heightCm, d.weightKg, d.bmi, d.jumpCm, d.sitReachCm, d.shuttleRunS, d.remark, d.tester, t, existing.id);
      recordAudit(db, {
        entity: 'physical_test',
        entityId: existing.id,
        action: 'update',
        actorId: actor.id,
        actorRole: actor.role,
        after: { student_id: d.studentId, test_date: d.testDate, dedup: true },
      });
      return res.json(success({ id: existing.id }));
    }

    const id = generateId('pt_');
    db.prepare(`
      INSERT INTO physical_tests (id, student_id, student_name, test_date, height_cm, weight_kg, bmi,
        jump_cm, sit_reach_cm, shuttle_run_s, remark, tester, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, d.studentId, d.studentName, d.testDate, d.heightCm, d.weightKg, d.bmi,
      d.jumpCm, d.sitReachCm, d.shuttleRunS, d.remark, d.tester, t, t);
    recordAudit(db, {
      entity: 'physical_test',
      entityId: id,
      action: 'create',
      actorId: actor.id,
      actorRole: actor.role,
      after: { student_id: d.studentId, test_date: d.testDate },
    });
    res.json(success({ id }));
  } catch (err) {
    console.error('[physical-tests create]', err);
    res.status(500).json(safeFail('保存体测记录失败'));
  }
});

/**
 * PUT /api/physical-tests/:id — 修改一条体测记录
 */
router.put('/:id', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可修改体测'));
    const { id } = req.params;
    const before = db.prepare('SELECT * FROM physical_tests WHERE id = ?').get(id);
    if (!before) return res.status(404).json(safeFail('体测记录不存在'));

    const parsed = parseBody(req.body);
    if (!parsed.ok) return res.json(fail(parsed.message));
    const d = parsed.data;

    // 修改后若与**另一条**记录的「学员+日期」撞车，会破坏「同一学员同一日期只一条」的
    // 不变量（趋势图又出现锯齿），故明确拒绝。
    const clash = db.prepare('SELECT id FROM physical_tests WHERE student_id = ? AND test_date = ? AND id <> ?')
      .get(d.studentId, d.testDate, id);
    if (clash) return res.json(fail('该学员在该日期已有一条体测记录，请改为编辑那条记录'));

    const t = now();
    db.prepare(`
      UPDATE physical_tests SET student_id = ?, student_name = ?, test_date = ?, height_cm = ?, weight_kg = ?, bmi = ?,
        jump_cm = ?, sit_reach_cm = ?, shuttle_run_s = ?, remark = ?, tester = ?, updated_at = ?
      WHERE id = ?
    `).run(d.studentId, d.studentName, d.testDate, d.heightCm, d.weightKg, d.bmi,
      d.jumpCm, d.sitReachCm, d.shuttleRunS, d.remark, d.tester, t, id);

    const actor = getActor(req);
    recordAudit(db, {
      entity: 'physical_test',
      entityId: id,
      action: 'update',
      actorId: actor.id,
      actorRole: actor.role,
      before: { student_id: before.student_id, test_date: before.test_date },
      after: { student_id: d.studentId, test_date: d.testDate },
    });
    res.json(success({ id }));
  } catch (err) {
    console.error('[physical-tests update]', err);
    res.status(500).json(safeFail('更新体测记录失败'));
  }
});

/**
 * DELETE /api/physical-tests/:id — 删除一条体测记录
 */
router.delete('/:id', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可删除体测'));
    const { id } = req.params;
    const before = db.prepare('SELECT id, student_id, test_date FROM physical_tests WHERE id = ?').get(id);
    if (!before) return res.status(404).json(safeFail('体测记录不存在'));

    db.prepare('DELETE FROM physical_tests WHERE id = ?').run(id);
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'physical_test',
      entityId: id,
      action: 'delete',
      actorId: actor.id,
      actorRole: actor.role,
      before: { student_id: before.student_id, test_date: before.test_date },
    });
    res.json(success({ id }));
  } catch (err) {
    console.error('[physical-tests delete]', err);
    res.status(500).json(safeFail('删除体测记录失败'));
  }
});

module.exports = router;
