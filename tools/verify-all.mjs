/**
 * 一键全量验收脚本
 * 运行全部自动化验证套件并输出汇总报告。
 * 用法：node tools/verify-all.mjs   （或 npm run verify）
 * 前置：后端运行在 http://localhost:3001（./start-all.sh 或 backend/node server.js）
 *
 * ⚠ 本脚本会向目标数据库写入测试数据，并在收尾阶段物理删除测试残留。
 *   生产环境（NODE_ENV=production）下默认拒绝执行，需显式确认：
 *     VERIFY_DB_CONFIRM=1 npm run verify
 */
import { execFileSync } from 'child_process';

const root = new URL('..', import.meta.url).pathname;

// ── 安全闸门 ──────────────────────────────────────────────────────────
// 本脚本是「写入 + 删除」型测试夹具，不能在生产库上静默运行。
// 判据与 P0-1（自助支付）、data-hygiene 保持一致：NODE_ENV=production 即视为生产环境。
const CONFIRMED = process.env.VERIFY_DB_CONFIRM === '1';
if (process.env.NODE_ENV === 'production' && !CONFIRMED) {
  console.error('[Verify] 已拒绝执行：当前为生产环境（NODE_ENV=production）。');
  console.error('[Verify] 本脚本会写入测试数据并删除测试残留，在生产库上运行可能损坏真实业务数据。');
  console.error('[Verify] 如确认目标库可被测试写入，请显式确认：');
  console.error('[Verify]   VERIFY_DB_CONFIRM=1 npm run verify');
  process.exit(2);
}

// 数据卫生步骤必须显式 --apply 才会真正清理（其默认是 dry-run）；
// 已确认的生产环境同时透传 --allow-production，避免被 data-hygiene 的护栏拦下。
const HYGIENE_ARGS = ['tools/data-hygiene.mjs', '--apply'];
if (CONFIRMED) HYGIENE_ARGS.push('--allow-production');

const run = (cmd, args, cwd = root) => {
  const t0 = Date.now();
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, ms: Date.now() - t0, tail: out.trim().split('\n').slice(-2).join(' | ') };
  } catch (e) {
    const err = (e.stdout || '') + (e.stderr || '');
    return { ok: false, ms: Date.now() - t0, tail: err.trim().split('\n').slice(-2).join(' | ') };
  }
};

const suites = [
  { name: '测试数据卫生检查', fn: () => run('node', HYGIENE_ARGS) },
  { name: '冒烟测试（39 项）', fn: () => run('node', ['smoke-test.mjs']) },
  { name: '管理端 API 全流程（30 项）', fn: () => run('node', ['tools/admin-api-flow.mjs']) },
  { name: '业务剧本（全链路 21 项）', fn: () => run('node', ['tools/business-flow-test.mjs']) },
  { name: '双计费模式（时效/次数 14 项）', fn: () => run('node', ['tools/billing-mode-test.mjs']) },
  { name: '多孩报名链路（6 项）', fn: () => run('node', ['tools/multikid-enroll-test.mjs']) },
  { name: '积分奖励体系（9 项）', fn: () => run('node', ['tools/points-reward-test.mjs']) },
  { name: '请假扣减规则（课时/天数/双卡）', fn: () => run('node', ['tools/leave-deduct-test.mjs']) },
  { name: '家长扫码签到链路（8 项）', fn: () => run('node', ['tools/parent-checkin-test.mjs']) },
  { name: '提醒定时任务逻辑（7 项）', fn: () => run('node', ['tools/reminders-test.mjs']) },
  { name: 'API边界与越权（21 项）', fn: () => run('node', ['tools/api-edge-test.mjs']) },
  { name: '退款边界（6 项）', fn: () => run('node', ['tools/refund-test.mjs']) },
  { name: '管理端工作台链路（7 项）', fn: () => run('node', ['tools/admin-flow-test.mjs']) },
  { name: '管理端深化（添加/取消/字段 7 项）', fn: () => run('node', ['tools/admin-deep-test.mjs']) },
  { name: '管理端优化（展开/改排课/签到 7 项）', fn: () => run('node', ['tools/manage-opt-test.mjs']) },
  { name: '管理端真实工作流（24 项）', fn: () => run('node', ['tools/admin-workflow-e2e.mjs']) },
  { name: '薪资计算（规则引擎+API）', fn: () => run('node', ['tools/payroll-test.mjs']) },
  { name: 'Web 角色权限审计', fn: () => run('node', ['tools/web-role-audit.mjs']) },
  { name: 'Web 交互流审计', fn: () => run('node', ['tools/web-flow-audit.mjs']) },
];
// 收尾清理：流程测试会创建临时数据（排期/通知/积分/请假等），在验收结束后再跑一次数据卫生，
// 保证演示数据库在「验收完成」后立即恢复干净状态（--apply 见上方 HYGIENE_ARGS）
const FINAL_CLEANUP = { name: '收尾数据清理', fn: () => run('node', HYGIENE_ARGS) };
// 全库一致性审计：必须在收尾清理之后执行（前置套件会创建并清理测试数据）
const DB_INTEGRITY = { name: '全库跨表一致性审计（12 项）', fn: () => run('node', ['tools/db-integrity-test.mjs']) };

console.log('========================================');
console.log('  教务系统 · 一键全量验收');
console.log('========================================\n');

let failed = 0;
for (const s of [...suites, FINAL_CLEANUP, DB_INTEGRITY]) {
  const r = s.fn();
  const mark = r.ok ? '✓' : '✗';
  console.log(`${mark} ${s.name}  (${r.ms}ms)`);
  if (!r.ok) {
    failed++;
    console.log(`    ${r.tail}`);
  }
}

console.log('\n========================================');
console.log(failed ? `结果：${suites.length - failed}/${suites.length} 通过，${failed} 项失败` : `结果：${suites.length}/${suites.length} 全部通过 ✅`);
console.log('========================================');
process.exit(failed ? 1 : 0);
