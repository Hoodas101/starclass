#!/usr/bin/env node
/**
 * 星课 StarClass · 数据一致性巡检（只读）
 *
 * 背景：审计 2026-11-10 发现演示库由 db/seed.js 直接落库，绕过业务写入事务，
 * 造成「订单-会员卡」「消课-结转」「积分账户-流水」三处台账割裂。
 * 这些不是代码 bug（业务写入链路本身正确），而是**存量数据**问题：
 * 自动按想象值回填会伪造历史流水，反而污染审计线索。
 *
 * 因此提供只读巡检：让运维在每次部署/迁移后看到割裂规模，
 * 再由机构决定「按业务单据回放」还是「标记为历史数据并隔离统计」。
 * 同时兜底检查已由迁移 042 修复的两类脏数据是否复发。
 *
 * 用法：
 *   node tools/data-consistency-check.js            # 只读报告
 *   node tools/data-consistency-check.js --strict   # 存在异常时以退出码 1 结束（可用于 CI）
 *
 * 绝不写入任何表。默认读取 backend/db/data.db，可用 DB_PATH 覆盖。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'backend', 'db', 'data.db');
if (!fs.existsSync(DB_PATH)) {
  console.error(`数据库不存在：${DB_PATH}`);
  process.exit(2);
}
const Database = require(path.join(ROOT, 'backend', 'node_modules', 'better-sqlite3'));
const db = new Database(DB_PATH, { readonly: true });

const hasTable = (name) => !!db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
).get(name);
// 查询失败不能静默变成 0：旧实现 catch 返回 null，调用处 `null > 0` 为假就落「通过」，
// 缺表/缺列时 CI 得到一片绿灯。改为累计到 queryErrors，作为独立异常输出并让 --strict 失败。
const queryErrors = [];
const count = (sql, ...args) => {
  try { return db.prepare(sql).get(...args).c; }
  catch (e) { queryErrors.push(String(e && e.message ? e.message : e)); return null; }
};

const findings = [];
const note = (level, name, detail, advice) => findings.push({ level, name, detail, advice });

// ── X4 购卡订单与会员卡关联 ──
if (hasTable('orders') && hasTable('member_cards')) {
  const orphan = count(`
    SELECT COUNT(*) c FROM orders o
    WHERE o.order_type = 'membership'
      AND o.status IN ('paid','refunded')
      AND NOT EXISTS (SELECT 1 FROM member_cards mc WHERE mc.order_id = o.id)
  `);
  const total = count("SELECT COUNT(*) c FROM orders WHERE order_type='membership'");
  if (orphan === null) note('跳过', '订单-会员卡关联', '字段缺失，无法巡检', '检查迁移是否完整');
  else if (orphan > 0) note('高', '订单-会员卡关联',
    `${orphan}/${total} 笔购卡订单没有关联会员卡（order_id 为 NULL 或指向不存在的卡）`,
    '按 items.itemId + student_id 人工核对后回填 order_id；在此之前，这些订单退款不会回收卡内权益，退款接口现已给出警示');
  else note('通过', '订单-会员卡关联', `${total} 笔购卡订单均已关联会员卡`, '');
}

// ── X5 消课与收入结转 ──
if (hasTable('attendances') && hasTable('deduction_logs') && hasTable('revenue_recognitions')) {
  const consumed = count("SELECT COALESCE(SUM(consume_classes),0) c FROM attendances WHERE status IN ('present','late')");
  const logs = count('SELECT COUNT(*) c FROM deduction_logs');
  const recognized = count('SELECT COUNT(*) c FROM revenue_recognitions');
  if (consumed > 0 && (logs === 0 || recognized === 0)) {
    note('高', '消课-扣课/结转台账',
      `考勤消课 ${consumed} 次，但 deduction_logs ${logs} 行、revenue_recognitions ${recognized} 行`,
      '若属导入的历史演示数据，建议标注并隔离统计；若属业务写入缺失，回放扣课与结转并补断言，勿凭空补造流水');
  } else {
    note('通过', '消课-扣课/结转台账', `消课 ${consumed} 次 / 扣课日志 ${logs} 行 / 结转 ${recognized} 行`, '');
  }
}

// ── X6 积分账户与流水 ──
if (hasTable('points') && hasTable('point_logs')) {
  const bal = count('SELECT COALESCE(SUM(balance),0) c FROM points');
  const earned = count('SELECT COALESCE(SUM(total_earned),0) c FROM points');
  const logEarn = count("SELECT COALESCE(SUM(amount),0) c FROM point_logs WHERE type='earn'");
  const logConsume = count("SELECT COALESCE(SUM(amount),0) c FROM point_logs WHERE type='consume'");
  const drift = Math.abs((logEarn - logConsume) - bal);
  if (drift > 0.005 || Math.abs(earned - logEarn) > 0.005) {
    note('中', '积分账户-流水',
      `points.balance 合计 ${bal} / total_earned 合计 ${earned}，point_logs earn ${logEarn} / consume ${logConsume}（净额差 ${drift}）`,
      '以 point_logs 重算账户并补登缺失 earn 流水；退款回收赠送积分依赖流水定位，缺失会回收落空');
  } else {
    note('通过', '积分账户-流水', `余额 ${bal} 与流水净额一致`, '');
  }
}

// ── X3 / X2 复发检查（迁移 042 已修复，防止 seed 再次污染）──
if (hasTable('students')) {
  const bad = count("SELECT COUNT(*) c FROM students WHERE join_date IS NOT NULL AND join_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'");
  if (bad > 0) note('高', 'join_date 格式', `${bad} 行不是 YYYY-MM-DD，日期区间筛选会静默失效`,
    '重新执行迁移 042 或检查 seed.js 写入路径');
  else note('通过', 'join_date 格式', '全部为 YYYY-MM-DD', '');
}
if (hasTable('orders')) {
  const bad = count("SELECT COUNT(*) c FROM orders WHERE status='refunded' AND refunded_amount>0 AND refunded_amount < payable_amount-0.005");
  if (bad > 0) note('高', '部分退款终态', `${bad} 笔部分退款订单被误标为 refunded，剩余额度无法续退`,
    '重新执行迁移 042 纠正状态');
  else note('通过', '部分退款终态', '无异常', '');
}
if (hasTable('orders') && hasTable('payments')) {
  const missing = count(`
    SELECT COUNT(*) c FROM orders o
    WHERE COALESCE(o.refunded_amount,0) > 0
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.status='refunded')
  `);
  if (missing > 0) note('中', '退款流水', `${missing} 笔已退款订单缺少 REF 支付流水`,
    '重新执行迁移 042 补登，或核对业务写入路径');
  else note('通过', '退款流水', '已退款订单均有 REF 流水', '');
}

if (queryErrors.length) {
  note('高', '巡检查询失败', `${queryErrors.length} 条 SQL 无法执行（表/列可能缺失或库不可读）`,
    `检查迁移与数据库完整性；首条错误：${queryErrors[0]}`);
}
// 空 findings 说明库里连基础表都没有（或全部查询失败），不能算「无异常」。
if (findings.length === 0) {
  note('高', '巡检未产生任何结论', '未找到可巡检的数据表', '确认 DB_PATH 指向真实业务库、迁移已执行');
}
const abnormal = findings.filter((f) => ['高', '中'].includes(f.level));
console.log('\n星课 StarClass · 数据一致性巡检（只读，不写入任何表）');
console.log('数据库：' + DB_PATH);
console.log('─'.repeat(72));
for (const f of findings) {
  console.log(`[${f.level}] ${f.name}`);
  if (f.detail) console.log('       现状：' + f.detail);
  if (f.advice) console.log('       建议：' + f.advice);
}
console.log('─'.repeat(72));
console.log(`巡检项 ${findings.length}，异常 ${abnormal.length}`);

db.close();
if (process.argv.includes('--strict') && abnormal.length > 0) process.exit(1);
