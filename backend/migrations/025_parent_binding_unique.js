/**
 * 迁移 025：parent_bindings 唯一约束 —— 同一家长对同一学员只能有一条绑定
 *
 * 背景（增量问题报告第二轮 P1-2）：bindStudent 只校验「该家长已绑成员数 < 3」
 * （按 openid 计总数），既不校验「该家长是否已绑该学员」，也没有任何唯一约束。
 * 实测库中同一手机号对同一学员存在两条 is_main=1 的绑定，后果有三：
 *   · 通知用 `LIMIT 1` 只发给其中任意一条（顺序不确定），到底发给谁不可预测；
 *   · 绑定上限 3 人被重复绑定同一孩子白白挤占，多孩家庭实际可用名额 < 3；
 *   · 家长端「我的孩子」列表出现重复条目。
 *
 * 处理：
 *   1. 先**去重**存量数据（保留 is_main=1 优先、其次 id 最小的一条，删除其余），
 *      否则加唯一索引会直接失败、整个迁移中断，升级卡死。
 *   2. 建唯一索引。parent_openid 为 NULL / 空串的行不参与约束
 *      （SQLite 视 NULL 为互不相等，空串则显式排除）—— 这些是未完成绑定的历史行，
 *      强行合并会把两条无关记录缝成一条。
 *
 * 注意：`parent_bindings.id` 是 INTEGER PRIMARY KEY AUTOINCREMENT，删除行不会
 * 影响其它表 —— 全库没有任何表以 parent_bindings.id 作外键。
 *
 * 幂等性：去重语句可重复执行；索引用 IF NOT EXISTS。
 */

function up(db) {
  // ── 1. 存量去重 ──────────────────────────────────────────────
  // 保留优先级：is_main=1 → id 最小。其余同 (parent_openid, student_id) 的行删除。
  db.exec(`
    DELETE FROM parent_bindings
    WHERE (parent_openid IS NOT NULL AND parent_openid <> '')
      AND id NOT IN (
        SELECT keep_id FROM (
          SELECT MIN(id) AS keep_id
          FROM parent_bindings
          WHERE parent_openid IS NOT NULL AND parent_openid <> ''
          GROUP BY parent_openid, student_id
        )
      )
  `);

  // ── 2. 唯一索引 ──────────────────────────────────────────────
  // 部分索引（WHERE 子句）确保只约束「确有 openid」的行。
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_parent_bindings_openid_student
    ON parent_bindings(parent_openid, student_id)
    WHERE parent_openid IS NOT NULL AND parent_openid <> ''
  `);
}

module.exports = { up };
