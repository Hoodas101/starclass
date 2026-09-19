/**
 * 迁移 020：历史已删学员回填 archived = 1
 *
 * 背景：删除学员（DELETE /api/students/:id）原本只把 `status` 置为 'refunded'，
 * 不动 `archived`。而学员列表默认按 `archived = 0` 过滤，于是被删除的学员：
 *   - 仍出现在学员列表里，且因为会员卡仍是 active，派生状态把它显示成「在读」；
 *   - 仍出现在续费 / 低课时 / 流失三个预警清单里，销售照着名单打无效电话。
 * 等于「删了跟没删一样」。
 *
 * 本次改动（与迁移配套）：
 *   - `DELETE /api/students/:id` 现在同时置 `archived = 1`，新删除的学员立即生效；
 *   - `utils/student-state.js` 提供统一判据，预警类查询同时认
 *     `archived = 1` 与 `status = 'refunded'`，不依赖本次回填也能正确排除。
 *
 * 本迁移只负责回填**本次之前**已删除的历史数据，让两套标记重新对齐：
 * 全后端唯一写入 `status = 'refunded'` 的地方就是删除接口，因此该条件可以安全地
 * 判定为「已删除」；只回填 `archived` 仍为 0/NULL 的行，重复执行无副作用。
 */

function up(db) {
  db.prepare(`
    UPDATE students
    SET archived = 1
    WHERE status = 'refunded' AND COALESCE(archived, 0) = 0
  `).run();
}

module.exports = { up };
