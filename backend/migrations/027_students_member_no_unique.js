/**
 * 迁移 027：students.member_no 唯一约束
 *
 * 背景（增量问题报告第二轮 P1-12）：`nextMemberNo`（students.js）无 UNIQUE 约束、
 * 也无冲突重试 —— 它是「先查最大值再 +1」的经典竞态写法，多副本部署或并发建卡
 * 会撞号。而 `auth.js` 的 bindStudent 靠 `member_no` 区分同名学员，撞号会让家长
 * 绑错孩子（绑到别人家孩子的档案上），属数据正确性问题而非体验问题。
 *
 * 处理：
 *   1. 先去重存量：同一 member_no 保留 created_at 最早的一条，其余清空（置 NULL）
 *      而非删除 —— 学员档案本身不能因为编号重复就消失。清空后由应用层补发新号。
 *   2. 建**部分唯一索引**：只约束「非 NULL 且非空串」的行。空串/NULL 表示「尚未
 *      分配编号」，允许并存，避免把历史脏数据挡在门外导致升级失败。
 *
 * 幂等性：去重语句可重复执行；索引用 IF NOT EXISTS。
 */

function up(db) {
  // ── 1. 存量去重：重复编号只保留最早建档的一条，其余清空编号 ──
  db.exec(`
    UPDATE students
    SET member_no = NULL
    WHERE member_no IS NOT NULL AND member_no <> ''
      AND id NOT IN (
        SELECT keep_id FROM (
          SELECT MIN(COALESCE(created_at, 0)) AS _t, id AS keep_id
          FROM students
          WHERE member_no IS NOT NULL AND member_no <> ''
          GROUP BY member_no
        )
      )
  `);

  // ── 2. 部分唯一索引 ──
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_students_member_no
    ON students(member_no)
    WHERE member_no IS NOT NULL AND member_no <> ''
  `);
}

module.exports = { up };
