/**
 * 后端回归套件统一入口 —— 本地与 CI 共用同一份清单。
 *
 * 为什么需要它：套件清单原先写在两处（根 package.json 的 test 脚本、.github/workflows/ci.yml），
 * 且已经漂移 —— card-expiry / permission-keys 两个 P1 回归套件只出现在 npm test 里，
 * CI 从未执行，于是它们在 CI 上根本不构成门禁。把清单收敛到本文件后两边不可能再不一致。
 *
 * 用法：
 *   node tests/run-all.cjs                      （等价于 npm test）
 *   KEEP_TEST_DB=1 node tests/run-all.cjs       （保留临时库便于排查）
 *
 * 每个套件各自独立进程运行：它们会设置自己的 process.env.DB_PATH 并（部分）启动 HTTP 服务，
 * 同进程内互相污染。退出码：任一套件失败则非 0。
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const backendDir = path.join(__dirname, '..');

// 回归套件的夹具账号用的就是 seed 默认口令 123456。若开启「默认口令强制改密」，
// 除改密接口外的所有请求都会被鉴权中间件拦下，16 个套件会全军覆没而非发现真实回归。
// 故此处统一关闭（env 会随 spawnSync 传给各子进程）；该强制行为本身由
// batch7-security-guards.test.cjs 的用例在自己的进程内显式开启后覆盖。
process.env.FORCE_PASSWORD_CHANGE = process.env.FORCE_PASSWORD_CHANGE || '0';

// 顺序有意为之：先跑「离线直调处理器 + 自带隔离库」的轻套件（快、失败定位准），
// 再跑「启动 HTTP 服务」的重套件（full-system 最慢，放最后）。
//
// 未纳入本清单的套件（有意为之，非遗漏）：
//   · smoke-test.mjs / tests/live-smoke-3role.mjs —— 二者都针对**已运行的线上后端**
//     （默认 http://localhost:3001/api，可用 API_BASE 覆盖），依赖真实部署的库与
//     手机号登录（13800000001 等）。CI 的 backend-tests 作业不启动常驻服务，
//     本地 3001 又被实际运行的服务占用，纳入清单会让 run-all 必然失败而非发现回归。
//     其等价的**进程内**覆盖已由 batch9-authz-concurrency.test.cjs（支付/退款幂等、
//     扣课幂等、跨教练签到 403、>1mb 请求体 413、角色边界 403）与
//     full-system.test.js 的 A/A3 段（401 扫描 + 伪造 x-openid 头）承接。
//     如需保留线上冒烟，请在部署流水线（.github/workflows/deploy.yml）中单独调用。
const SUITES = [
  ['class-module.test.js', '课程模块'],
  ['p2-infra-regression.cjs', 'P2 基础设施（唯一约束/索引/TRUST_PROXY）'],
  ['upgrade-path.test.cjs', 'E20 迁移升级路径收敛'],
  ['audit-regression.cjs', '审计埋点回归'],
  ['lead-suggestions-regression.cjs', '线索推荐回归'],
  ['queue-regression.cjs', '排队队列回归'],
  ['permission-keys-regression.cjs', 'P1-5 员工权限键后端强制'],
  ['card-expiry-regression.cjs', 'P1-8 会员卡过期流转'],
  ['dashboard-charts-regression.cjs', 'P1-13 看板图表聚合'],
  ['sales-export-regression.cjs', 'P1-18 销售导出单品统计'],
  ['p2-fixes.test.js', 'P2 修复回归'],
  ['finance-refund-regression.cjs', '财务口径 + 退卡金额'],
  ['finance-payroll-regression.cjs', '薪资计算回归'],
  ['deduction-count-regression.cjs', '撤销签到课时回滚数量（迁移 019）'],
  ['order-benefits-idempotency-regression.cjs', '订单发卡/发积分幂等'],
  ['card-classes-invariant-regression.cjs', '会员卡课时恒等式（订单退款回收 / 退卡）'],
  ['points-clamp-consistency-regression.cjs', '积分回收 clamp 一致性（退款/取消/退卡/删活动）'],
  ['points-negative-net-rollback-regression.cjs', '删活动回滚积分：净额为负的学员也必须同步余额'],
  ['deleted-student-exclusion-regression.cjs', '已删除学员排除（三预警清单 + 学员列表 + 迁移 020）'],
  ['schedule-cancel-revert-regression.cjs', '取消排期回滚课时/积分/收入结转'],
  ['metrics-consistency-regression.cjs', '口径一致性（到场率 / enrolled_count 非负 / 排行榜余额）'],
  ['parent-binding-takeover-regression.cjs', '家长身份接管（改号占用检查覆盖 parent_bindings + 登录迁移纵深防御）'],
  ['batch9-authz-concurrency.test.cjs', '支付/退款幂等 + 跨教练签到鉴权 + 请求边界'],
  ['batch7-security-guards.test.cjs', 'S3-S11 安全守卫（导入黑名单/课表可见性/广播已读/口令/jwt算法/绑卡频控）'],
  ['full-system.test.js', '全功能系统'],
];

// 作为模块被 require 时只导出清单、不执行任何套件：本文件被定位为套件清单的
// 单一事实来源，就必须能被安全 import —— 否则任何想读取清单的工具（校验脚本、
// CI 辅助逻辑）都会顺手跑一遍全量测试并 process.exit 掉宿主进程。
module.exports = { SUITES };
if (require.main !== module) return;

console.log('========================================');
console.log('  星课后端 · 回归套件全量');
console.log('========================================\n');

const results = [];
for (const [file, label] of SUITES) {
  const t0 = Date.now();
  // process.execPath：用当前解释器，不依赖 PATH 上的 node 版本
  const r = spawnSync(process.execPath, [path.join('tests', file)], {
    cwd: backendDir,
    stdio: 'inherit',
    env: process.env,
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ label, file, ok, ms, status: r.status, signal: r.signal });
  console.log(`\n${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}  (${ms}ms)\n`);
}

const failed = results.filter((r) => !r.ok);
console.log('========================================');
console.log(`  结果：${results.length - failed.length}/${results.length} 套件通过`);
for (const f of failed) {
  console.log(`  ✗ ${f.label} (${f.file}) exit=${f.status}${f.signal ? ' signal=' + f.signal : ''}`);
}
console.log('========================================');
process.exit(failed.length ? 1 : 0);
