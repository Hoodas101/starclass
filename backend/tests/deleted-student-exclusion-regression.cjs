/**
 * 回归套件 —— 已删除学员的「排除」（删除 = 真的从列表与三个预警清单里消失）
 *
 * 被验证的缺陷（「删了跟没删一样」）：
 *   DELETE /api/students/:id 原本只把 `students.status` 置为 'refunded'，**不动
 *   `archived` 列**。而学员列表 GET /api/students 默认过滤 `WHERE s.archived = 0`
 *   （students.js:278-281）。由此产生三个后果：
 *     1) 已删学员仍出现在学员列表里；
 *     2) 列表状态展示原为 `r.archived ? 'archived' : (r.mem_status || r.status)`，
 *        而 mem_status 由会员卡派生（CASE 带 ELSE 'none'，恒为真值），`r.status`
 *        永远取不到 —— 已删学员只要卡还有效就被显示成「在读」；
 *     3) 已删学员仍出现在增长中心三个预警清单（/growth/churn、/growth/renewal、
 *        /growth/low-classes）里，销售照着名单打无效电话 = 返工。
 *
 * 修复方式（已完成，本套件只做验证，不改业务代码）：
 *   · 新增 utils/student-state.js，导出统一判据
 *     ACTIVE_STUDENT_SQL = "COALESCE(s.archived,0)=0 AND COALESCE(s.status,'')<>'refunded'"
 *     （前提：学员表别名为 s）。判据同时认「已归档」与「已删除」两种标记。
 *   · growth.js 的 churn / renewal / low-classes 三处查询各自追加 `AND ${ACTIVE_STUDENT_SQL}`。
 *   · students.js 的 DELETE 改为同时置 archived = 1。
 *   · students.js:393 状态展示改为「refunded 优先」。
 *   · 迁移 020 回填历史数据（status='refunded' 且 archived=0 的行 → archived=1）。
 *
 * 判别力实测（不是推测 —— 已把 backend/ 整树复制到 /tmp，用 git HEAD 版
 * routes/growth.js 与 routes/students.js 覆盖副本里的同名文件，**保留**新增的
 * utils/student-state.js 与 migrations/020（否则 require 直接崩，测不出东西），
 * 在副本上跑本套件；工作区业务代码未改动）：
 *   修复前：PASS 22 / FAIL 7      修复后：PASS 29 / FAIL 0
 *   7 条 FAIL 全部落在标 [判别] 的条目上，一处不多一处不少：
 *     · T2  A.archived === 1（HEAD 版 DELETE 不动 archived，实测 archived=0）
 *     · T3  A 从 churn / renewal / low-classes 三个清单消失（HEAD 版三处查询无
 *           ACTIVE_STUDENT_SQL，实测 A 仍出现在三个清单里）
 *     · T4  默认列表不含 A（HEAD 版实测默认列表含 A，total=10）
 *     · T4  archived=1 查询含 A（HEAD 版实测 archived=1 total=0）
 *     · T4  A 展示 status === 'refunded'（HEAD 版 A 不在 archived=1 结果里 → undefined）
 *   其余 22 条（T0 前置 5 + T1 护栏 6 + T2 护栏 3 + T3 护栏 3 + T4 护栏 1 + T5 护栏 4）
 *   在修复前后结果相同，均已在下方逐条标注为「护栏」。
 *
 * 判别力边界（据实标注，避免把「护栏」伪装成「判别项」）：
 *   · T1（删除前 A/B 都在三个清单里）在修复前后结果相同 → **护栏**，不是判别项。
 *     它钉死的是「夹具确实命中了三个清单」这一前提：若夹具没造好，T3 的
 *     「A 不在清单里」会变成恒真的假绿，T1 先失败即可暴露。
 *   · T2 中 `status='refunded'` 与「parent_bindings 已清空」两条在修复前后同结果
 *     → **护栏**（HEAD 版 DELETE 本就写 status 并解绑家长）。T2 真正的判别项是
 *     `archived === 1`（HEAD 版不动 archived）。
 *   · T3 中「B 仍在三个清单里」三条在修复前后同结果 → **护栏**，作用是证明过滤
 *     没有把整个清单清空（否则「A 不在清单」可能是清单为空的假绿）。
 *   · T4 中「默认列表含 B」在修复前后同结果 → **护栏**。
 *   · T5（迁移 020 回填）在本判别力对照中**不是判别项**：对照只覆盖 growth.js /
 *     students.js 两个文件，migrations/020 与 utils/student-state.js 均按任务要求
 *     保留在副本里，故 up() 在两边都存在、结果相同。它是「新功能正确性 + 幂等」
 *     的护栏（防止回填写成无 WHERE 的全表更新、或重复执行报错）。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db）：
 *   node tests/deleted-student-exclusion-regression.cjs
 *   KEEP_TEST_DB=1 node tests/deleted-student-exclusion-regression.cjs   （保留临时库排查）
 *
 * 写法说明：建库/清理沿用 _bootstrap.cjs（seed 夹具 + 退出时删除临时库），
 * 直调路由处理器沿用 order-benefits-idempotency-regression.cjs 的
 * getHandler/mockRes/mockReq（不启 HTTP 服务，避免与线上占用的 3001 端口及并发套件冲突）。
 */
'use strict';

// ---- 隔离库（必须在 require('../db') 之前设置）----
const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-deleted-student-exclusion');

const db = require('../db');
const { now } = require('../utils');
const growthRouter = require('../routes/growth');
const studentsRouter = require('../routes/students');
const migration020 = require('../migrations/020_backfill_deleted_students_archived');

// 防呆：临时库必须落在 /tmp，绝不能是真实库 backend/db/data.db
if (!String(process.env.DB_PATH || '').startsWith('/tmp/')) {
  console.error('[致命] DB_PATH 不在 /tmp，拒绝运行以免污染真实库:', process.env.DB_PATH);
  process.exit(2);
}

// ---------- 直调路由处理器（与 order-benefits-idempotency-regression.cjs 同款）----------
function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path !== path) continue;
    if (!layer.route.methods[method]) continue;
    const handlers = layer.route.stack;
    return handlers[handlers.length - 1].handle;
  }
  throw new Error(`未找到处理器: ${method.toUpperCase()} ${path}`);
}
function mockRes() {
  const r = { statusCode: 200, body: null };
  r.status = (code) => { r.statusCode = code; return r; };
  r.json = (payload) => { r.body = payload; return r; };
  return r;
}
function mockReq(o) {
  return Object.assign({ headers: {}, params: {}, query: {}, body: {}, userRole: '', openid: '' }, o);
}

// ---------- 断言记录 ----------
let passed = 0, failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${ok ? '' : '  -> ' + detail}`);
}

// ---------- 管理员身份 ----------
// growth 三接口走 canGrowth → isAdminReq(req)，userRole='admin' 即通过。
// students 列表走 canViewStudents → hasPerm(getReqUser(req),'students')，必须给一个
// **真实存在于 users 表**的 admin openid（getReqUser 按 openid 回查用户表），
// 故用 _bootstrap 的 resolveStaffIdentities 动态解析 seed 夹具里的管理员身份。
const IDS = resolveStaffIdentities(db);
const ADMIN_OPENID = IDS.admin;
const asAdmin = (extra) => mockReq(Object.assign({ userRole: 'admin', openid: ADMIN_OPENID }, extra));

// ---------- 夹具 ----------
const t = now();
const DAY = 86400000;
const ins = (sql, ...p) => db.prepare(sql).run(...p);

const A_ID = 'stu_del_a';   // 待删除学员（判别项主体）
const B_ID = 'stu_del_b';   // 正常对照学员（全程不删）

/** 造学员：archived 显式置 0，避免依赖列默认值 */
function mkStudent(id, name, status) {
  ins(`INSERT OR IGNORE INTO students (id, name, status, archived, join_date, created_at, updated_at)
       VALUES (?, ?, ?, 0, '', ?, ?)`, id, name, status || 'active', t, t);
}
/**
 * 造一张「同时命中三个清单」的会员卡：
 *   · count 制 + remaining=3（≤ 默认阈值 5 且 > 0）→ 命中 low-classes
 *   · expires_at = now + 10 天（≤ 默认 warnIn 15 天，且在过期回溯窗口内）→ 命中 renewal
 *   · 卡有效 + 该学员无任何出勤 → churn 判定 daysSince=999 → risk=high → 命中 churn
 * 三张卡各自独立学员，互不影响「同一学员只保留最晚到期卡」的去重逻辑。
 */
function mkWarnCard(id, studentId, studentName) {
  ins(`INSERT OR IGNORE INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id,
         student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at,
         status, order_id, created_at, updated_at)
       VALUES (?, 'ct_del', '删除判别探针卡', 'count', ?, ?, 10, 3, 7, ?, ?, 'active', NULL, ?, ?)`,
    id, studentId, studentName, t - 5 * DAY, t + 10 * DAY, t, t);
}

mkStudent(A_ID, '删除判别学员A');
mkStudent(B_ID, '删除对照学员B');
mkWarnCard('mc_del_a', A_ID, '删除判别学员A');
mkWarnCard('mc_del_b', B_ID, '删除对照学员B');
// A 的家长绑定：删除时必须被清空（先插一条，否则「清空」是恒真的假绿）
ins(`INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at)
     VALUES (?, '删除判别学员A', 'A家长', 'wx_parent_del_a', '13900009999', '父亲', 1, ?)`, A_ID, t);

// ---------- 观测封装 ----------
function callGrowth(path, query) {
  const res = mockRes();
  getHandler(growthRouter, 'get', path)(asAdmin({ query: query || {} }), res);
  return res;
}
function callStudentsList(query) {
  const res = mockRes();
  getHandler(studentsRouter, 'get', '/')(asAdmin({ query: query || {} }), res);
  return res;
}
function callStudentDelete(id) {
  const res = mockRes();
  getHandler(studentsRouter, 'delete', '/:id')(asAdmin({ params: { id } }), res);
  return res;
}
/** 清单里是否含该学员（churn/renewal 用 studentId；low-classes 同时带 student_id） */
const inList = (res, id) => {
  const list = (res.body && res.body.data && res.body.data.list) || [];
  return list.some((x) => x.studentId === id || x.student_id === id);
};
const studentRow = (id) => db.prepare('SELECT id, status, archived FROM students WHERE id = ?').get(id);
const bindCountOf = (id) => db.prepare('SELECT COUNT(*) AS c FROM parent_bindings WHERE student_id = ?').get(id).c;

console.log('\n\x1b[1m=== 已删除学员排除回归测试（三预警清单 + 学员列表 + 迁移 020 回填）===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '（seed 夹具 + 本套件夹具）\n');

// ============================================================
// T0. 前置条件：调用确实没有被 403 拦下（否则后面全是假绿）
// ============================================================
console.log('\x1b[1m[T0] 前置条件：鉴权放行\x1b[0m');
{
  const c = callGrowth('/churn');
  rec('T0 GET /growth/churn 未被 403 拦下且成功返回（管理员身份生效）',
    c.statusCode !== 403 && c.body && c.body.code === 0,
    `status=${c.statusCode} body=${JSON.stringify(c.body)}`);

  const r = callGrowth('/renewal');
  rec('T0 GET /growth/renewal 未被 403 拦下且成功返回',
    r.statusCode !== 403 && r.body && r.body.code === 0,
    `status=${r.statusCode} body=${JSON.stringify(r.body)}`);

  const l = callGrowth('/low-classes');
  rec('T0 GET /growth/low-classes 未被 403 拦下且成功返回',
    l.statusCode !== 403 && l.body && l.body.code === 0,
    `status=${l.statusCode} body=${JSON.stringify(l.body)}`);

  const s = callStudentsList({ pageSize: 100 });
  rec('T0 GET /students 未被 403 拦下且成功返回（canViewStudents 拿到真实管理员身份）',
    s.statusCode !== 403 && s.body && s.body.code === 0,
    `status=${s.statusCode} body=${JSON.stringify(s.body)}`);

  // 用一个不存在的 id 调 DELETE：能走到 404 说明鉴权没把它拦在 403，
  // 且不会改动任何数据（handler 先查存在性、不存在直接 404）。
  const d = callStudentDelete('stu_never_exists');
  rec('T0 DELETE /students/:id 可直达处理器（不存在的 id 返回 404 而非 403）',
    d.statusCode === 404, `status=${d.statusCode} body=${JSON.stringify(d.body)}`);
}

// ============================================================
// T1. 前置：删除前 A、B 都命中三个清单
//     【护栏，非判别项】修复前后结果相同 —— 它的作用是钉死夹具的有效性，
//     否则 T3 的「A 不在清单」可能是清单为空导致的恒真假绿。
// ============================================================
console.log('\n\x1b[1m[T1] 前置：删除前 A 与 B 都在三个预警清单里（护栏）\x1b[0m');
{
  const churn = callGrowth('/churn');
  const renewal = callGrowth('/renewal');
  const low = callGrowth('/low-classes');

  rec('T1 删除前 A 出现在 churn 清单', inList(churn, A_ID), `churn=${JSON.stringify(churn.body)}`);
  rec('T1 删除前 B 出现在 churn 清单', inList(churn, B_ID), `churn=${JSON.stringify(churn.body)}`);
  rec('T1 删除前 A 出现在 renewal 清单', inList(renewal, A_ID), `renewal=${JSON.stringify(renewal.body)}`);
  rec('T1 删除前 B 出现在 renewal 清单', inList(renewal, B_ID), `renewal=${JSON.stringify(renewal.body)}`);
  rec('T1 删除前 A 出现在 low-classes 清单', inList(low, A_ID), `low=${JSON.stringify(low.body)}`);
  rec('T1 删除前 B 出现在 low-classes 清单', inList(low, B_ID), `low=${JSON.stringify(low.body)}`);
}

// ============================================================
// T2. 删除动作：archived 置 1、status 置 refunded、家长绑定清空
//     判别项只有 archived（HEAD 版 DELETE 不动 archived）；
//     status / parent_bindings 两条是护栏。
// ============================================================
console.log('\n\x1b[1m[T2] 删除动作：软删除写入的字段\x1b[0m');
{
  const res = callStudentDelete(A_ID);
  rec('T2 DELETE /students/:id 成功返回', res.body && res.body.code === 0, JSON.stringify(res.body));

  const row = studentRow(A_ID);
  // 判别力：HEAD 版 DELETE 只写 status，archived 仍为 0 → 本条失败。
  rec('T2 [判别] A.archived === 1（HEAD 版不动 archived，删除等于没删）',
    row && row.archived === 1, `archived=${row && row.archived}`);
  // 护栏：HEAD 版本就写 status='refunded'，修复前后同结果。
  rec('T2 [护栏] A.status === "refunded"', row && row.status === 'refunded', `status=${row && row.status}`);
  // 护栏：HEAD 版本就解绑家长。
  rec('T2 [护栏] A 的 parent_bindings 已清空（删除前确有 1 条）',
    bindCountOf(A_ID) === 0, `bindings=${bindCountOf(A_ID)}`);
}

// ============================================================
// T3. 核心判别项：删除后 A 从三个清单消失，且 B 仍在（不是把清单清空了）
// ============================================================
console.log('\n\x1b[1m[T3] 删除后：A 从三个清单消失，B 仍在（核心判别项）\x1b[0m');
{
  const churn = callGrowth('/churn');
  const renewal = callGrowth('/renewal');
  const low = callGrowth('/low-classes');

  // 判别力：HEAD 版 growth.js 三处查询没有 ACTIVE_STUDENT_SQL，A 仍会被列出 → 三条 FAIL。
  rec('T3 [判别] 删除后 A 不再出现在 churn 清单（HEAD 版仍在 → 销售打无效电话）',
    !inList(churn, A_ID), `churn=${JSON.stringify(churn.body)}`);
  rec('T3 [判别] 删除后 A 不再出现在 renewal 清单',
    !inList(renewal, A_ID), `renewal=${JSON.stringify(renewal.body)}`);
  rec('T3 [判别] 删除后 A 不再出现在 low-classes 清单',
    !inList(low, A_ID), `low=${JSON.stringify(low.body)}`);

  // 护栏：证明过滤没有误伤正常学员，也没有把整个清单清空。
  rec('T3 [护栏] B 仍在 churn 清单（证明清单未被整体清空）',
    inList(churn, B_ID), `churn=${JSON.stringify(churn.body)}`);
  rec('T3 [护栏] B 仍在 renewal 清单',
    inList(renewal, B_ID), `renewal=${JSON.stringify(renewal.body)}`);
  rec('T3 [护栏] B 仍在 low-classes 清单',
    inList(low, B_ID), `low=${JSON.stringify(low.body)}`);
}

// ============================================================
// T4. 学员列表：默认不含 A、含 B；archived=1 含 A 且展示状态为 refunded
// ============================================================
console.log('\n\x1b[1m[T4] 学员列表过滤与状态展示\x1b[0m');
{
  const def = callStudentsList({ pageSize: 100 });
  const defList = (def.body && def.body.data && def.body.data.list) || [];
  const defHasA = defList.some((x) => x.id === A_ID);
  const defHasB = defList.some((x) => x.id === B_ID);

  // 判别力：HEAD 版 archived 仍为 0 → A 仍在默认列表里 → FAIL。
  rec('T4 [判别] 默认查询（不传 archived）不含 A（HEAD 版仍在列表里）',
    !defHasA, `默认列表含 A；total=${def.body && def.body.data && def.body.data.total}`);
  rec('T4 [护栏] 默认查询含 B', defHasB, '默认列表不含 B —— 过滤误伤了正常学员');

  const arch = callStudentsList({ archived: '1', pageSize: 100 });
  const archList = (arch.body && arch.body.data && arch.body.data.list) || [];
  const aRow = archList.find((x) => x.id === A_ID);

  // 判别力：HEAD 版 archived=0，archived=1 查询根本查不到 A → FAIL。
  rec('T4 [判别] archived=1 查询含 A（HEAD 版 archived 仍为 0，查不到）',
    !!aRow, `archived=1 total=${arch.body && arch.body.data && arch.body.data.total}`);
  // 判别力：HEAD 版 mem_status 派生值（卡有效 → 'active'）会吞掉 status='refunded'。
  rec('T4 [判别] A 的展示 status === "refunded"（不能是 active/graduated 等卡派生值）',
    !!aRow && aRow.status === 'refunded',
    `status=${aRow && aRow.status}（HEAD 版会显示为 active）`);
}

// ============================================================
// T5. 迁移 020 回填历史已删学员 + 幂等
//     【本对照中的非判别项】对照只覆盖 growth.js / students.js，迁移文件被保留，
//     故两边同结果。它是「新功能正确性 + 幂等 + 不过度回填」的护栏。
// ============================================================
console.log('\n\x1b[1m[T5] 迁移 020 回填历史已删学员（archived=1）与幂等\x1b[0m');
{
  // 历史脏数据：status='refunded' 但 archived 仍为 0（修复前被删掉的学员）
  ins(`INSERT INTO students (id, name, status, archived, join_date, created_at, updated_at)
       VALUES ('stu_del_hist', '历史已删学员', 'refunded', 0, '', ?, ?)`, t, t);
  // 对照：正常在册学员（status='active', archived=0）不得被回填误伤
  ins(`INSERT INTO students (id, name, status, archived, join_date, created_at, updated_at)
       VALUES ('stu_del_hist_ok', '历史正常学员', 'active', 0, '', ?, ?)`, t, t);

  rec('T5 前置：历史脏数据确为 status=refunded 且 archived=0',
    studentRow('stu_del_hist').archived === 0, `archived=${studentRow('stu_del_hist').archived}`);

  migration020.up(db);
  rec('T5 [护栏] 迁移 020 把历史已删学员回填为 archived=1',
    studentRow('stu_del_hist').archived === 1, `archived=${studentRow('stu_del_hist').archived}`);
  rec('T5 [护栏] 迁移 020 不误伤正常学员（active/archived=0 保持原样）',
    studentRow('stu_del_hist_ok').archived === 0, `archived=${studentRow('stu_del_hist_ok').archived}`);

  // 幂等：重复执行不报错，且结果不变（只回填 archived=0 的行）
  let threw = null;
  try { migration020.up(db); } catch (e) { threw = e; }
  rec('T5 [护栏] 迁移 020 重复执行幂等（不报错、archived 仍为 1）',
    !threw && studentRow('stu_del_hist').archived === 1,
    threw ? `重复执行抛出: ${threw.message}` : `archived=${studentRow('stu_del_hist').archived}`);
}

// ============================================================
// 收尾：临时库由 _bootstrap.cjs 在进程退出时整目录删除
// ============================================================
console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
