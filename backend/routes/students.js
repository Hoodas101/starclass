/**
 * 成员路由 — 成员 CRUD、家长绑定成员列表、二维码、首页数据
 * POST /api/students              — 创建成员
 * GET  /api/students              — 成员列表（搜索 + 分页）
 * GET  /api/students/my           — 当前家长绑定的成员
 * GET  /api/students/:id          — 成员详情（含绑定家长、会员卡、积分）
 * PUT  /api/students/:id          — 更新成员
 * POST /api/students/:id/qrcode   — 生成签到二维码内容
 * GET  /api/students/home/data    — 首页数据（成员信息 + 会员卡 + 今日活动）
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
// attendanceRate 别名 calcAttendanceRate：本文件 /:id/stats 内已有同名局部变量，
// 直接解构会同名遮蔽。到场率口径全站唯一，必须复用而非另写公式。
const { generateId, success, fail, safeFail, getOpenId, getActor, recordAudit, escapeLike, now, parsePagination, isStaffReq, isCoachReq, hasPerm, getReqUser, isAdminReq, JWT_SECRET: QR_SECRET, attendanceRate: calcAttendanceRate } = require('../utils');
const { parseItems } = require('../utils/items');
// 流失阈值唯一来源（settings.churn_rules）——与 followups / growth 同源，
// 避免同一学员在不同页面被判定为「流失」的时间不一致
const { getChurnRules } = require('../utils/churn');
// 建档查重（手机号相同 = 强重复，阻止同一人被录成两份）
// normalizePhone / PHONE_RE 与查重同源：导入时先规范化再校验，避免同一号码两套判据
const { findDuplicateStudents, normalizePhone, PHONE_RE } = require('../utils/duplicate');
// 已删除 / 已归档学员的排除条件（学员下拉与 growth 预警共用同一判据）
const { ACTIVE_STUDENT_SQL } = require('../utils/student-state');

// member_no / archived / qr_exp 列已收编至 migrations/011。
// 会员编号回填：只补空号（从现有最大编号继续），绝不重排已有编号——
// 编号被 auth.js bindStudent 用于区分同名学员，整体重排会破坏对账与绑定。
function nextMemberNo() {
  const rows = db.prepare("SELECT member_no FROM students WHERE member_no LIKE 'NO-%'").all();
  const max = rows
    .map(x => { const m = /^NO-(\d+)$/.exec(x.member_no || ''); return m ? parseInt(m[1], 10) : 0; })
    .reduce((a, b) => Math.max(a, b), 0);
  return `NO-${String(max + 1).padStart(4, '0')}`;
}
function backfillEmptyMemberNo() {
  try {
    const empties = db.prepare("SELECT id FROM students WHERE member_no = '' OR member_no IS NULL ORDER BY created_at ASC, id ASC").all();
    if (!empties.length) return;
    const upd = db.prepare('UPDATE students SET member_no = ? WHERE id = ?');
    let n = Number((/^NO-(\d+)$/.exec(nextMemberNo())[1])) - 1;
    const tx = db.transaction(() => {
      empties.forEach(s => {
        n += 1;
        upd.run(`NO-${String(n).padStart(4, '0')}`, s.id);
      });
    });
    tx();
  } catch (e) { /* 回填失败不阻塞启动 */ }
}
backfillEmptyMemberNo();

// 认证中间件
function requireAuth(req, res, next) {
  const openid = getOpenId(req);
  if (!openid) return res.status(401).json(safeFail('未登录'));
  req.openid = openid;
  next();
}

// 管理员判断统一来自 utils（此前本文件用 req.openid 自实现了一份，与全局中间件行为等价但属重复实现）
// 成员查看权限：按「students」权限键判定（管理员 resolvePerms 返回 ['*'] 恒通过；
// DEFAULT_PERMS.coach / DEFAULT_PERMS.sales 均含 'students'，故未自定义权限的默认教练/销售不受影响；
// 自定义权限数组中不含 'students' 的员工被拒）。家长走各调用点的 `bind` 分支，不经此函数。
function canViewStudents(req) {
  return hasPerm(getReqUser(req), 'students');
}

/**
 * POST /api/students — 创建成员
 * Body: { name, gender, birthday, school, grade, hobby, remark, phone, parentName }
 */
router.post('/', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可新增成员'));
    const { name, gender, birthday, school, grade, hobby, remark, level, height, weight, bmi, phone, parentName, confirmDuplicate } = req.body;
    if (!name) return res.json(fail('成员姓名不能为空'));

    // 建档查重：同一孩子被录两遍会让课时/积分/订单/考勤全部裂成两份且难以合并。
    // 手机号相同视为强重复 → 不直接建档，回传候选让操作者确认（confirmDuplicate 表示已确认）。
    // 仅同名不拦截（小机构同名常见），但在候选里一并给出供人工判断。
    if (!confirmDuplicate) {
      const dup = findDuplicateStudents({ name, phone });
      if (dup.hasStrong) {
        return res.json(success({ duplicate: true, candidates: dup.list }));
      }
    }

    const id = generateId('stu_');
    // 新建学员即分配会员编号（避免留空：空号曾触发整体重排导致全员编号漂移）
    db.prepare(`
      INSERT INTO students (id, name, gender, birthday, school, grade, hobby, level, height, weight, bmi, remark, status, join_date, member_no, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(id, name, gender || '', birthday || '', school || '', grade || '', hobby || '', level || '',
      height !== undefined && height !== '' ? Number(height) : 0,
      weight !== undefined && weight !== '' ? Number(weight) : 0,
      bmi !== undefined && bmi !== '' ? Number(bmi) : 0,
      remark || '', now(), nextMemberNo(), now(), now());

    // 录入家长手机号时，同时建立绑定关系与家长账号，便于手机号登录。
    // 与批量导入走**同一判据**（utils/duplicate 的 normalizePhone + PHONE_RE）：先规范化
    // 全角数字、空格、横线、+86/0086 前缀，再校验。原先这里用裸正则 ^1[3-9]\d{9}$，
    // 于是「138 0013 8000」「+8613800138000」这类最常见的写法会静默跳过下面的家长账号
    // 与绑定 —— 学员建好了、家长却永远登不上，之后所有家长通知都发不到人且无人察觉。
    const phoneNorm = normalizePhone(String(phone || ''));
    const phoneOk = PHONE_RE.test(phoneNorm);
    if (phoneOk) {
      const parentNameVal = parentName || `${name}家长`;
      const openid = `phone_${phoneNorm}`;
      const existingUser = db.prepare('SELECT id FROM users WHERE phone = ?').get(phoneNorm);
      if (!existingUser) {
        db.prepare(`
          INSERT INTO users (id, openid, phone, nickname, avatar, role, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '', 'parent', 'active', ?, ?)
        `).run(generateId('user_'), openid, phoneNorm, parentNameVal, now(), now());
      } else {
        // 保留微信身份账号的 openid（wx_ 前缀），避免再次微信登录时账号分裂
        if (!String(existingUser.openid || '').startsWith('wx_')) {
          db.prepare('UPDATE users SET openid = ? WHERE phone = ?').run(openid, phoneNorm);
        }
      }
      // 绑定记录使用该手机号用户的实际 openid（微信身份为 wx_ 前缀），保证登录后可见绑定
      const bindOpenid = existingUser ? String(existingUser.openid || '') : openid;
      // 去重：同一成员同一家长手机号只保留一条绑定
      const dupBind = db.prepare('SELECT 1 FROM parent_bindings WHERE student_id = ? AND parent_phone = ?').get(id, phoneNorm);
      if (!dupBind) {
        db.prepare(`
          INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at)
          VALUES (?, ?, ?, ?, ?, '家长', 1, ?)
        `).run(id, name, parentNameVal, bindOpenid, phoneNorm, now());
      }
    }

    // 新建成员会分配会员编号并可能创建家长账号/绑定，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'student',
      entityId: id,
      action: 'create',
      actorId: actor.id,
      actorRole: actor.role,
      after: { name, status: 'active', has_parent_phone: !!phoneOk },
    });

    res.json(success({ id, name }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * POST /api/students/import — 批量导入成员（CSV 解析后由前端提交 JSON）
 * Body: { rows: [{ name, gender, birthday, school, grade, level, parentName, phone, remark }] }
 * 返回 { success, created, failed: [{ row, reason }], unlinked, warnings: [{ row, name, phone, reason }],
 *        skipped, skippedRows: [{ row, name, phone, reason }] }
 * 说明：warnings 只表示「学员已建成功、但家长绑定未建」，不计入 failed。
 *       学员本身建成了就不算失败，但不能因此把它报成完整成功。
 *       skipped 是查重命中而跳过的行（自然键：家长手机号优先，无有效手机号时用姓名），
 *       属正常业务分支，不计入 failed，也不会触发整批回滚。
 */
router.post('/import', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可导入成员'));
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.json(fail('未提供导入数据'));
    if (rows.length > 2000) return res.json(fail('单次最多导入 2000 条'));

    // 整批原子导入：任一行失败回滚全部，避免部分提交留下脏数据
    const runImport = db.transaction(() => {
      const okCount = [];
      const failed = [];
      // 学员已建成功、但家长绑定未建的行：既不算失败，也不能报成完整成功
      const warnings = [];
      // 查重命中而跳过的行：正常业务分支，既不是失败，也绝不触发整批回滚
      const skipped = [];
      // 「已删除 / 已归档」判据唯一来源 ACTIVE_STUDENT_SQL（archived=1 或 status='refunded'）。
      // 已删学员同样参与查重，否则用户删错后重新导入会凭空多出一份重复档案。
      const inactiveStmt = db.prepare(`SELECT ${ACTIVE_STUDENT_SQL} AS active FROM students s WHERE s.id = ?`);
      const isInactive = (sid) => { const st = inactiveStmt.get(sid); return !(st && st.active); };
      rows.forEach((r, idx) => {
        const name = String(r.name || '').trim();
        if (!name) {
          failed.push({ row: idx + 2, reason: '姓名不能为空' });
          return;
        }
        // 手机号先规范化再校验：Excel 复制来的号码常带空格、横线、括号、全角数字或 +86 前缀，
        // 直接拿原始串跑 ^1[3-9]\d{9}$ 会把这类行整行判为「没有手机号」而静默跳过家长绑定，
        // 结果学员建了、家长却永远绑不上，之后所有家长通知都发不到人且无人察觉。
        const phoneRaw = String(r.phone || '').trim();
        const phone = normalizePhone(phoneRaw);
        const phoneOk = PHONE_RE.test(phone);

        // ── 导入查重（自然键）──
        // 与建档查重同源：优先家长手机号，且必须先 normalizePhone 归一后再比，
        // 否则「138 0013 8000」这类带空格的号码会被判成没有手机号而漏查；无有效手机号时退回姓名匹配。
        // 命中即跳过、不重复建档 —— 前端导入弹窗已明确承诺「姓名+手机号已存在的成员会被自动跳过」，
        // 后端必须真的做，否则就是假承诺，用户会放心地重复导入。
        const dup = findDuplicateStudents({ name, phone: phoneOk ? phone : '' });
        let hit = phoneOk ? dup.list.find(x => x.strength === 'strong') : null;
        if (!hit) {
          // 手机号没命中时按姓名兜底：软删除（DELETE /:id）会把 parent_bindings 一并删除，
          // 已删学员因此再也查不到手机号，只能靠姓名找回 —— 否则「删错了再导一次」会凭空
          // 多出一份重复档案（课时/积分/订单再次裂开）。同名「在档」学员是弱信号，不拦。
          const nameHits = dup.list.filter(x => x.strength === 'weak');
          hit = nameHits.find(c => !phoneOk || isInactive(c.id)) || null;
        }
        if (hit) {
          const by = hit.strength === 'strong' ? '手机号' : '姓名';
          skipped.push({
            row: idx + 2,
            name,
            phone: phoneOk ? phone : phoneRaw,
            reason: isInactive(hit.id)
              ? `已存在同${by}的已删除/已归档成员「${hit.name}」，本次跳过；如需重新建档请先恢复该档案或更换${by}`
              : `已存在同${by}的成员「${hit.name}」，本次跳过，不重复建档`,
          });
          return;
        }

        const id = generateId('stu_');
        const t = now();
        const statusVal = String(r.status || '').trim() || 'active';
        const joinRaw = String(r.joinDate || r.join_date || '').trim();
        const joinDateVal = joinRaw ? new Date(joinRaw + 'T12:00:00').getTime() || t : t;
        db.prepare(`
          INSERT INTO students (id, name, gender, birthday, school, grade, level, remark, status, join_date, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, name, String(r.gender || '').trim(), String(r.birthday || '').trim(), String(r.school || '').trim(),
          String(r.grade || '').trim(), String(r.level || '').trim(), String(r.remark || '').trim(), statusVal, joinDateVal, t, t);

        if (phoneOk) {
          const parentNameVal = String(r.parentName || '').trim() || `${name}家长`;
          const openid = `phone_${phone}`;
          const existingUser = db.prepare('SELECT id, openid FROM users WHERE phone = ?').get(phone);
          if (!existingUser) {
            db.prepare(`
              INSERT INTO users (id, openid, phone, nickname, avatar, role, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, '', 'parent', 'active', ?, ?)
            `).run(generateId('user_'), openid, phone, parentNameVal, t, t);
          } else {
            // 保留微信身份账号的 openid（wx_ 前缀），避免再次微信登录时账号分裂
            if (!String(existingUser.openid || '').startsWith('wx_')) {
              db.prepare('UPDATE users SET openid = ? WHERE phone = ?').run(openid, phone);
            }
          }
          const bindOpenid = existingUser ? String(existingUser.openid || '') : openid;
          const dupBind = db.prepare('SELECT 1 FROM parent_bindings WHERE student_id = ? AND parent_phone = ?').get(id, phone);
          if (!dupBind) {
            db.prepare(`
              INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at)
              VALUES (?, ?, ?, ?, ?, '家长', 1, ?)
            `).run(id, name, parentNameVal, bindOpenid, phone, t);
          }
        }
        // 学员本身已建成功，一律计入成功列表（手机号问题不改变成功/失败判定）；
        // 但家长绑定到底建没建必须如实标出，供前端提示老师补录。
        okCount.push({ name, phone: phoneOk ? phone : phoneRaw, parentLinked: phoneOk });
        if (!phoneOk) {
          warnings.push({
            row: idx + 2,
            name,
            phone: phoneRaw,
            reason: phoneRaw
              ? `家长手机号「${phoneRaw}」不是有效的 11 位手机号，该学员未建立家长绑定，请补录后再发通知`
              : '未填写家长手机号，该学员未建立家长绑定',
          });
        }
      });

      // 仅回填缺失的会员编号，保留已有编号（从现有最大值继续，不整体重排）
      const empty = db.prepare("SELECT COUNT(*) c FROM students WHERE member_no = '' OR member_no IS NULL").get().c;
      if (empty > 0) {
        const maxNo = db.prepare("SELECT member_no FROM students WHERE member_no LIKE 'NO-%'").all()
          .map(x => { const m = /^NO-(\d+)$/.exec(x.member_no || ''); return m ? parseInt(m[1], 10) : 0; })
          .reduce((a, b) => Math.max(a, b), 0);
        let next = maxNo;
        const empties = db.prepare("SELECT id FROM students WHERE member_no = '' OR member_no IS NULL ORDER BY created_at ASC, id ASC").all();
        const upd = db.prepare("UPDATE students SET member_no = ? WHERE id = ?");
        empties.forEach(s => {
          next += 1;
          upd.run(`NO-${String(next).padStart(4, '0')}`, s.id);
        });
      }

      return { okCount, failed, warnings, skipped };
    });

    const { okCount, failed, warnings, skipped } = runImport();
    // 批量导入属批量改写业务数据的高危操作，必须留痕（批次无单一主键，entityId 留空）
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'student',
      entityId: '',
      action: 'import',
      actorId: actor.id,
      actorRole: actor.role,
      // 审计如实记录「未建家长绑定」的行数，否则事后无从判断这批学员的家长能否收到通知；
      // skipped 同样入账，避免「导入 100 条只建了 60 条」在审计里看不出原因
      after: { created: okCount.length, failed: failed.length, unlinked: warnings.length, skipped: skipped.length },
    });
    // 保持 success / created / failed 结构不变（前端与既有调用方依赖），
    // 新增 unlinked + warnings 如实说明哪些学员没建上家长绑定，
    // 新增 skipped + skippedRows 如实说明哪些行因查重被跳过（不再静默少导入几条）。
    res.json(success({
      success: okCount.length,
      failed,
      created: okCount.length,
      unlinked: warnings.length,
      warnings,
      skipped: skipped.length,
      skippedRows: skipped,
    }));
  } catch (err) {
    console.error('[students import]', err);
    res.status(500).json(safeFail('导入失败，请稍后重试'));
  }
});

/**
 * GET /api/students — 成员列表（支持 keyword 搜索 + 分页）
 * Query: { keyword, status, page, pageSize }
 * 返回聚合字段：剩余课时、累计消费、购买次数、家长手机号、到期日期等
 */
router.get('/', (req, res) => {
  try {
    // 成员列表仅管理端工作人员（管理员/教练）可查看，家长端使用 /students/my
    if (!canViewStudents(req)) return res.status(403).json(safeFail('无成员查看权限'));
    const { keyword, status, project, sort, archived, startDate, endDate } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);

    let where = 'WHERE 1=1';
    let params = [];
    if (archived === '1') {
      where += ' AND s.archived = 1';
    } else {
      where += ' AND s.archived = 0';
    }
    // 流失阈值取自 settings.churn_rules（与 followups / growth 同源）。
    // getChurnRules 保证返回的是正整数（非法值一律回退默认 30），因此在下方
    // mem_status 的 SELECT 列表里可直接数值内插——该处若改用 ? 绑定，参数会
    // 排到 WHERE 之前，与 project/keyword 的入参顺序错位。此处不存在注入面。
    const { churnDays } = getChurnRules(db);
    if (status === 'active') {
      where += " AND EXISTS (SELECT 1 FROM member_cards mc WHERE mc.student_id = s.id AND mc.status = 'active' AND mc.expires_at > strftime('%s','now')*1000)";
    } else if (status === 'paused') {
      where += " AND EXISTS (SELECT 1 FROM member_cards mc WHERE mc.student_id = s.id AND mc.status = 'paused')";
    } else if (status === 'refunded') {
      where += " AND EXISTS (SELECT 1 FROM member_cards mc WHERE mc.student_id = s.id AND mc.status = 'refunded')";
    } else if (status === 'graduated') {
      // 已结束：持有过会员卡但当前无进行中/暂停/退费卡，且近期仍有出勤（区别于流失）
      // 「近期」窗口 = churn_rules.churnDays，与下方 churn 分支共用同一阈值，
      // 否则同一学员可能同时满足/都不满足 graduated 与 churn 两个互补判定。
      where += ` AND EXISTS (SELECT 1 FROM member_cards mc WHERE mc.student_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM member_cards mc2 WHERE mc2.student_id = s.id
          AND (mc2.status = 'active' AND mc2.expires_at > strftime('%s','now')*1000
            OR mc2.status IN ('paused','refunded')))
        AND EXISTS (SELECT 1 FROM attendances a WHERE a.student_id = s.id AND a.date >= date('now', 'localtime', ? || ' days'))`;
      params.push(`-${churnDays}`);
    } else if (status === 'churn') {
      where += ` AND EXISTS (SELECT 1 FROM member_cards mc WHERE mc.student_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM member_cards mc2 WHERE mc2.student_id = s.id
          AND mc2.status = 'active' AND mc2.expires_at > strftime('%s','now')*1000)
        AND NOT EXISTS (SELECT 1 FROM attendances a WHERE a.student_id = s.id AND a.date >= date('now', 'localtime', ? || ' days'))`;
      // 必须与上面的 ? 同序入参：两个分支互斥执行，各只推 1 个参数，
      // 且都排在 project / keyword / 日期区间参数之前
      params.push(`-${churnDays}`);
    }
    if (project) {
      where += ` AND EXISTS (
        SELECT 1 FROM member_cards mc2
        WHERE mc2.student_id = s.id AND mc2.status = 'active' AND mc2.card_type_name = ?
      )`;
      params.push(project);
    }
    if (keyword) {
      where += ` AND (s.name LIKE ? ESCAPE '\\' OR s.school LIKE ? ESCAPE '\\' OR s.grade LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM parent_bindings pb2 WHERE pb2.student_id = s.id AND pb2.parent_phone LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM parent_bindings pb3 WHERE pb3.student_id = s.id AND pb3.parent_name LIKE ? ESCAPE '\\'))`;
      const kw = `%${escapeLike(keyword)}%`;
      params.push(kw, kw, kw, kw, kw);
    }
    if (startDate) { where += ' AND s.join_date >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND s.join_date <= ?'; params.push(endDate); }

    const total = db.prepare(`SELECT COUNT(*) as count FROM students s ${where}`).get(...params).count;
    // 排序：默认按创建时间倒序；sort=expiring 时按有效会员卡到期时间升序（最早到期在前）
    const orderBy = sort === 'expiring'
      ? `ORDER BY
          CASE WHEN (SELECT MIN(mc4.expires_at) FROM member_cards mc4
            WHERE mc4.student_id = s.id AND mc4.status = 'active') IS NULL THEN 1 ELSE 0 END ASC,
          (SELECT MIN(mc4.expires_at) FROM member_cards mc4
            WHERE mc4.student_id = s.id AND mc4.status = 'active') ASC,
          s.created_at DESC`
      : 'ORDER BY s.created_at DESC';
    const list = db.prepare(`
      SELECT s.id, s.member_no, s.archived, s.name, s.gender, s.birthday, s.school, s.grade, s.hobby, s.level, s.remark,
        s.status, s.join_date, s.created_at, s.updated_at,
        CASE
          WHEN s.birthday IS NOT NULL AND s.birthday != ''
          THEN CAST((julianday('now') - julianday(s.birthday)) / 365.25 AS INTEGER)
          ELSE NULL
        END AS age,
        (SELECT COALESCE(SUM(mc.remaining_classes), 0) FROM member_cards mc
          WHERE mc.student_id = s.id AND mc.status = 'active' AND mc.billing_mode = 'count'
            AND mc.expires_at > strftime('%s','now')*1000) AS remaining_classes,
        (SELECT COUNT(*) FROM member_cards mc
          WHERE mc.student_id = s.id AND mc.status = 'active' AND mc.billing_mode = 'time'
            AND mc.expires_at > strftime('%s','now')*1000) AS time_card_count,
        (CASE
          WHEN EXISTS (SELECT 1 FROM member_cards mc WHERE mc.student_id = s.id AND mc.status = 'active' AND mc.expires_at > strftime('%s','now')*1000) THEN 'active'
          WHEN EXISTS (SELECT 1 FROM member_cards mc WHERE mc.student_id = s.id AND mc.status = 'paused') THEN 'paused'
          WHEN EXISTS (SELECT 1 FROM member_cards mc WHERE mc.student_id = s.id AND mc.status = 'refunded') THEN 'refunded'
          WHEN EXISTS (SELECT 1 FROM member_cards mc WHERE mc.student_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM attendances a WHERE a.student_id = s.id AND a.date >= date('now', 'localtime', '-${churnDays} days')) THEN 'churn'
          WHEN EXISTS (SELECT 1 FROM member_cards mc WHERE mc.student_id = s.id) THEN 'graduated'
          ELSE 'none'
        END) AS mem_status,
        (SELECT MAX(mc.expires_at) FROM member_cards mc
          WHERE mc.student_id = s.id AND mc.status = 'active') AS expires_at,
        (SELECT mc.activated_at FROM member_cards mc
          WHERE mc.student_id = s.id AND mc.status = 'active' ORDER BY mc.expires_at DESC LIMIT 1) AS card_start_date,
        (SELECT mc.card_type_name FROM member_cards mc
          WHERE mc.student_id = s.id AND mc.status = 'active' ORDER BY mc.expires_at DESC LIMIT 1) AS card_type_name,
        (SELECT COALESCE(SUM(o.payable_amount), 0) FROM orders o
          WHERE o.student_id = s.id AND o.status = 'paid') AS total_spent,
        (SELECT COUNT(*) FROM orders o
          WHERE o.student_id = s.id AND o.status = 'paid') AS purchase_count,
        (SELECT MAX(o.paid_at) FROM orders o
          WHERE o.student_id = s.id AND o.status = 'paid') AS latest_purchase_date,
        (SELECT e.course_name FROM enrollments e
          WHERE e.student_id = s.id AND e.status = 'active' ORDER BY e.created_at DESC LIMIT 1) AS project,
        (SELECT pb.parent_phone FROM parent_bindings pb
          WHERE pb.student_id = s.id ORDER BY pb.is_main DESC, pb.id ASC LIMIT 1) AS parent_phone,
        (SELECT pb.parent_name FROM parent_bindings pb
          WHERE pb.student_id = s.id ORDER BY pb.is_main DESC, pb.id ASC LIMIT 1) AS parent_name,
        (SELECT MAX(a.checkin_time) FROM attendances a
          WHERE a.student_id = s.id) AS last_activity_at
      FROM students s ${where}
      ${orderBy} LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    // 状态展示：已删除（status='refunded'）优先 —— 它只由 DELETE 写入，是学员自身的记录；
    // 其次是归档；最后才用会员卡派生状态（暂停/已结束/已退费/流失），避免列表恒显「正常」。
    // 注意不能写成 `r.mem_status || r.status`：mem_status 的 CASE 带 ELSE 'none'，恒为真值，
    // 会把学员自身的 status（含已删除）永远吞掉 —— 已删学员因此显示成「在读」。
    const mapped = list.map((r) => ({
      ...r,
      status: r.status === 'refunded' ? 'refunded' : (r.archived ? 'archived' : (r.mem_status || r.status)),
    }));
    res.json(success({ list: mapped, total, page, pageSize }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/students/options — 成员轻量选项（用于上课记录等筛选下拉）
 * 仅返回 id 与姓名，支持 q 按姓名模糊搜索，默认不含归档成员。
 * 必须放在 /:id 之前，否则会被 /:id 捕获。
 */
router.get('/options', (req, res) => {
  try {
    if (!canViewStudents(req)) return res.status(403).json(safeFail('无成员查看权限'));
    const { q, includeArchived } = req.query;
    // 默认排除已归档与已删除学员：只认 archived 会漏掉「删除时未置 archived」的历史数据，
    // 而学员下拉用于上课记录等人肉选择场景，混进已删学员会被误选、写脏考勤。
    let where = `WHERE ${ACTIVE_STUDENT_SQL}`;
    const params = [];
    if (includeArchived === '1') where = 'WHERE 1=1';
    if (q) {
      where += ' AND s.name LIKE ?';
      params.push(`%${q}%`);
    }
    const list = db.prepare(`
      SELECT s.id, s.name, s.member_no
      FROM students s ${where}
      ORDER BY s.created_at DESC LIMIT 50
    `).all(...params);
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取成员选项失败'));
  }
});

/**
 * GET /api/students/my — 当前家长绑定的成员
 */
router.get('/my', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));

    const students = db.prepare(`
      SELECT s.*, pb.relation, pb.is_main
      FROM students s
      JOIN parent_bindings pb ON pb.student_id = s.id
      WHERE pb.parent_openid = ? AND s.status = 'active'
    `).all(openid);

    res.json(success(students));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/students/home/data — 首页数据
 * 返回当前成员信息、会员卡（含有效期）、今日活动
 * 注意：必须放在 /:id 之前，否则会被 /:id 捕获
 */
router.get('/home/data', (req, res) => {
  try {
    const openid = getOpenId(req);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const tomorrowDate = new Date(now.getTime() + 86400000);
    const tomorrow = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth()+1).padStart(2,'0')}-${String(tomorrowDate.getDate()).padStart(2,'0')}`;

    let student = null;
    if (openid) {
      // 支持指定孩子取数（多孩家庭）；未指定时取主绑定孩子（兼容旧行为）
      const { studentId } = req.query || {};
      const bind = studentId
        ? db.prepare('SELECT student_id FROM parent_bindings WHERE parent_openid = ? AND student_id = ?').get(openid, studentId)
        : db.prepare('SELECT student_id FROM parent_bindings WHERE parent_openid = ? AND student_id IS NOT NULL ORDER BY is_main DESC, id ASC LIMIT 1').get(openid);
      if (bind) {
        student = db.prepare('SELECT id, name, gender, birthday, school, grade, avatar FROM students WHERE id = ?').get(bind.student_id);
      }
    }
    // 未登录时不返回随机学生数据
    if (!student && !openid) {
      return res.json(success({
        student: null,
        membership: null,
        todayClass: null,
        notices: [],
      }));
    }

    let membership = null;
    if (student) {
      membership = db.prepare('SELECT * FROM member_cards WHERE student_id = ? AND status = ? ORDER BY expires_at ASC LIMIT 1').get(student.id, 'active');
    }

    // 家长端不得看到同场次**其他孩子**的姓名：未成年人名单属于敏感信息，
    // 家长只需要知道自己孩子报没报名。完整报名名单仅工作人员可见（管理端活动卡要用）。
    // 原先这里无条件把该场次全部报名学员的姓名拼成串返回，家长拿自己孩子的 token
    // 就能批量拉取全机构在训孩子的姓名。
    const isStaff = isStaffReq(req);

    // 家长可见班级集合（新旧两类模型取并集：student_class / class_members）。
    // 与 schedules.js 的 parentVisibleClassIds + applyClassVisibility 同一判定规则：
    // 两类班级字段均为空的排期属「全员可见」，家长也可见。
    let parentClassIds = [];
    if (!isStaff && openid) {
      const boundIds = db.prepare('SELECT DISTINCT student_id FROM parent_bindings WHERE parent_openid = ?')
        .all(openid).map((r) => r.student_id).filter(Boolean);
      if (boundIds.length) {
        const ph = boundIds.map(() => '?').join(',');
        parentClassIds = [
          ...db.prepare(`SELECT DISTINCT class_id FROM student_class WHERE student_id IN (${ph})`).all(...boundIds).map((r) => r.class_id),
          ...db.prepare(`SELECT DISTINCT class_id FROM class_members WHERE student_id IN (${ph})`).all(...boundIds).map((r) => r.class_id),
        ];
      }
    }

    // 某一天的训练活动（今天 / 明天共用同一构建逻辑）
    const buildClassList = (dateStr) => {
      const list = [];
      // 家长首页此前无差别拉取全机构当日排期并按班分组，家长因此能看到其他班级、
      // 其他孩子的活动安排。现按「家长可见班级」限定；员工分支不受影响，仍看全量。
      let where = 'WHERE date = ? AND status = ?';
      const params = [dateStr, 'scheduled'];
      if (!isStaff) {
        where += " AND ((COALESCE(group_course_id,'') = '' AND COALESCE(class_id,'') = '')";
        if (parentClassIds.length) {
          const ph = parentClassIds.map(() => '?').join(',');
          where += ` OR (COALESCE(group_course_id,'') != '' AND group_course_id IN (${ph}))`;
          where += ` OR (COALESCE(class_id,'') != '' AND class_id IN (${ph}))`;
          params.push(...parentClassIds, ...parentClassIds);
        }
        where += ')';
      }
      const schedules = db.prepare(`SELECT * FROM schedules ${where} ORDER BY start_time ASC`).all(...params);
      for (const s of schedules) {
        // 该活动报名状态（当前孩子是否已报名 + 报名孩子名单，供活动卡展示）
        const enr = db.prepare(`
          SELECT student_id, student_name FROM enrollments
          WHERE schedule_id = ? AND status = 'active'
        `).all(s.id);
        // 已签到人数（供管理端今日活动卡统计）
        const checkedIn = db.prepare(`
          SELECT COUNT(*) as count FROM attendances
          WHERE schedule_id = ? AND status IN ('present','late')
        `).get(s.id).count;
        list.push({
          id: s.id,
          title: s.course_name,
          date: dateStr,
          startTime: s.start_time,
          endTime: s.end_time,
          location: s.classroom_name,
          coach: s.teacher_name,
          status: s.status,
          group_name: s.group_name || '',
          group_course_id: s.group_course_id || '',
          maxStudents: s.max_students || 0,
          isEnrolled: student ? enr.some((e) => e.student_id === student.id) : false,
          enrolledNames: isStaff
            ? enr.map((e) => e.student_name).filter(Boolean).join('、')
            // 家长：只回自己孩子的姓名（且仅限孩子确实报了这场），否则为空
            : (student && enr.some((e) => e.student_id === student.id) ? student.name : ''),
          enrolledCount: s.enrolled_count || enr.length,
          checkedInCount: checkedIn,
        });
      }
      return list;
    };
    const todayClasses = buildClassList(today);
    const tomorrowClasses = buildClassList(tomorrow);
    const todayClass = todayClasses.length > 0 ? todayClasses[0] : null;

    res.json(success({
      // 无绑定成员时返回 null，由前端展示"绑定学员"引导空状态
      student: student ? { name: student.name, avatar: student.avatar || '' } : null,
      membership: membership ? {
        cardTypeName: membership.card_type_name,
        billingMode: membership.billing_mode || 'time',
        totalClasses: membership.total_classes,
        remainingClasses: membership.remaining_classes,
        expiresAt: membership.expires_at,
        daysLeft: Math.max(0, Math.ceil((membership.expires_at - Date.now()) / 86400000)),
        status: membership.status,
      } : null,
      todayClass,
      todayClasses,
      tomorrowClasses,
      todayClassCount: todayClasses.length,
    }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/students/:id — 成员详情（含绑定家长、会员卡、积分）
 */
router.get('/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    // 只返回必要字段，不暴露敏感信息
    const student = db.prepare('SELECT id, member_no, archived, name, gender, birthday, school, grade, level, height, weight, bmi, avatar, status, join_date, remark FROM students WHERE id = ?').get(id);
    if (!student) return res.status(404).json(safeFail('成员不存在'));

    // 验证当前用户是否绑定了该成员（家长）或为管理端工作人员（管理员/教练）
    const bind = db.prepare('SELECT 1 FROM parent_bindings WHERE student_id = ? AND parent_openid = ?').get(id, req.openid);
    if (!bind && !canViewStudents(req)) return res.status(403).json(safeFail('无权访问该成员信息'));

    // 绑定家长
    const parents = db.prepare('SELECT parent_name, parent_phone, relation, is_main FROM parent_bindings WHERE student_id = ?').all(id);
    // 会员卡（仅返回基本信息）
    const cards = db.prepare(`
      SELECT id, order_id, card_type_name, total_classes, remaining_classes, expires_at, status,
        paused_at, pause_total_ms, pause_reason
      FROM member_cards WHERE student_id = ? ORDER BY created_at DESC
    `).all(id);
    // 积分（仅返回余额）
    const points = db.prepare('SELECT balance FROM points WHERE student_id = ?').get(id);
    // 登记
    const enrollments = db.prepare('SELECT id, course_name, status, created_at FROM enrollments WHERE student_id = ? ORDER BY created_at DESC LIMIT 10').all(id);
    // 消费记录
    const orders = db.prepare('SELECT id, order_no, order_type, payable_amount, status, paid_at FROM orders WHERE student_id = ? ORDER BY created_at DESC LIMIT 10').all(id);

    res.json(success({ ...student, parents, cards, points, enrollments, orders }));
  } catch (err) {
    console.error('[getStudent]', err);
    res.status(500).json(safeFail('获取成员信息失败'));
  }
});

/**
 * GET /api/students/:id/timeline — 成员时间线（聚合报名/购卡/签到/请假/积分/反馈）
 * 借鉴 trycompai/crm 的 Activity feed：按时间倒序展示该成员的全部互动记录
 */
router.get('/:id/timeline', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const student = db.prepare('SELECT id, name FROM students WHERE id = ?').get(id);
    if (!student) return res.status(404).json(safeFail('成员不存在'));
    const bind = db.prepare('SELECT 1 FROM parent_bindings WHERE student_id = ? AND parent_openid = ?').get(id, req.openid);
    if (!bind && !canViewStudents(req)) return res.status(403).json(safeFail('无权访问该成员信息'));

    const events = [];
    const push = (type, title, detail, eventAt, meta) => {
      events.push({ type, title, detail: detail || '', eventAt: eventAt || now(), meta: meta || {} });
    };

    // 报名活动
    const sources = [
      () => db.prepare('SELECT course_name, status, created_at FROM enrollments WHERE student_id = ?').all(id)
        .map((r) => ({ type: 'enroll', title: `报名活动「${r.course_name || ''}」`, detail: `状态：${r.status === 'active' ? '已报名' : r.status}`, eventAt: r.created_at })),
      () => db.prepare('SELECT order_no, items, payable_amount, status, paid_at, created_at FROM orders WHERE student_id = ? ORDER BY created_at DESC LIMIT 100').all(id)
        .map((r) => {
          let itemText = '';
          try {
            const items = parseItems(r.items);
            itemText = items.map((i) => i.itemName || '').filter(Boolean).join('、');
          } catch (e) { /* 忽略 */ }
          return { type: 'order', title: `购买「${itemText || '产品'}」`, detail: `金额 ¥${Number(r.payable_amount || 0).toLocaleString()}，状态：${r.status === 'paid' ? '已支付' : r.status}`, eventAt: r.paid_at || r.created_at, meta: { orderNo: r.order_no } };
        }),
      () => db.prepare('SELECT date, status FROM attendances WHERE student_id = ? ORDER BY date DESC LIMIT 200').all(id)
        .map((r) => {
          const text = { present: '已签到', late: '迟到', absent: '缺勤', leave: '请假' }[r.status] || r.status;
          const ts = Date.parse(r.date) || now();
          return { type: 'attendance', title: `${r.date} ${text}`, detail: '课程出勤记录', eventAt: ts };
        }),
      () => db.prepare('SELECT date, start_time, reason, status, created_at FROM leave_requests WHERE student_id = ?').all(id)
        .map((r) => ({ type: 'leave', title: `${r.date || ''} 请假`, detail: r.reason || '', eventAt: r.created_at })),
      () => db.prepare('SELECT type, amount, reason, created_at FROM point_logs WHERE student_id = ? ORDER BY created_at DESC LIMIT 100').all(id)
        .map((r) => {
          // amount 的符号在历史数据里并不统一：earn/consume/refund 存的是正值，
          // 而签到回滚（checkin.js）存的是负值。原写法按 type 二次拼符号，
          // 于是回滚那条会显示成「积分获得 +-10」，退卡回收（refund）也会显示成
          // 「积分获得 +100」——明明是扣分却写成获得，家长看到会对不上账。
          // 统一改为：以绝对值为准，符号由「这笔到底是加还是减」决定。
          const amt = Number(r.amount) || 0;
          const isDeduct = amt < 0 || r.type === 'consume' || r.type === 'refund';
          const label = r.type === 'refund' ? '回收' : (isDeduct ? '扣减' : '获得');
          return {
            type: 'points',
            title: `积分${label} ${isDeduct ? '-' : '+'}${Math.abs(amt)}`,
            detail: r.reason || '',
            eventAt: r.created_at,
          };
        }),
      () => db.prepare('SELECT content, status, created_at FROM feedback WHERE student_id = ?').all(id)
        .map((r) => ({ type: 'feedback', title: '提交意见反馈', detail: r.content || '', eventAt: r.created_at })),
    ];
    for (const src of sources) {
      try {
        for (const e of src()) push(e.type, e.title, e.detail, e.eventAt, e.meta);
      } catch (e) {
        // 单类数据异常不阻塞时间线，但**必须留下日志**：此前这里是空 catch，
        // feedback 表缺 student_id 列导致查询每次都抛错却被完全吞掉，
        // 学员详情页的「反馈」区块永远为空且永远不报错，属于"看起来有、实际没有"。
        console.warn('[student timeline] 某类时间线数据读取失败，已跳过:', e && e.message);
      }
    }

    events.sort((a, b) => b.eventAt - a.eventAt);
    res.json(success({ student: { id: student.id, name: student.name }, list: events.slice(0, 100), total: events.length }));
  } catch (err) {
    console.error('[student timeline]', err);
    res.status(500).json(safeFail('获取成员时间线失败'));
  }
});

/**
 * PUT /api/students/:id — 更新成员
 */
router.put('/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { name, gender, birthday, school, grade, hobby, remark, level, height, weight, bmi, status, parentPhone, parentName, memberNo, archived } = req.body;

    const existing = db.prepare('SELECT id, name, status FROM students WHERE id = ?').get(id);
    if (!existing) return res.status(404).json(safeFail('成员不存在'));

    // 验证绑定关系
    const bind = db.prepare('SELECT 1 FROM parent_bindings WHERE student_id = ? AND parent_openid = ?').get(id, req.openid);
    const isAdmin = isAdminReq(req);
    if (!bind && !isAdmin) return res.status(403).json(safeFail('无权修改该成员'));

    // 家长（非管理员）仅可修改成员基础信息字段，禁止修改 status / archived / member_no 等管理字段
    if (bind && !isAdmin) {
      db.prepare(`
        UPDATE students SET
          name = COALESCE(?, name),
          gender = COALESCE(?, gender),
          birthday = COALESCE(?, birthday),
          school = COALESCE(?, school),
          grade = COALESCE(?, grade),
          hobby = COALESCE(?, hobby),
          level = COALESCE(?, level),
          remark = COALESCE(?, remark),
          updated_at = ?
        WHERE id = ?
      `).run(name, gender, birthday, school, grade, hobby, level, remark, now(), id);
      // 家长自助修改成员基础信息，同样需要留痕
      const actor = getActor(req);
      recordAudit(db, {
        entity: 'student',
        entityId: id,
        action: 'update',
        actorId: actor.id,
        actorRole: actor.role,
        before: { name: existing.name },
        after: { name: name || existing.name },
      });
      return res.json(success({ id }));
    }

    // 管理员：可修改全部字段（含 status / archived / member_no）
    db.prepare(`
      UPDATE students SET
        member_no = COALESCE(?, member_no),
        archived = COALESCE(?, archived),
        name = COALESCE(?, name),
        gender = COALESCE(?, gender),
        birthday = COALESCE(?, birthday),
        school = COALESCE(?, school),
        grade = COALESCE(?, grade),
        hobby = COALESCE(?, hobby),
        level = COALESCE(?, level),
        height = COALESCE(?, height),
        weight = COALESCE(?, weight),
        bmi = COALESCE(?, bmi),
        remark = COALESCE(?, remark),
        status = ?,
        updated_at = ?
      WHERE id = ?
    `).run(memberNo || null, archived !== undefined ? (archived ? 1 : 0) : null, name, gender, birthday, school, grade, hobby, level,
      height !== undefined && height !== '' ? Number(height) : null,
      weight !== undefined && weight !== '' ? Number(weight) : null,
      bmi !== undefined && bmi !== '' ? Number(bmi) : null,
      remark, status || existing.status, now(), id);

    // 管理员可更新家长手机号/姓名绑定
    if (isAdmin && parentPhone) {
      const openid = `phone_${parentPhone}`;
      const existingParent = db.prepare('SELECT id, parent_phone FROM parent_bindings WHERE student_id = ? ORDER BY is_main DESC, id ASC LIMIT 1').get(id);
      const oldPhone = existingParent ? String(existingParent.parent_phone || '') : '';
      const parentNameVal = parentName || '家长';
      // 确定目标手机号的用户账号（保留微信身份 openid）
      let targetUser = db.prepare('SELECT id, openid FROM users WHERE phone = ?').get(parentPhone);
      if (!targetUser && oldPhone && oldPhone !== parentPhone) {
        const legacyUser = db.prepare('SELECT id, openid FROM users WHERE phone = ?').get(oldPhone);
        if (legacyUser) {
          // 将原家长账号迁移到新手机号，避免新手机号登录产生孤立账号
          db.prepare('UPDATE users SET phone = ?, updated_at = ? WHERE id = ?')
            .run(parentPhone, now(), legacyUser.id);
          if (!String(legacyUser.openid || '').startsWith('wx_')) {
            db.prepare('UPDATE users SET openid = ? WHERE id = ?').run(openid, legacyUser.id);
          }
          targetUser = { id: legacyUser.id, openid: legacyUser.openid };
        }
      }
      if (!targetUser) {
        db.prepare(`
          INSERT INTO users (id, openid, phone, nickname, avatar, role, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '', 'parent', 'active', ?, ?)
        `).run(generateId('user_'), openid, parentPhone, parentNameVal, now(), now());
        targetUser = { id: '', openid };
      } else if (!String(targetUser.openid || '').startsWith('wx_')) {
        db.prepare('UPDATE users SET openid = ? WHERE id = ?').run(openid, targetUser.id);
        targetUser.openid = openid;
      }
      // 绑定记录使用用户实际 openid（微信身份为 wx_ 前缀），保证登录后可见绑定
      const bindOpenid = String(targetUser.openid || '');
      if (existingParent) {
        db.prepare('UPDATE parent_bindings SET parent_name = ?, parent_phone = ?, parent_openid = ? WHERE id = ?')
          .run(parentNameVal, parentPhone, bindOpenid, existingParent.id);
      } else {
        // 去重：按手机号查找已有绑定，避免重复
        const dupBind = db.prepare('SELECT id FROM parent_bindings WHERE student_id = ? AND parent_phone = ?').get(id, parentPhone);
        if (dupBind) {
          db.prepare('UPDATE parent_bindings SET parent_name = ?, parent_openid = ? WHERE id = ?')
            .run(parentNameVal, bindOpenid, dupBind.id);
        } else {
          db.prepare(`
            INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at)
            VALUES (?, ?, ?, ?, ?, '家长', 1, ?)
          `).run(id, name || existing.name, parentNameVal, bindOpenid, parentPhone, now());
        }
      }
    }

    // 管理员修改成员（含状态/归档/家长绑定迁移），需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'student',
      entityId: id,
      action: 'update',
      actorId: actor.id,
      actorRole: actor.role,
      before: { name: existing.name, status: existing.status },
      after: {
        name: name || existing.name,
        status: status || existing.status,
        archived: archived === undefined ? null : (archived ? 1 : 0),
        parent_phone_changed: !!(isAdmin && parentPhone),
      },
    });

    res.json(success({ id }));
  } catch (err) {
    console.error('[updateStudent]', err);
    res.status(500).json(safeFail('更新失败'));
  }
});

/**
 * DELETE /api/students/:id — 删除成员（软删除：状态置为已退费）
 */
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT id FROM students WHERE id = ?').get(id);
    if (!existing) return res.status(404).json(safeFail('成员不存在'));
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可删除成员'));

    // 归档（软删除）并解绑家长绑定：避免家长端仍可见已退费成员，与课程删除级联一致
    const tx = db.transaction(() => {
      // archived 必须一并置 1：学员列表默认只显示 archived = 0，只改 status 的话
      // 已删学员仍留在列表里（且因会员卡仍有效而被派生状态覆盖成「在读」），删除等于没删。
      db.prepare("UPDATE students SET status = 'refunded', archived = 1, updated_at = ? WHERE id = ?").run(now(), id);
      db.prepare('DELETE FROM parent_bindings WHERE student_id = ?').run(id);
    });
    tx();
    // 软删除（退费归档）并解绑家长，需留痕
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'student',
      entityId: id,
      action: 'delete',
      actorId: actor.id,
      actorRole: actor.role,
      after: { status: 'refunded', parents_unbound: true },
    });
    res.json(success({ id, status: 'refunded' }));
  } catch (err) {
    console.error('[deleteStudent]', err);
    res.status(500).json(safeFail('删除失败'));
  }
});

/**
 * GET /api/students/:id/stats — 成员训练统计（累计训练、到场率）
 */
router.get('/:id/stats', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const bind = db.prepare('SELECT 1 FROM parent_bindings WHERE student_id = ? AND parent_openid = ?').get(id, req.openid);
    if (!bind && !canViewStudents(req)) return res.status(403).json(safeFail('无权访问该成员信息'));

    // 按状态分组计数，交 utils.attendanceRate 统一算率（全站唯一口径）。
    // 原实现用 COUNT(*) 当分母，把 leave（已批准请假）也算成「应到未到」，
    // 于是同一学员在档案页的到场率比看板低一截。请假不进分母。
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present,
        SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late,
        SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent
      FROM attendances WHERE student_id = ?
    `).get(id) || {};
    const presentCount = counts.present || 0;
    const lateCount = counts.late || 0;
    const absentCount = counts.absent || 0;
    // 应到次数 = 实到 + 缺勤（与 attendances.js 汇总一致），保证 实到/应到 与 到场率 同源
    const totalSessions = presentCount + lateCount + absentCount;
    const attendedSessions = presentCount + lateCount;
    const attendanceRate = calcAttendanceRate({ present: presentCount, late: lateCount, absent: absentCount });

    res.json(success({ totalSessions, attendedSessions, attendanceRate }));
  } catch (err) {
    console.error('[studentStats]', err);
    res.status(500).json(safeFail('获取训练统计失败'));
  }
});

/**
 * GET /api/students/:id/activities — 成员历史活动记录（按时间倒序）
 */
router.get('/:id/activities', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const bind = db.prepare('SELECT 1 FROM parent_bindings WHERE student_id = ? AND parent_openid = ?').get(id, req.openid);
    if (!bind && !canViewStudents(req)) return res.status(403).json(safeFail('无权访问该成员信息'));

    const list = db.prepare(`
      SELECT a.id, a.schedule_id, a.status, a.date, a.checkin_time, s.start_time, s.course_name
      FROM attendances a
      LEFT JOIN schedules s ON s.id = a.schedule_id
      WHERE a.student_id = ?
      ORDER BY COALESCE(a.date, datetime(a.checkin_time/1000, 'unixepoch', 'localtime')) DESC
    `).all(id);
    // 原带 LIMIT 50：单个学员的历史出勤攒过 50 条后，家长/教务翻不到更早的记录，
    // 且接口不返回总数，调用方无从知道被截断了。这里保持返回数组（前端按数组消费，
    // 改成对象会破坏调用方），改为全量返回 —— 单个学员的历史记录规模有限。

    res.json(success(list));
  } catch (err) {
    console.error('[studentActivities]', err);
    res.status(500).json(safeFail('获取活动记录失败'));
  }
});

/**
 * POST /api/students/:id/qrcode — 生成签到二维码内容
 * 返回一个可被扫码识别的唯一字符串
 */
router.post('/:id/qrcode', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const student = db.prepare('SELECT id FROM students WHERE id = ?').get(id);
    if (!student) return res.status(404).json(safeFail('成员不存在'));

    // 管理员/教练可在前台代生成签到码；家长须为绑定关系
    if (!isCoachReq(req)) {
      const bind = db.prepare('SELECT 1 FROM parent_bindings WHERE student_id = ? AND parent_openid = ?').get(id, req.openid);
      if (!bind) return res.status(403).json(safeFail('无权操作该成员'));
    }

    // 生成签到二维码内容：随机 nonce + 60s 时效，避免离线伪造与重放
    // QR_SECRET 复用服务端 JWT 密钥（未配置时已自动随机生成，不再是硬编码公开值）
    const nonce = crypto.randomBytes(12).toString('hex');
    const exp = Date.now() + 60 * 1000;
    const qrHash = crypto.createHash('sha256').update(`${id}:${nonce}:${exp}:${QR_SECRET}`).digest('hex').slice(0, 16);
    const qrContent = `CHECKIN:${id}:${nonce}:${exp}:${qrHash}`;
    db.prepare('UPDATE students SET qr_code = ?, qr_exp = ?, updated_at = ? WHERE id = ?').run(qrContent, exp, now(), id);

    // 生成签到码即签发一次性签到凭证（60s 有效），属凭证签发动作，需留痕；凭证内容本身不写入审计
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'student',
      entityId: id,
      action: 'generate_qr',
      actorId: actor.id,
      actorRole: actor.role,
    });

    res.json(success({
      studentId: student.id,
      qrCode: qrContent,
    }));
  } catch (err) {
    console.error('[qrcode]', err);
    res.status(500).json(safeFail('生成二维码失败'));
  }
});

module.exports = router;
