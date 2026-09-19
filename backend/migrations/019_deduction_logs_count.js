/**
 * 迁移 019：deduction_logs 补 count 列 —— 记录「这一次实际扣了几节课」
 *
 * 背景（业务审查 C-ERP-17）：`deduction_logs` 原有列只回答了「哪次排期、哪个学员、
 * 哪张卡、什么时候扣的」，唯独没有「扣了几节」。于是回滚路径（清除签到、
 * 签到改为缺席/请假）只能靠 `resolveConsumeClasses(scheduleId)` 在**回滚那一刻**
 * 重新推导应退数量。推导值与当初真实扣减量不一致时，学员课时就会凭空增减：
 *
 *   1. 管理员用 `POST /api/membership/deduct` 显式传 `classes=N`（例如一次扣 3 节），
 *      而课程配置 `consume_classes=1` —— 撤销时只退 1 节，学员白丢 2 节。
 *   2. 扣课之后课程配置被修改（1 节改 2 节，或反之）—— 撤销时按新配置退，
 *      与当初扣的不一致，反复「签到→撤销」会持续放大偏差。
 *
 * 处理：补 count 列，扣课时写入真实扣减量，回滚时**以该列为准**而非重新推导。
 *
 * 关于历史行：一律留 NULL，**不填默认值 1**。填 1 等于断言「所有历史扣课都是 1 节」，
 * 而这一点无法从现有数据证实（历史上确实存在按 N 扣减的路径）。留 NULL 后，
 * 回滚逻辑回退到旧的推导方式，行为与本次改动前完全一致 —— 宁可不精确，
 * 也不能把猜测写成事实。
 *
 * 幂等性：ALTER 前先查 pragma_table_info（SQLite 无 ADD COLUMN IF NOT EXISTS），
 * 重复执行安全。
 */

function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('deduction_logs')").all().map((c) => c.name);
  if (!cols.includes('count')) {
    db.exec('ALTER TABLE deduction_logs ADD COLUMN count INTEGER');
  }
}

module.exports = { up };
