/**
 * 「学员是否已失效（已删除 / 已归档）」的判定 —— 单一事实来源。
 *
 * 背景：students 表有两套失效标记，且历史实现互不一致：
 *   - `archived`（整数 0/1）：管理员编辑学员时置位；学员列表默认只显示 archived = 0。
 *   - `status`（文本）：新建时恒为 'active'；全后端唯一写入 'refunded' 的地方是
 *     DELETE /api/students/:id（routes/students.js）的软删除。
 *
 * 即 `status = 'refunded'` 的实际含义是「该学员已被删除」，而删除时并不会置 archived。
 * 所以只认 archived 会把已删学员漏进来（表现：续费/低课时/流失预警里出现已删学员，
 * 销售照着名单打无效电话 = 返工）；只认 status 又会漏掉手工归档的学员。
 * 两个条件必须同时判定，缺一不可。COALESCE 用于兜底历史脏数据（列为 NULL）。
 *
 * 使用前提：SQL 中学员表的别名为 `s`（本项目 growth.js / students.js 各处均如此）。
 */
const ACTIVE_STUDENT_SQL =
  "COALESCE(s.archived, 0) = 0 AND COALESCE(s.status, '') <> 'refunded'";

module.exports = { ACTIVE_STUDENT_SQL };
