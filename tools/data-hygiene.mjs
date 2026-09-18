/**
 * 测试数据卫生检查
 * 防止自动化测试残留累积污染演示数据（排期/通知/课程）。
 * 超过阈值即失败，提示清理。
 *
 * ── 安全约束（重要）────────────────────────────────────────────
 * 本脚本会物理删除数据，因此：
 *   1) 默认 DRY-RUN：只检查、只报告，不写入任何数据。
 *   2) 需显式 `--apply` 才真正执行清理。
 *   3) `--apply` 执行前自动做一次数据库备份（backend/backups/pre-hygiene-*.db）。
 *   4) 生产环境（NODE_ENV=production）或未指定 DB_PATH 时，`--apply` 必须
 *      同时给出 `--allow-production`，避免在生产机上误跑。
 *
 * 注意：清理规则多为启发式模式匹配（如 `%测试%`、`status='cancelled'`），
 * 无法百分之百区分测试残留与真实业务数据。因此「先备份、后清理」不可省略。
 *
 * 用法：
 *   node tools/data-hygiene.mjs                              # 只检查（dry-run，默认）
 *   node tools/data-hygiene.mjs --apply                      # 开发库执行清理（自动备份）
 *   node tools/data-hygiene.mjs --apply --allow-production   # 生产环境执行清理
 *   DB_PATH=/tmp/copy.db node tools/data-hygiene.mjs --apply # 对副本清理（推荐）
 */
import { createRequire } from 'module'
import path from 'path'
import fs from 'fs'
const require = createRequire(import.meta.url)

const APPLY = process.argv.includes('--apply')
const ALLOW_PRODUCTION = process.argv.includes('--allow-production')
// 报告用动词：dry-run 下不得宣称「已清理」
const TAG = APPLY ? '已清理' : '待清理'
// 自愈/重算类报告的动词前缀（后接「清理 / 重算 / 校正」），同样不得在 dry-run 下谎报
const HEAL = APPLY ? '已' : '待'
const DB_FILE = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(process.cwd(), 'backend/db/data.db')

const realDb = require(process.cwd() + '/backend/db')

// ── 护栏 1：生产环境 / 默认库需显式放行 ──
// 判据与 P0-1（自助支付）保持一致：NODE_ENV=production 即视为生产环境。
// 容器部署同时设置了 NODE_ENV=production 与 DB_PATH=/data/data.db，
// 因此不能只用「DB_PATH 是否为空」来判断，否则容器内会绕过该护栏。
if (APPLY && !ALLOW_PRODUCTION && (process.env.NODE_ENV === 'production' || !process.env.DB_PATH)) {
  console.error(`[Hygiene] 已拒绝执行：目标为 ${DB_FILE}`)
  console.error(`[Hygiene] 原因：${process.env.NODE_ENV === 'production' ? 'NODE_ENV=production' : '未指定 DB_PATH（默认库通常承载真实业务数据）'}`)
  console.error('[Hygiene] 该库清理不可逆。请二选一：')
  console.error('[Hygiene]   a) 确认要清理：node tools/data-hygiene.mjs --apply --allow-production')
  console.error('[Hygiene]   b) 更推荐：先复制副本，再 DB_PATH=/tmp/copy.db node tools/data-hygiene.mjs --apply')
  process.exit(2)
}

// ── 护栏 2：写入前自动备份，误删可回滚 ──
if (APPLY) {
  try {
    const backupDir = path.join(process.cwd(), 'backend/backups')
    fs.mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(backupDir, `pre-hygiene-${stamp}.db`)
    await realDb.backup(target)
    console.log(`[Hygiene] 已备份：${path.relative(process.cwd(), target)}`)
  } catch (e) {
    console.error('[Hygiene] 备份失败，已中止清理：', e.message)
    process.exit(2)
  }
}

// ── 护栏 3：dry-run 拦截写操作（读操作照常，检查逻辑依赖真实数据）──
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|VACUUM)\b/i
const db = APPLY ? realDb : new Proxy(realDb, {
  get(target, prop) {
    if (prop === 'prepare') {
      return (sql, ...rest) => {
        const stmt = target.prepare(sql, ...rest)
        if (!WRITE_RE.test(sql)) return stmt
        return new Proxy(stmt, {
          get(s, p) {
            if (p === 'run') return () => ({ changes: 0 })
            const v = s[p]
            return typeof v === 'function' ? v.bind(s) : v
          },
        })
      }
    }
    const v = target[prop]
    return typeof v === 'function' ? v.bind(target) : v
  },
})

console.log(`[Hygiene] 模式：${APPLY ? 'APPLY（将写入数据库）' : 'DRY-RUN（只检查，加 --apply 执行清理）'}`)

let issues = 0

const sched = db.prepare(`
  SELECT COUNT(*) c FROM schedules
  WHERE course_name LIKE '%测试%' OR course_name LIKE '%剧本%' OR course_name LIKE '%扣课%'
     OR course_name LIKE '%多孩%' OR course_name LIKE 'E2E%' OR course_name LIKE '首页验证%'
     OR course_name LIKE '%审计%' OR course_name LIKE '重复测试-%' OR course_name LIKE '复查-%'
     OR course_name LIKE '家长签到测试%'
     OR remark LIKE 'AUDIT-%'
`).get().c
if (sched > 20) { console.log(`✗ 测试排期残留 ${sched} 条`); issues++ }
else console.log(`✓ 排期数据卫生（残留 ${sched} 条）`)

// 自动清理审计/端到端测试创建的临时排课及其关联数据（报名/签到/请假）
const auditScheds = db.prepare(`
  SELECT id FROM schedules
  WHERE remark LIKE 'AUDIT-%' OR course_name LIKE '%审计%'
     OR course_name LIKE '%剧本%' OR course_name LIKE '%测试班-%'
     OR course_name LIKE '%扣课%' OR course_name LIKE '%验证课%'
     OR course_name LIKE '重复测试-%' OR course_name LIKE '复查-%'
     OR course_name LIKE '家长签到测试%'
     OR course_name LIKE '%管理端深化测试课%' OR course_name LIKE '%管理端签到测试课%'
     OR course_name LIKE '%全面测试课程%' OR course_name LIKE '%冒烟测试班级%'
`).all()
if (auditScheds.length) {
  const ph = auditScheds.map(() => '?').join(',')
  const ids = auditScheds.map((s) => s.id)
  db.prepare(`DELETE FROM enrollments WHERE schedule_id IN (${ph})`).run(...ids)
  db.prepare(`DELETE FROM attendances WHERE schedule_id IN (${ph})`).run(...ids)
  db.prepare(`DELETE FROM leave_requests WHERE schedule_id IN (${ph})`).run(...ids)
  db.prepare(`DELETE FROM schedules WHERE id IN (${ph})`).run(...ids)
  console.log(`✓ 排期数据卫生（${TAG}审计测试排课 ${auditScheds.length} 条）`)
}

// 性别数据归一化：兼容历史英文值（male/female），统一为中文（男/女）存储
// 待修正条数用 SELECT 统计（而非 UPDATE 的 changes），使 dry-run 下报告同样准确
const genderPending =
  db.prepare(`SELECT count(*) c FROM students WHERE gender IN ('male','female')`).get().c +
  db.prepare(`SELECT count(*) c FROM teachers WHERE gender IN ('male','female')`).get().c
db.prepare(`UPDATE students SET gender='男' WHERE gender='male'`).run()
db.prepare(`UPDATE students SET gender='女' WHERE gender='female'`).run()
db.prepare(`UPDATE teachers SET gender='男' WHERE gender='male'`).run()
db.prepare(`UPDATE teachers SET gender='女' WHERE gender='female'`).run()
const genderRemain = db.prepare(`SELECT count(*) c FROM students WHERE gender NOT IN ('男','女')`).get().c +
  db.prepare(`SELECT count(*) c FROM teachers WHERE gender NOT IN ('男','女')`).get().c
if (genderRemain > 0) {
  // dry-run 下更新被拦截，异常值仍在，此时按「待清理」报告，不判为失败
  if (APPLY) { console.log(`✗ 性别字段存在异常值 ${genderRemain} 条`); issues++ }
  else console.log(`✓ 性别数据归一化（${TAG} ${genderPending} 条）`)
} else {
  console.log(`✓ 性别数据归一化（male/female → 男/女，${TAG} ${genderPending} 条）`)
}

// 学生数据卫生：清理自动化测试残留学员。DELETE /students/:id 是软删除（status='refunded'），
// 全面测试/签到测试等套件跑完后学员行仍留在库里，按 created_at DESC 会占据成员列表首位，污染演示数据。
// 连同其全部关联数据（卡/报名/考勤/积分/绑定/请假/扣课/订单/支付）一并物理删除。
const testStudents = db.prepare(`
  SELECT id FROM students
  WHERE name LIKE '全面测试学生_%' OR name LIKE '签到测试学生_%' OR name LIKE '测试学生_%'
     OR name IN ('测试学员', '请假测试学员')
`).all()
if (testStudents.length) {
  const ph = testStudents.map(() => '?').join(',')
  const sids = testStudents.map((s) => s.id)
  const tOrderIds = db.prepare(`SELECT id FROM orders WHERE student_id IN (${ph})`).all(...sids).map((o) => o.id)
  if (tOrderIds.length) {
    const oph = tOrderIds.map(() => '?').join(',')
    db.prepare(`DELETE FROM payments WHERE order_id IN (${oph})`).run(...tOrderIds)
    db.prepare(`DELETE FROM member_cards WHERE order_id IN (${oph})`).run(...tOrderIds)
  }
  for (const t of ['member_cards', 'enrollments', 'attendances', 'point_logs', 'parent_bindings',
    'leave_requests', 'orders', 'points', 'deduction_logs', 'leave_deduction_logs', 'coach_comments', 'student_class']) {
    try { db.prepare(`DELETE FROM ${t} WHERE student_id IN (${ph})`).run(...sids) } catch (e) { /* 表无该列时跳过 */ }
  }
  db.prepare(`DELETE FROM students WHERE id IN (${ph})`).run(...sids)
  console.log(`✓ 学生数据卫生（${TAG}测试学员 ${testStudents.length} 人）`)
} else {
  console.log('✓ 学生数据卫生（无测试学员残留）')
}

// 自动清理自动化测试创建的销售订单（测试签单人 / E2E / AUDIT 备注）及其关联数据，
// 防止测试订单污染演示销售数据与会员卡
const testOrders = db.prepare(`
  SELECT id FROM orders
  WHERE salesperson LIKE '测试%' OR salesperson = '导入测试' OR remark LIKE 'E2E-%' OR remark LIKE 'AUDIT-%' OR remark LIKE '%导入测试%'
`).all()
if (testOrders.length) {
  const oph = testOrders.map(() => '?').join(',')
  const oids = testOrders.map((o) => o.id)
  const refs = oids.map((id) => 'order_' + id)
  const rph = refs.map(() => '?').join(',')
  db.prepare(`DELETE FROM point_logs WHERE reference_id IN (${rph})`).run(...refs)
  db.prepare(`DELETE FROM member_cards WHERE order_id IN (${oph})`).run(...oids)
  db.prepare(`DELETE FROM payments WHERE order_id IN (${oph})`).run(...oids)
  db.prepare(`DELETE FROM orders WHERE id IN (${oph})`).run(...oids)
  console.log(`✓ 订单数据卫生（${TAG}测试销售订单 ${testOrders.length} 条）`)
} else {
  console.log('✓ 订单数据卫生（残留 0 条）')
}

const courses = db.prepare(`
  SELECT COUNT(*) c FROM courses
  WHERE name LIKE '%测试%' OR name LIKE 'E2E%' OR name LIKE '首页验证%'
`).get().c
if (courses > 20) { console.log(`✗ 测试课程残留 ${courses} 条`); issues++ }
else console.log(`✓ 课程数据卫生（残留 ${courses} 条）`)

// 自动清理自动化测试创建的临时课程（优化验证课等）及其关联数据，防止演示数据污染
const tempCourses = db.prepare(`
  SELECT id FROM courses WHERE name LIKE '优化验证课%' OR name LIKE '自动化测试课%' OR name LIKE '验证课%'
     OR name LIKE '%管理端深化测试课%' OR name LIKE '%管理端签到测试课%'
     OR name LIKE '全面测试课程%' OR name LIKE '冒烟测试班级%'
`).all()
if (tempCourses.length) {
  const ph = tempCourses.map(() => '?').join(',')
  const ids = tempCourses.map((c) => c.id)
  const scheds = db.prepare(`SELECT id FROM schedules WHERE course_id IN (${ph})`).all(...ids)
  if (scheds.length) {
    const sph = scheds.map(() => '?').join(',')
    const sids = scheds.map((s) => s.id)
    db.prepare(`DELETE FROM enrollments WHERE schedule_id IN (${sph})`).run(...sids)
    db.prepare(`DELETE FROM attendances WHERE schedule_id IN (${sph})`).run(...sids)
    db.prepare(`DELETE FROM schedules WHERE id IN (${sph})`).run(...sids)
  }
  db.prepare(`DELETE FROM courses WHERE id IN (${ph})`).run(...ids)
  console.log(`✓ 课程数据卫生（${TAG}临时课程 ${tempCourses.length} 条）`)
}

// 自动清理自动化测试创建的产品（测试时效卡/测试次卡/坏卡）
const tempCards = db.prepare(`
  SELECT id FROM membership_cards WHERE name LIKE '测试%' OR name LIKE '排序测试卡%' OR name = '坏卡' OR name LIKE 'AUDIT-%'
`).all()
if (tempCards.length) {
  const ph = tempCards.map(() => '?').join(',')
  const ids = tempCards.map((c) => c.id)
  db.prepare(`DELETE FROM member_cards WHERE card_type_id IN (${ph})`).run(...ids)
  db.prepare(`DELETE FROM membership_cards WHERE id IN (${ph})`).run(...ids)
  console.log(`✓ 产品数据卫生（${TAG}测试产品 ${tempCards.length} 条）`)
} else {
  console.log('✓ 产品数据卫生（残留 0 条）')
}

const notices = db.prepare(`
  SELECT COUNT(*) c FROM notifications
  WHERE title LIKE '%测试%' OR title LIKE 'E2E%' OR title LIKE '全检%'
`).get().c
if (notices > 0) {
  // 冒烟测试每次运行会产生「冒烟测试通知」，自动清理防止累积污染
  db.prepare(`DELETE FROM notifications WHERE title LIKE '%测试%' OR title LIKE 'E2E%' OR title LIKE '全检%'`).run()
  console.log(`✓ 通知数据卫生（${TAG} ${notices} 条测试通知）`)
} else {
  console.log(`✓ 通知数据卫生（残留 0 条）`)
}

// 清理内容引用测试排课的通知（剧本测试班/验证课/审计等自动化测试产生的活动取消/出勤/请假通知）
const testNoticeContent = db.prepare(`
  SELECT COUNT(*) c FROM notifications
  WHERE content LIKE '%剧本测试班%' OR content LIKE '%测试班-%'
     OR content LIKE '%验证课%' OR content LIKE '%审计%' OR content LIKE '%AUDIT%'
`).get().c
if (testNoticeContent > 0) {
  db.prepare(`
    DELETE FROM notifications
    WHERE content LIKE '%剧本测试班%' OR content LIKE '%测试班-%'
       OR content LIKE '%验证课%' OR content LIKE '%审计%' OR content LIKE '%AUDIT%'
  `).run()
  console.log(`✓ 通知数据卫生（${TAG}引用测试排课的通知 ${testNoticeContent} 条）`)
}

// 清理请假审批通知：对应请假记录已删除（自动化测试残留）时清理
const orphanLeaveNotices = db.prepare(`
  SELECT COUNT(*) c FROM notifications
  WHERE (title = '请假已批准' OR title = '请假未通过')
    AND template_id LIKE 'LEAVE_%'
    AND SUBSTR(template_id, 7) NOT IN (SELECT id FROM leave_requests)
`).get().c
if (orphanLeaveNotices > 0) {
  db.prepare(`
    DELETE FROM notifications
    WHERE (title = '请假已批准' OR title = '请假未通过')
      AND template_id LIKE 'LEAVE_%'
      AND SUBSTR(template_id, 7) NOT IN (SELECT id FROM leave_requests)
  `).run()
  console.log(`✓ 通知数据卫生（${TAG}请假审批测试通知 ${orphanLeaveNotices} 条）`)
}

// 自动清理积分流水中的测试标记（E2E / AUDIT / 测试），防止积分明细被测试数据淹没
const testLogs = db.prepare(`
  SELECT COUNT(*) c FROM point_logs
  WHERE reason LIKE 'E2E%' OR reason LIKE '%AUDIT%' OR reason LIKE '%测试%' OR reason LIKE 'AUDIT%'
`).get().c
if (testLogs > 0) {
  db.prepare(`
    DELETE FROM point_logs
    WHERE reason LIKE 'E2E%' OR reason LIKE '%AUDIT%' OR reason LIKE '%测试%' OR reason LIKE 'AUDIT%'
  `).run()
  console.log(`✓ 积分数据卫生（${TAG}测试流水 ${testLogs} 条）`)
} else {
  console.log('✓ 积分数据卫生（残留 0 条）')
}

// 积分关联自愈：清理引用已删除排期/订单的测试流水，并按真实流水重算账户余额
const orphanCheckinLogs = db.prepare(`
  SELECT COUNT(*) c FROM point_logs pl
  WHERE pl.type = 'checkin' AND pl.reference_id != ''
    AND pl.reference_id NOT IN (SELECT id FROM schedules)
`).get().c
if (orphanCheckinLogs > 0) {
  db.prepare(`
    DELETE FROM point_logs WHERE type = 'checkin' AND reference_id != ''
      AND reference_id NOT IN (SELECT id FROM schedules)
  `).run()
  console.log(`✓ 积分关联自愈（${HEAL}清理孤儿签到积分 ${orphanCheckinLogs} 条）`)
}
const orphanEarnLogs = db.prepare(`
  SELECT COUNT(*) c FROM point_logs
  WHERE type = 'earn' AND (reason IN ('转介绍奖励','线索成交奖励','批量积分奖励'))
    AND (reference_id IS NULL OR reference_id = '')
`).get().c
if (orphanEarnLogs > 0) {
  db.prepare(`
    DELETE FROM point_logs
    WHERE type = 'earn' AND (reason IN ('转介绍奖励','线索成交奖励','批量积分奖励'))
      AND (reference_id IS NULL OR reference_id = '')
  `).run()
  console.log(`✓ 积分关联自愈（${HEAL}清理无来源测试奖励积分 ${orphanEarnLogs} 条）`)
}
const orphanPurchaseLogs = db.prepare(`
  SELECT COUNT(*) c FROM point_logs
  WHERE reason LIKE '购买「%」赠送积分' AND reference_id LIKE 'order_%'
    AND reference_id NOT IN (SELECT 'order_' || id FROM orders)
`).get().c
if (orphanPurchaseLogs > 0) {
  db.prepare(`
    DELETE FROM point_logs
    WHERE reason LIKE '购买「%」赠送积分' AND reference_id LIKE 'order_%'
      AND reference_id NOT IN (SELECT 'order_' || id FROM orders)
  `).run()
  console.log(`✓ 积分关联自愈（${HEAL}清理孤儿订单赠送积分 ${orphanPurchaseLogs} 条）`)
}
// 按真实流水重算账户（refund 日志为取消订单时已回滚的原奖励，不再计入余额）
const pointAccounts = db.prepare('SELECT student_id FROM points').all()
let recomputed = 0
for (const { student_id } of pointAccounts) {
  const earned = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM point_logs WHERE student_id = ? AND type IN ('earn','checkin')").get(student_id).s
  const consumed = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM point_logs WHERE student_id = ? AND type = 'consume'").get(student_id).s
  const balance = Math.max(0, earned - consumed)
  const cur = db.prepare('SELECT total_earned, total_consumed, balance FROM points WHERE student_id = ?').get(student_id)
  if (cur && (cur.total_earned !== earned || cur.total_consumed !== consumed || cur.balance !== balance)) {
    db.prepare('UPDATE points SET total_earned = ?, total_consumed = ?, balance = ?, updated_at = ? WHERE student_id = ?')
      .run(earned, consumed, balance, Date.now(), student_id)
    recomputed++
  }
}
if (recomputed > 0) {
  console.log(`✓ 积分账户自愈（按真实流水${HEAL}重算 ${recomputed} 个账户）`)
}

// 积分流水余额快照自愈：按时间顺序重算每条流水的余额快照，保证明细页与账户余额一致
const pointStudents = db.prepare('SELECT student_id FROM points').all()
let snapshotUpdated = 0
for (const { student_id } of pointStudents) {
  const logs = db.prepare('SELECT id, type, amount FROM point_logs WHERE student_id = ? ORDER BY created_at ASC, id ASC').all(student_id)
  let running = 0
  for (const log of logs) {
    if (log.type === 'earn' || log.type === 'checkin') running += log.amount
    else if (log.type === 'consume') running -= log.amount
    const expected = Math.max(0, running)
    const cur = db.prepare('SELECT balance FROM point_logs WHERE id = ?').get(log.id).balance
    if (cur !== expected) {
      db.prepare('UPDATE point_logs SET balance = ? WHERE id = ?').run(expected, log.id)
      snapshotUpdated++
    }
  }
}
if (snapshotUpdated > 0) {
  console.log(`✓ 积分流水快照自愈（${HEAL}重算 ${snapshotUpdated} 条余额快照）`)
}

// 反馈数据卫生：清理自动化测试产生的反馈（冒烟/测试/E2E/AUDIT 标记）
const testFeedbacks = db.prepare(`
  SELECT COUNT(*) c FROM feedback
  WHERE content LIKE '冒烟测试%' OR content LIKE '%E2E%' OR content LIKE '%AUDIT%' OR content LIKE '%测试反馈%'
`).get().c
if (testFeedbacks > 0) {
  db.prepare(`
    DELETE FROM feedback
    WHERE content LIKE '冒烟测试%' OR content LIKE '%E2E%' OR content LIKE '%AUDIT%' OR content LIKE '%测试反馈%'
  `).run()
  console.log(`✓ 反馈数据卫生（${TAG}测试反馈 ${testFeedbacks} 条）`)
} else {
  console.log('✓ 反馈数据卫生（残留 0 条）')
}

// 出勤数据卫生：清理引用已取消排期的请假签到（已取消活动不应有出勤记录，多为自动化测试残留）
const cancelledLeaveAtt = db.prepare(`
  SELECT COUNT(*) c FROM attendances a
  JOIN schedules s ON s.id = a.schedule_id
  WHERE a.status = 'leave' AND s.status = 'cancelled'
`).get().c
if (cancelledLeaveAtt > 0) {
  db.prepare(`
    DELETE FROM attendances
    WHERE status = 'leave' AND schedule_id IN (
      SELECT id FROM schedules WHERE status = 'cancelled'
    )
  `).run()
  console.log(`✓ 出勤数据卫生（${TAG}已取消排期的请假签到 ${cancelledLeaveAtt} 条）`)
} else {
  console.log('✓ 出勤数据卫生（残留 0 条）')
}

// 报名数据卫生：清理已取消的报名记录（自动化测试取消排期时级联产生，会污染成员时间线）
const cancelledEnrollments = db.prepare(
  "SELECT COUNT(*) c FROM enrollments WHERE status = 'cancelled'"
).get().c
if (cancelledEnrollments > 0) {
  db.prepare("DELETE FROM enrollments WHERE status = 'cancelled'").run()
  console.log(`✓ 报名数据卫生（${TAG}已取消报名 ${cancelledEnrollments} 条）`)
} else {
  console.log('✓ 报名数据卫生（残留 0 条）')
}

// 关联完整性：孤儿数据（指向不存在排期/订单的记录）自动清理，保持数据库干净
const orphanChecks = [
  ['孤儿报名', `DELETE FROM enrollments WHERE schedule_id NOT IN (SELECT id FROM schedules)`, `SELECT COUNT(*) c FROM enrollments WHERE schedule_id NOT IN (SELECT id FROM schedules)`],
  ['孤儿签到', `DELETE FROM attendances WHERE schedule_id NOT IN (SELECT id FROM schedules)`, `SELECT COUNT(*) c FROM attendances WHERE schedule_id NOT IN (SELECT id FROM schedules)`],
  ['孤儿请假', `DELETE FROM leave_requests WHERE schedule_id != '' AND schedule_id NOT IN (SELECT id FROM schedules)`, `SELECT COUNT(*) c FROM leave_requests WHERE schedule_id != '' AND schedule_id NOT IN (SELECT id FROM schedules)`],
  ['卡单失联', `UPDATE member_cards SET order_id = '' WHERE order_id != '' AND order_id NOT IN (SELECT id FROM orders)`, `SELECT COUNT(*) c FROM member_cards WHERE order_id != '' AND order_id NOT IN (SELECT id FROM orders)`],
  ['孤儿绑定', `DELETE FROM parent_bindings WHERE student_id NOT IN (SELECT id FROM students)`, `SELECT COUNT(*) c FROM parent_bindings WHERE student_id NOT IN (SELECT id FROM students)`],
]
for (const [name, cleanSql, checkSql] of orphanChecks) {
  const before = db.prepare(checkSql).get().c
  if (before > 0) {
    db.prepare(cleanSql).run()
    // dry-run 下写入被拦截，before === after，若直接报 before-after 会误显示为 0 条
    const removed = APPLY ? before - db.prepare(checkSql).get().c : before
    console.log(`✓ 关联完整性：${name} ${TAG} ${removed} 条`)
  } else {
    console.log(`✓ 关联完整性：${name} 0 条`)
  }
}

// 孤儿退款/取消卡：正式退费卡必然保留订单关联；订单已删除的退款/取消卡为自动化测试残留，直接清理
const orphanRefundedCards = db.prepare(`
  SELECT COUNT(*) c FROM member_cards
  WHERE status IN ('refunded','cancelled')
    AND (order_id = '' OR order_id NOT IN (SELECT id FROM orders))
`).get().c
if (orphanRefundedCards > 0) {
  db.prepare(`
    DELETE FROM member_cards
    WHERE status IN ('refunded','cancelled')
      AND (order_id = '' OR order_id NOT IN (SELECT id FROM orders))
  `).run()
  console.log(`✓ 会员卡数据卫生（${TAG}孤儿退款/取消卡 ${orphanRefundedCards} 条）`)
} else {
  console.log('✓ 会员卡数据卫生（残留 0 条）')
}

// 报名计数自愈：enrolled_count 与报名表实际数量不一致时，按实际数量校正（防止历史计数漂移）
const driftCount = db.prepare(`
  SELECT COUNT(*) c FROM schedules s
  WHERE s.enrolled_count != (
    SELECT COUNT(*) FROM enrollments e WHERE e.schedule_id = s.id AND e.status = 'active'
  )
`).get().c
if (driftCount > 0) {
  db.prepare(`
    UPDATE schedules SET enrolled_count = (
      SELECT COUNT(*) FROM enrollments e WHERE e.schedule_id = schedules.id AND e.status = 'active'
    ), updated_at = ?
  `).run(Date.now())
  console.log(`✓ 报名计数自愈（${HEAL}校正 ${driftCount} 条排期报名数）`)
} else {
  console.log('✓ 报名计数自愈（无漂移）')
}

// 测试残留通知清理：自动化测试取消测试排课时生成的活动取消/变更通知，
// 其排课已被清理，继续留在家长通知列表会造成干扰，按内容特征删除。
// 先 SELECT 统计再删除：dry-run 下 DELETE 被护栏 3 拦截，若用 .changes 会把待清理项误报为 0。
const staleNoticeWhere = `
  (title = '活动取消通知' OR title = '今日训练取消通知' OR title = '活动变更通知')
    AND (
      content LIKE '%优化验证课%' OR content LIKE '%管理端深化测试课%'
      OR content LIKE '%剧本测试%' OR content LIKE '%测试班-%'
      OR content LIKE '%验证课msm%' OR content LIKE '%审计%'
      OR content LIKE '%多孩%' OR content LIKE '%首页验证%'
    )
`
const staleNotices = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE ${staleNoticeWhere}`).get().c
if (staleNotices > 0) {
  db.prepare(`DELETE FROM notifications WHERE ${staleNoticeWhere}`).run()
  console.log(`✓ 通知数据卫生（${TAG}测试活动取消/变更通知 ${staleNotices} 条）`)
} else {
  console.log('✓ 通知数据卫生（无测试取消通知残留）')
}

// 通知去重自愈：同一用户同一标题同一内容只保留最新一条（自动化测试循环产生的重复通知）
const dupNoticeIds = `
  SELECT n.id FROM notifications n
  JOIN (
    SELECT user_id, title, content, MAX(created_at) keep_id, COUNT(*) c
    FROM notifications GROUP BY user_id, title, content HAVING c > 1
  ) d ON d.user_id = n.user_id AND d.title = n.title AND d.content = n.content
  WHERE n.created_at != d.keep_id
`
const dupNotices = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE id IN (${dupNoticeIds})`).get().c
if (dupNotices > 0) {
  db.prepare(`DELETE FROM notifications WHERE id IN (${dupNoticeIds})`).run()
  console.log(`✓ 通知去重自愈（${TAG}重复通知 ${dupNotices} 条）`)
} else {
  console.log('✓ 通知去重自愈（无重复通知）')
}

// 测试教练清理：自动化测试创建的临时教练档案（无排课无业务引用）及其登录账号
const testTeachers = db.prepare(`
  SELECT t.id, t.phone FROM teachers t
  WHERE (t.name LIKE '%验证教练%' OR t.name LIKE '%审计测试教练%' OR t.name LIKE '%测试教练%')
    AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.teacher_id = t.id)
`).all()
if (testTeachers.length) {
  const phones = testTeachers.map((t) => t.phone).filter(Boolean)
  const ids = testTeachers.map((t) => t.id)
  const ph = ids.map(() => '?').join(',')
  db.prepare(`DELETE FROM teachers WHERE id IN (${ph})`).run(...ids)
  if (phones.length) {
    const pph = phones.map(() => '?').join(',')
    db.prepare(`
      DELETE FROM users WHERE phone IN (${pph})
        AND role IN ('coach','sales')
    `).run(...phones)
  }
  console.log(`✓ 教练数据卫生（${TAG}测试教练 ${testTeachers.length} 人）`)
} else {
  console.log('✓ 教练数据卫生（无测试教练残留）')
}

// 排期去重自愈：同课程+同日期+同时间的重复排期仅保留一条（自动化测试常见残留）
const dupScheds = db.prepare(`
  SELECT COUNT(*) c FROM schedules s WHERE EXISTS (
    SELECT 1 FROM schedules s2
    WHERE s2.course_name = s.course_name AND s2.date = s.date
      AND s2.start_time = s.start_time AND s2.end_time = s.end_time
      AND s2.id < s.id
  )
`).get().c
if (dupScheds > 0) {
  db.prepare(`
    DELETE FROM schedules WHERE id IN (
      SELECT id FROM schedules s WHERE EXISTS (
        SELECT 1 FROM schedules s2
        WHERE s2.course_name = s.course_name AND s2.date = s.date
          AND s2.start_time = s.start_time AND s2.end_time = s.end_time
          AND s2.id < s.id
      )
    )
  `).run()
  console.log(`✓ 排期去重自愈（${HEAL}清理重复排期 ${dupScheds} 条）`)
} else {
  console.log('✓ 排期去重自愈（无重复排期）')
}

// 测试通知清理：通用标题但内容引用测试数据的通知（活动取消/课时不足/续费提醒等）
const testGenericNotices = db.prepare(`
  SELECT COUNT(*) c FROM notifications
  WHERE title IN ('活动取消通知','课时不足提醒','会员即将到期提醒','活动变更通知')
    AND (content LIKE '%测试%' OR content LIKE '%提醒调试%')
`).get().c
if (testGenericNotices > 0) {
  db.prepare(`
    DELETE FROM notifications
    WHERE title IN ('活动取消通知','课时不足提醒','会员即将到期提醒','活动变更通知')
      AND (content LIKE '%测试%' OR content LIKE '%提醒调试%')
  `).run()
  console.log(`✓ 测试通知清理（${HEAL}清理通用标题测试通知 ${testGenericNotices} 条）`)
} else {
  console.log('✓ 测试通知清理（无残留）')
}

if (!APPLY) {
  console.log('[Hygiene] DRY-RUN 结束：以上标记「待清理」的条目尚未写入数据库，加 --apply 执行清理。')
}
console.log(issues ? `数据卫生检查失败，共 ${issues} 项` : '✓ 数据卫生检查通过')
process.exit(issues ? 1 : 0)
