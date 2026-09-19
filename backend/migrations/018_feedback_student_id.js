/**
 * 迁移 018：feedback 补 student_id 关联列
 *
 * 背景（业务审查 C-CRM-8）：`routes/students.js` 的学员时间线里有一段
 *   `SELECT content, status, created_at FROM feedback WHERE student_id = ?`
 * 但 `feedback` 表**从来没有 student_id 列**（实际列为
 * id/user_id/user_name/content/contact/status/created_at/updated_at/reply/reply_at/replied_by）。
 * 该查询每次都抛 "no such column"，而调用处的 catch 是空的 ——
 * 于是学员详情页的「反馈」区块**永远为空且永远不报错**，属"看起来有、实际没有"的静默失效。
 *
 * 处理：补列 + 建索引 + 用家长绑定回填历史数据。
 * 反馈由家长账号提交（feedback.user_id 存 openid，形如 `phone_13900000001`），
 * 与 parent_bindings.parent_openid 同构，故可确定性地回填到其绑定学员；
 * 同一家长绑定多个学员时取主绑定（is_main 优先），不做一对多猜测。
 *
 * 幂等性：ALTER 前先查 pragma_table_info（SQLite 无 ADD COLUMN IF NOT EXISTS）；
 * 索引带 IF NOT EXISTS；回填只处理 student_id IS NULL 的行，重复执行安全。
 */

function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('feedback')").all().map((c) => c.name);
  if (!cols.includes('student_id')) {
    db.exec('ALTER TABLE feedback ADD COLUMN student_id TEXT');
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_student ON feedback(student_id)');

  // 回填：按家长 openid 找其绑定学员（主绑定优先），仅填尚未关联的行
  db.prepare(`
    UPDATE feedback
       SET student_id = (
             SELECT pb.student_id
               FROM parent_bindings pb
              WHERE pb.parent_openid = feedback.user_id
              ORDER BY pb.is_main DESC, pb.id ASC
              LIMIT 1
           )
     WHERE student_id IS NULL
       AND user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM parent_bindings pb2 WHERE pb2.parent_openid = feedback.user_id)
  `).run();
}

module.exports = { up };
