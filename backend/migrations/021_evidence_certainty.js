/**
 * 010_evidence_certainty — 证据式记录分级字段
 *
 * 借鉴 trycompai/crm 的「证据规则（evidence over guessing）」：
 * 关于一个人的信息不靠猜 — 强证据写入档案，弱证据降级为待确认建议。
 *
 * 落地到 edu-admin 的两处“记录”载体：
 *   - follow_ups.note     跟进结果备注（完成跟进时填写）
 *   - leads.note          线索备注（销售录入的来源细节 / 家庭信息）
 *
 * certainty 取值：
 *   - confirmed  已核实：可写入档案的事实（家长亲口确认、合同单据、后台可查）
 *   - unverified 待确认：弱证据，仅供人工判断，不得当作事实传播
 *
 * 默认 'unverified'：默认保持克制，只有操作者明确标记“已核实”才升级为事实。
 *
 * 设计约束：
 *   - 纯增量扩展，只加列不改既有列，向后兼容。
 *   - 表可能不存在：follow_ups 由 routes/followups.js 按需惰性建表，
 *     migrations 先于路由加载执行，全新库上该表尚未创建 — 此处必须跳过，
 *     由路由层 CREATE TABLE 自带 certainty 列兜底。
 *   - 列已存在（旧库升级重跑场景）同样跳过，幂等。
 */
function up(db) {
  const tableExists = (name) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const columnExists = (table, column) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

  const addColumn = (table, ddl, column) => {
    if (!tableExists(table) || columnExists(table, column)) return;
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
  };

  addColumn('follow_ups', "certainty TEXT DEFAULT 'unverified'", 'certainty');
  addColumn('leads', "certainty TEXT DEFAULT 'unverified'", 'certainty');
}

module.exports = { up };
