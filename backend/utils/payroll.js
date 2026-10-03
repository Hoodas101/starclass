/**
 * 教练/兼职薪资计算引擎
 *
 * 支持三种计费模式：
 *  - fixed    按课时：每节课固定单价，可按人数设置阶梯档位
 *              例：80 元/节；≥16 人 120 元/节
 *  - per_head 按人头：按实际签到人数 × 单价
 *              例：5 元/人
 *  - hybrid   混合：每节基础费 + 超出免费人数后每人加价
 *              例：60 元/节，超出 6 人后每多 1 人加 5 元
 *
 * payRule 结构：
 * {
 *   type: 'fixed' | 'per_head' | 'hybrid',
 *   baseRate: 80,              // fixed/hybrid 每节基础金额
 *   tiers: [{ minStudents: 16, rate: 120 }], // fixed 阶梯（升序）
 *   perHeadRate: 5,            // per_head 每人单价
 *   freeHeadCount: 6,          // hybrid 免费人数（含该人数）
 *   extraPerHead: 5            // hybrid 超出每人加价
 * }
 *
 * 计薪口径（与 routes/payroll.js、routes/schedules.js 的双列展示配套）：
 *  - 「计薪节数」= 实际授课的排期数，判据收敛为下方 PAYABLE_SCHEDULE_SQL（单一来源）；
 *  - 「已排课节数」= 仅排除已取消的排期数，供与计薪节数对照，暴露两者差额；
 *  - 「人头」分子 = 签到（present + late）∪ 请假已扣课（leave_deduction_logs mode='class'）；
 *    请假未扣课（规则为不扣）不计人头 —— 学员未消耗课时，机构也无对应收入；
 *  - 单价按课程 consume_classes 折算：一次课消耗 N 节则按 N 节计酬（fixed / per_head）。
 */

// 依赖说明：本模块的纯计算函数（normalizeRule / calcLessonPay / ruleSummary / calcText）
// 不依赖数据库；只有读取「计薪节数 / 消课节数」的函数才需要 db 与扣课口径。故在**函数内**
// 按需 require（模块缓存使其零成本）—— 否则「仅 import 本模块」就会连带打开数据库连接
// 并执行迁移（tools/payroll-test.mjs 的规则引擎单测正是这种只 import 的用法，不应触碰真实库）。

const DEFAULT_RULE = Object.freeze({
  type: 'fixed',
  baseRate: 0,
  tiers: [],
  perHeadRate: 0,
  freeHeadCount: 0,
  extraPerHead: 0,
});

const TYPES = ['fixed', 'per_head', 'hybrid'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 规范化规则：补全缺省字段，过滤非法档位，保证可安全用于计算
 */
function normalizeRule(rule) {
  const src = rule && typeof rule === 'object' ? rule : {};
  const type = TYPES.includes(src.type) ? src.type : 'fixed';
  const baseRate = Math.max(0, num(src.baseRate));
  const perHeadRate = Math.max(0, num(src.perHeadRate));
  const freeHeadCount = Math.max(0, Math.floor(num(src.freeHeadCount)));
  const extraPerHead = Math.max(0, num(src.extraPerHead));
  const tiers = Array.isArray(src.tiers)
    ? src.tiers
        .filter((t) => t && Number.isFinite(Number(t.minStudents)) && Number(t.minStudents) >= 0)
        .map((t) => ({
          minStudents: Math.floor(num(t.minStudents)),
          rate: Math.max(0, num(t.rate)),
        }))
        .sort((a, b) => a.minStudents - b.minStudents)
    : [];
  return { type, baseRate, perHeadRate, freeHeadCount, extraPerHead, tiers };
}

/**
 * 课程「每次消耗课时数」归一：与 utils/deduction.resolveConsumeClasses 同规则。
 * 之所以在此复刻一份纯函数：lessonRows 已在 SQL 里带出 courses.consume_classes，
 * 逐行再调 resolveConsumeClasses 会产生 N+1 查询；规则只有「≤0/非数 → 1」一条，
 * 若将来规则变化，两处必须同步（resolveConsumeClasses 仍是唯一语义来源）。
 */
function normalizeConsumeClasses(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/**
 * 「排期是否实际授课（计薪）」的唯一判据 —— SQL 片段，要求 schedules 别名为 s。
 *
 * 为什么单独抽出：薪资侧（routes/payroll.js）与教练课时侧（routes/schedules.js 的
 * coachStats / coachClassRows）此前各写一份「节数」判定 —— 薪资侧额外要求
 * EXISTS(考勤)，教练课时侧只判 status != 'cancelled'，于是同一教练同一月在两个页面
 * 得到两个节数（实测 2026-10 王教练 1 / 5）。此处把「实际授课」收敛为单一来源，
 * 日期范围与「未来日期截断」由调用方叠加（两者是范围条件，不属单排期属性）。
 */
const PAYABLE_SCHEDULE_SQL =
  "s.status != 'cancelled' AND EXISTS (SELECT 1 FROM attendances a WHERE a.schedule_id = s.id)";

/** 单条排期是否计薪（与 PAYABLE_SCHEDULE_SQL 同判据，供无 SQL 上下文的调用方使用） */
function isPayableSchedule(scheduleId) {
  if (!scheduleId) return false;
  const db = require('../db');
  const row = db.prepare(`SELECT 1 FROM schedules s WHERE s.id = ? AND ${PAYABLE_SCHEDULE_SQL}`).get(scheduleId);
  return !!row;
}

/** 计薪节数：date 落在 [startDate, endDate] 内且实际授课的排期数 */
function countPayableLessons(teacherId, startDate, endDate) {
  const db = require('../db');
  return db.prepare(`
    SELECT COUNT(*) c FROM schedules s
    WHERE s.teacher_id = ? AND s.date >= ? AND s.date <= ? AND ${PAYABLE_SCHEDULE_SQL}
  `).get(teacherId, startDate, endDate).c;
}

/** 已排课节数：仅排除已取消（与 routes/schedules.js coachStats 原口径一致，供双列对照） */
function countScheduledLessons(teacherId, startDate, endDate) {
  const db = require('../db');
  return db.prepare(
    "SELECT COUNT(*) c FROM schedules WHERE teacher_id = ? AND status != 'cancelled' AND date >= ? AND date <= ?"
  ).get(teacherId, startDate, endDate).c;
}

/**
 * 消课节数：以 deduction_logs 为消课事实源求和（签到扣课与手工扣课都写这张表）。
 *
 * count 列由迁移 019 引入，历史行为 NULL。NULL 不能当 0（低估消课量），
 * 也不宜当 1（「所有历史扣课都是 1 节」无法证实），故按 resolveConsumeClasses(scheduleId)
 * 在**读取时**兜底 —— 不回写库、不做数据迁移，只保证 SUM(count) 口径稳定。
 */
function countConsumedLessons(teacherId, startDate, endDate) {
  const db = require('../db');
  const { resolveConsumeClasses } = require('./deduction');
  const rows = db.prepare(`
    SELECT d.schedule_id, d.count AS cnt
    FROM deduction_logs d JOIN schedules s ON s.id = d.schedule_id
    WHERE s.teacher_id = ? AND s.date >= ? AND s.date <= ?
  `).all(teacherId, startDate, endDate);
  let total = 0;
  for (const r of rows) {
    total += r.cnt == null ? resolveConsumeClasses(r.schedule_id) : (Number(r.cnt) || 0);
  }
  return total;
}

/**
 * 请假已扣课人头（mode='class'）：与 deduction_logs 交叉校验。
 * 请假路径只写 leave_deduction_logs、不写 attendances，故签到口径看不到这些已消课学员。
 */
function countLeaveDeductedHeads(teacherId, startDate, endDate) {
  const db = require('../db');
  return db.prepare(`
    SELECT COUNT(*) c FROM leave_deduction_logs l JOIN schedules s ON s.id = l.schedule_id
    WHERE s.teacher_id = ? AND s.date >= ? AND s.date <= ? AND l.mode = 'class'
  `).get(teacherId, startDate, endDate).c;
}

/**
 * 计算单节课的应发金额
 * @param {object} rule     规范化前的规则对象
 * @param {number} attended 计酬人头（present + late，per_head/hybrid 时另含请假已扣课）
 * @param {number} [consumeClasses=1] 本课程每次消耗课时数（fixed / per_head 乘，hybrid 不乘）
 * @returns {number} 金额（元）
 */
function calcLessonPay(rule, attended, consumeClasses = 1) {
  const r = normalizeRule(rule);
  const n = Math.max(0, Math.floor(num(attended)));
  const per = normalizeConsumeClasses(consumeClasses);
  switch (r.type) {
    case 'per_head':
      // 按人头：一名学员一次消课 consumeClasses 节，按「节」计酬时需乘 N（与扣课口径一致）
      return n * r.perHeadRate * per;
    case 'hybrid':
      // 混合：baseRate 是「每节」基础费、extraPerHead 是「每人」加价，均已是节粒度；
      // 再乘 consumeClasses 会把基础费重复放大、语义不清，故明确不乘（见 ruleSummary）。
      return r.baseRate + Math.max(0, n - r.freeHeadCount) * r.extraPerHead;
    case 'fixed':
    default: {
      const hit = [...r.tiers]
        .sort((a, b) => b.minStudents - a.minStudents)
        .find((t) => n >= t.minStudents);
      // 按课时：一次课消耗 N 节 → 发 N × 单节价（此前恒按 1 节发，配置 consume_classes=2 的课少发一半）
      return (hit ? hit.rate : r.baseRate) * per;
    }
  }
}

/**
 * 规则摘要（用于表格/列表展示）
 * 尾部附「计薪口径」注记：同一屏还有「已排课节数 / 计薪节数」双列，必须让使用者
 * 一眼看清人头与单价的折算方式，否则会以为系统少算/多算。
 */
function ruleSummary(rule) {
  const r = normalizeRule(rule);
  const HEADS_NOTE = '人头含请假已扣课';
  switch (r.type) {
    case 'per_head':
      return `${r.perHeadRate} 元/人（${HEADS_NOTE}；单价按课程消耗课时数折算）`;
    case 'hybrid':
      return `${r.baseRate} 元/节，超出 ${r.freeHeadCount} 人后 ${r.extraPerHead} 元/人（${HEADS_NOTE}；不按课程消耗课时数折算）`;
    case 'fixed':
    default: {
      const tiers = [...r.tiers].sort((a, b) => a.minStudents - b.minStudents);
      const note = '按课程消耗课时数折算';
      if (!tiers.length) return `${r.baseRate} 元/节（${note}）`;
      const parts = [`${r.baseRate} 元/节`];
      for (const t of tiers) parts.push(`≥${t.minStudents}人 ${t.rate} 元/节`);
      return `${parts.join('，')}（${note}）`;
    }
  }
}

/**
 * 单节课计算说明（用于明细导出/弹窗）
 * @param {number} [consumeClasses=1] 本课程每次消耗课时数（与 calcLessonPay 同口径）
 */
function calcText(rule, attended, consumeClasses = 1) {
  const r = normalizeRule(rule);
  const n = Math.max(0, Math.floor(num(attended)));
  const per = normalizeConsumeClasses(consumeClasses);
  switch (r.type) {
    case 'per_head':
      return per > 1
        ? `${r.perHeadRate} 元/人 × ${n} 人 × ${per} 节`
        : `${r.perHeadRate} 元/人 × ${n} 人`;
    case 'hybrid': {
      const extra = Math.max(0, n - r.freeHeadCount);
      if (extra <= 0) return `${r.baseRate} 元/节（${n} 人，未超 ${r.freeHeadCount} 人）`;
      return `${r.baseRate} 元/节 + (${n} - ${r.freeHeadCount}) × ${r.extraPerHead} 元`;
    }
    case 'fixed':
    default: {
      const hit = [...r.tiers]
        .sort((a, b) => b.minStudents - a.minStudents)
        .find((t) => n >= t.minStudents);
      const base = hit ? `${hit.rate} 元/节（≥${hit.minStudents} 人）` : `${r.baseRate} 元/节`;
      return per > 1 ? `${base} × ${per} 节` : base;
    }
  }
}

module.exports = {
  DEFAULT_RULE,
  TYPES,
  normalizeRule,
  normalizeConsumeClasses,
  PAYABLE_SCHEDULE_SQL,
  isPayableSchedule,
  countPayableLessons,
  countScheduledLessons,
  countConsumedLessons,
  countLeaveDeductedHeads,
  calcLessonPay,
  ruleSummary,
  calcText,
};
