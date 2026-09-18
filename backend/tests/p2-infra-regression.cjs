/**
 * P2 基础设施回归 —— 考勤唯一约束 / 积分引用索引 / busy_timeout / TRUST_PROXY 接线
 *
 * 运行（隔离库，每次运行前重建 seed 夹具，绝不污染真实数据）：
 *   NODE_ENV=test node tests/p2-infra-regression.cjs
 *
 * 覆盖的四项原始缺陷：
 *   1. `attendances` 缺 `UNIQUE(schedule_id, student_id)`。代码早已把这组列当自然键
 *      （4 处写入点都先查存在性、checkin.js:187 的 UPDATE 直接以这两列为条件），
 *      但数据库层没有强制。一旦出现重复行，后续 UPDATE 会同时改中两行，
 *      且 LEFT JOIN 聚合（自动缺席、看板到场率）会把同一学员算两次。
 *   2. `point_logs.reference_id` 无索引，而全额退款路径（orders.js:500）要按
 *      `reference_id GLOB 'order_<id>*'` 回查积分流水以回收 —— 每次全表扫。
 *   3. `busy_timeout` 未显式设置（依赖 better-sqlite3 的隐式默认值）。
 *   4. `TRUST_PROXY` 接线与取值解析：反代部署下未生效会让全体用户共享一个限流桶；
 *      且 `0` / 非数字取值曾回退为「信任全部代理」，使 XFF 可伪造绕过限流。
 *
 * 判别性说明：每条断言都先构造「旧代码会给出不同结果」的场景（见各块的自证），
 * 而不是仅断言现状。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// 唯一引导路径：重建 seed 夹具库（详见 _bootstrap.cjs）
const { bootstrap } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-infra');

const db = require('../db');
const { up: migration015 } = require('../migrations/015_attendance_unique_and_point_index');

const backendDir = path.join(__dirname, '..');
const repoRoot = path.join(backendDir, '..');

let passed = 0;
let failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${ok ? '' : '  -> ' + detail}`);
}

const UNIQUE_IDX = 'uq_attendances_schedule_student';
const POINT_IDX = 'idx_point_logs_reference';

const indexInfo = (name) =>
  db.prepare('SELECT name, sql FROM sqlite_master WHERE type = ? AND name = ?').get('index', name);
// PRAGMA index_info 对不存在的索引安全返回空数组（已实测），故无需额外守卫
const indexCols = (name) => db.prepare(`PRAGMA index_info(${name})`).all().map((c) => c.name);
const isUnique = (name) => db.prepare(`PRAGMA index_list(attendances)`).all().some((i) => i.name === name && i.unique === 1);
const planOf = (sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');
// DROP INDEX 对不存在的索引**会抛错**（no such index，已实测）。若不加守卫，
// 「索引缺失」这一被测缺陷会让套件自身崩溃、掩盖后续断言 —— 必须降级为干净的 FAIL。
const dropIndexIfExists = (name) => {
  if (indexInfo(name)) db.exec(`DROP INDEX ${name}`);
};

// ─────────────────────────────────────────────────────────────
console.log('\x1b[1m[一] attendances(schedule_id, student_id) 唯一约束\x1b[0m');
{
  const idx = indexInfo(UNIQUE_IDX);
  rec('一-索引存在', !!idx, '未找到 ' + UNIQUE_IDX);
  rec('一-声明为 UNIQUE', isUnique(UNIQUE_IDX), 'index_list 未标记 unique');
  rec('一-列序为 (schedule_id, student_id)', JSON.stringify(indexCols(UNIQUE_IDX)) === '["schedule_id","student_id"]', JSON.stringify(indexCols(UNIQUE_IDX)));

  // 取夹具中**未被占用**的槽位。注意不能只取两个「空闲组合」——
  // 它们可能共用同一排期（如 (A,x) 与 (A,y)），于是「同学员异排期」那条探针
  // 会撞上先前插入的行，把「约束生效」误判成「误伤」。故一次性求解四个槽位：
  // 两个不同排期 × 两个不同学员，并保证 A、B、C 三个组合都是空闲的。
  const slots = db.prepare(`
    SELECT s1.id AS s1, s2.id AS s2, a.id AS st1, b.id AS st2
    FROM schedules s1, schedules s2, students a, students b
    WHERE s1.id < s2.id AND a.id < b.id
      AND NOT EXISTS (SELECT 1 FROM attendances x WHERE x.schedule_id = s1.id AND x.student_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM attendances x WHERE x.schedule_id = s1.id AND x.student_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM attendances x WHERE x.schedule_id = s2.id AND x.student_id = a.id)
    LIMIT 1
  `).get();
  rec('一-夹具可提供 2 排期 × 2 学员 的空闲组合', !!slots, `slots=${JSON.stringify(slots)}`);

  const pair = slots ? { sch: slots.s1, stu: slots.st1 } : null;
  // 同排期异学员 (s1, st2)；同学员异排期 (s2, st1) —— 两者都已在上面查询中确认空闲
  const crossPair = slots ? { sch: slots.s1, stu: slots.st2 } : null;
  const schedPair = slots ? { sch: slots.s2, stu: slots.st1 } : null;

  // 探针 id 用无下划线前缀，避免 LIKE 的 `_` 通配歧义
  const ins = db.prepare('INSERT INTO attendances (id, schedule_id, student_id, status, date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
  const mk = (id, sch, stu) => ins.run(id, sch, stu, 'present', '2026-01-01', Date.now(), Date.now());
  const PROBE = 'zzinfraprobe';

  try {
    mk(PROBE + '1', pair.sch, pair.stu);
    rec('一-首次插入成功', true, '');
  } catch (e) {
    rec('一-首次插入成功', false, e.message);
  }

  // 判别核心：同 (schedule, student) 第二次插入必须被拒
  let dupErr = null;
  try {
    mk(PROBE + '2', pair.sch, pair.stu);
  } catch (e) {
    dupErr = e;
  }
  rec('一-重复(同排期同学生)被拒', !!dupErr && /UNIQUE/i.test(dupErr.code || dupErr.message), dupErr ? `code=${dupErr.code}` : '未被拒绝');

  // 不误伤：同排期不同学生（crossPair）/ 同学员不同排期（schedPair）都应允许
  let crossOk = true;
  let crossDetail = '';
  try {
    mk(PROBE + '3', crossPair.sch, crossPair.stu);
  } catch (e) {
    crossOk = false;
    crossDetail = '同排期异学员被误伤: ' + e.message;
  }
  try {
    mk(PROBE + '4', schedPair.sch, schedPair.stu);
  } catch (e) {
    crossOk = false;
    crossDetail = '同学员异排期被误伤: ' + e.message;
  }
  rec('一-同排期异学员 / 同学员异排期 均允许（不误伤）', crossOk, crossDetail);

  // 自证：约束确实承重 —— 删掉索引后，同一重复插入会成功。
  // 插入成功后**立即清理**该重复行：否则迁移会按设计跳过重建索引（见下一条）。
  dropIndexIfExists(UNIQUE_IDX);
  let afterDrop = null;
  try {
    mk(PROBE + '5', pair.sch, pair.stu);
  } catch (e) {
    afterDrop = e;
  }
  rec('一-自证:删索引后重复插入成功（证明约束承重，非插入失败）', afterDrop === null, afterDrop ? `仍被拒: ${afterDrop.message}` : '');
  const dupRows = db.prepare(`SELECT COUNT(*) c FROM attendances WHERE id = '${PROBE}5'`).get().c;
  db.prepare(`DELETE FROM attendances WHERE id = ?`).run(PROBE + '5');
  rec('一-自证行确已写入且已清理', dupRows === 1 && db.prepare(`SELECT COUNT(*) c FROM attendances WHERE id = '${PROBE}5'`).get().c === 0, `写入 ${dupRows} 行`);

  // 恢复索引（迁移必须能重建；同时验证重复执行幂等）
  let reErr = null;
  try {
    migration015(db);
    migration015(db); // 幂等
  } catch (e) {
    reErr = e;
  }
  rec('一-迁移可重复执行且幂等', reErr === null, reErr ? reErr.message : '');
  rec('一-索引已恢复', !!indexInfo(UNIQUE_IDX), '迁移未重建索引（是否仍有残留重复行？）');
  rec('一-恢复后重复插入再次被拒', (() => {
    try { mk(PROBE + '6', pair.sch, pair.stu); return false; } catch (e) { return /UNIQUE/i.test(e.code || e.message); }
  })(), '');

  // 清理全部探针行
  const left = db.prepare(`DELETE FROM attendances WHERE id LIKE '${PROBE}%'`).run().changes;
  const remain = db.prepare(`SELECT COUNT(*) c FROM attendances WHERE id LIKE '${PROBE}%'`).get().c;
  rec('一-探针数据已清理', remain === 0, `删除 ${left} 行，仍剩 ${remain} 行`);
}

// ─────────────────────────────────────────────────────────────
console.log('\x1b[1m[二] point_logs.reference_id 索引（退款回收积分热路径）\x1b[0m');
{
  rec('二-索引存在', !!indexInfo(POINT_IDX), '未找到 ' + POINT_IDX);
  rec('二-索引列为 reference_id', JSON.stringify(indexCols(POINT_IDX)) === '["reference_id"]', JSON.stringify(indexCols(POINT_IDX)));

  // 与 orders.js:500 同形：GLOB 前缀回查
  const q = "SELECT * FROM point_logs WHERE reference_id GLOB 'order_probe*'";
  const withIdx = planOf(q);
  rec('二-GLOB 前缀查询走索引（非全表 SCAN）', /SEARCH .*USING INDEX/i.test(withIdx) && !/SCAN/i.test(withIdx.replace(/SEARCH[^|]*/g, '')), withIdx);

  // 自证：删索引后同一查询退化为全表扫，证明该断言能测出缺索引
  dropIndexIfExists(POINT_IDX);
  const withoutIdx = planOf(q);
  rec('二-自证:删索引后退化为 SCAN', /SCAN/i.test(withoutIdx), withoutIdx);
  migration015(db);
  rec('二-索引已恢复', !!indexInfo(POINT_IDX), '');
}

// ─────────────────────────────────────────────────────────────
console.log('\x1b[1m[三] busy_timeout 显式固定\x1b[0m');
{
  const bt = db.pragma('busy_timeout', { simple: true });
  rec('三-busy_timeout 为 5000ms', bt === 5000, `实际 ${bt}`);
  // ⚠️ 判别性局限（已实测，如实标注）：better-sqlite3 构造时默认即 5000ms，
  // 故**删掉 db/index.js 里那行 pragma 不会让本断言翻红**（实测注入后仍 31/31 PASS）。
  // 也就是说本断言能检出的是「有人把该值改小/改大」，检不出「有人删掉该行」。
  // 之所以不补一条「源码必须含该行」的文本断言：删行的行为后果为零（驱动默认值相同），
  // 那种断言只是守住一个不存在的风险。本项在修复报告中被明确降级为
  // 「显式化，非缺陷修复」。
  rec('三-foreign_keys 已开启', db.pragma('foreign_keys', { simple: true }) === 1, '');
  rec('三-journal_mode 为 wal', String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal', '');
}

// ─────────────────────────────────────────────────────────────
console.log('\x1b[1m[四] TRUST_PROXY 取值解析与部署接线\x1b[0m');
{
  // 行为级：在子进程中 require server.js，读取 app.get('trust proxy')。
  // DB_PATH 指向临时库，绝不触碰真实库。
  const probeDir = '/tmp/edu-test-infra-tp';
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.mkdirSync(probeDir, { recursive: true });
  const probeDb = path.join(probeDir, 'data.db');

  const readTrustProxy = (value) => {
    const env = { ...process.env, DB_PATH: probeDb, NODE_ENV: 'test' };
    delete env.TRUST_PROXY;
    if (value !== undefined) env.TRUST_PROXY = value;
    const script = "const app=require('./server');console.log('__TP__'+JSON.stringify(app.get('trust proxy')));process.exit(0);";
    const r = spawnSync(process.execPath, ['-e', script], { cwd: backendDir, env, encoding: 'utf8' });
    const m = (r.stdout || '').match(/__TP__(.+)/);
    return m ? m[1].trim() : `(无输出 status=${r.status})`;
  };

  const cases = [
    [undefined, 'false', '未设置 → 不信任任何代理头'],
    ['1', '1', '=1 → 信任 1 跳'],
    ['2', '2', '=2 → 信任 2 跳'],
  ];
  for (const [v, expect, label] of cases) {
    const got = readTrustProxy(v);
    rec(`四-${label}`, got === expect, `期望 ${expect}，实际 ${got}`);
  }

  // 原始缺陷：0 / 非数字 曾回退为 true（信任全部代理）→ XFF 可伪造绕过限流
  for (const [v, label] of [['0', '=0（想显式关闭）'], ['abc', '=abc（拼写错误）'], ['-1', '=-1（负数）']]) {
    const got = readTrustProxy(v);
    rec(`四-${label} 不得为 true（fail-closed）`, got === 'false', `实际 ${got} —— 若为 true 则 XFF 可任意伪造绕过限流`);
  }

  fs.rmSync(probeDir, { recursive: true, force: true });

  // 部署接线（文本断言，刻意不引入 YAML 依赖到仓库）：
  // 该叠加层的唯一用途就是「app 位于 Caddy 之后」，故必须替 app 声明 TRUST_PROXY。
  const caddyCompose = fs.readFileSync(path.join(repoRoot, 'docker-compose.caddy.yml'), 'utf8');
  const baseCompose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const caddyfile = fs.readFileSync(path.join(repoRoot, 'deploy', 'Caddyfile'), 'utf8');

  rec('四-Caddyfile 确实做 reverse_proxy（叠加层确实引入代理）', /reverse_proxy\s+app:3001/.test(caddyfile), '未找到 reverse_proxy app:3001');
  rec('四-caddy 叠加层为 app 声明 TRUST_PROXY 且默认 1',
    /TRUST_PROXY:\s*"\$\{TRUST_PROXY:-1\}"/.test(caddyCompose),
    '未找到 TRUST_PROXY: "${TRUST_PROXY:-1}"');
  rec('四-caddy 叠加层含 app 服务块（确保上面那条落在 app 上）', /^\s{2}app:\s*$/m.test(caddyCompose), '未找到 app: 服务块');
  // 反向护栏：无代理的基线文件不得声明 TRUST_PROXY，否则直连部署下可伪造 XFF 绕过限流
  rec('四-基线 compose（无代理）不得声明 TRUST_PROXY', !/TRUST_PROXY/.test(baseCompose), '基线文件不应出现 TRUST_PROXY');
}

// ─────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
process.exit(failed ? 1 : 0);
