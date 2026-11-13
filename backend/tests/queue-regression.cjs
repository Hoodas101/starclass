/**
 * 队列（008_job_queue）隔离回归测试
 * 运行：DB_PATH=/tmp/queue_test.db node tests/queue-regression.cjs
 * 不依赖 npm run build，使用隔离临时库 + 真实 migrated schema + 真实 handler。
 */
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || '/tmp/queue_test.db';
// 必须导出给 db/index.js 读取，否则会静默回退到真实 data.db 并污染业务数据
process.env.DB_PATH = DB_PATH;
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { fs.rmSync(p); } catch (e) { /* not exist */ }
}

const db = require('../db'); // 触发 init + 迁移（含 008_job_queue）
// 测试库关闭外键约束，便于构造最小种子（schedules.course_id 等），不影响队列逻辑验证
db.pragma('foreign_keys = OFF');

const queue = require('../utils/queue');
const worker = require('../utils/worker');

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name}`); failures++; }
}
// 每个小节开始前清空 jobs，避免相互污染（队列逻辑本身无状态依赖）
function resetJobs() { db.prepare('DELETE FROM jobs').run(); }

(async () => {
  // ---------- A. enqueue 基础 ----------
  const idA = queue.enqueue(db, { type: 'demo', payload: { x: 1 } });
  const jobA = queue.getJob(db, idA);
  check('A. enqueue 生成 pending 任务', jobA && jobA.status === 'pending');
  check('A. payload 正确序列化', jobA && JSON.parse(jobA.payload).x === 1);
  check('A. due_at 默认为当前', jobA && Math.abs(jobA.due_at - Date.now()) < 5000);
  resetJobs();

  // ---------- B/C/D. 原子认领（等价 SKIP LOCKED）+ 防重复 + 完成 ----------
  const idB1 = queue.enqueue(db, { type: 't', dueAt: Date.now() });
  const idB2 = queue.enqueue(db, { type: 't', dueAt: Date.now() });
  const idB3 = queue.enqueue(db, { type: 't', dueAt: Date.now() });
  const claimed = queue.claimJobs(db, { limit: 10, now: Date.now() });
  check('B. 一次认领 3 个（隔离后）', claimed.length === 3);
  check('B. 认领后状态为 processing', claimed.every((j) => j.status === 'processing'));
  check('B. attempts 自增为 1', claimed.every((j) => j.attempts === 1));
  const claimedAgain = queue.claimJobs(db, { limit: 10, now: Date.now() });
  check('C. 已认领任务不会被二次认领（0 个）', claimedAgain.length === 0);
  queue.completeJob(db, idB1, { ok: true });
  const jobDone = queue.getJob(db, idB1);
  check('D. 完成后状态 done', jobDone.status === 'done');
  check('D. 结果被记录', jobDone.result && JSON.parse(jobDone.result).ok === true);
  const claimedAfterDone = queue.claimJobs(db, { limit: 10, now: Date.now() });
  check('D. done 任务不再被认领', claimedAfterDone.every((j) => j.id !== idB1));
  queue.completeJob(db, idB2); queue.completeJob(db, idB3);
  resetJobs();

  // ---------- E. 失败退避（attempts < max → 回到 pending，due_at 推后）----------
  const t0 = Date.now();
  const idE = queue.enqueue(db, { type: 't', dueAt: t0 });
  queue.claimJobs(db, { limit: 5, now: t0 });
  queue.failJob(db, idE, new Error('temp fail'), { now: t0, backoffMs: 60000 });
  const jobE = queue.getJob(db, idE);
  check('E. 失败后回到 pending', jobE.status === 'pending');
  check('E. 退避后 due_at 推后', jobE.due_at === t0 + 60000);
  check('E. attempts 保持 1', jobE.attempts === 1);
  const reclaimable = queue.claimJobs(db, { limit: 5, now: t0 + 70000 });
  check('E. 退避到期后可重新认领', reclaimable.some((j) => j.id === idE));
  resetJobs();

  // ---------- F. 失败达上限 → failed ----------
  const idF = queue.enqueue(db, { type: 't', dueAt: t0, maxAttempts: 1 });
  queue.claimJobs(db, { limit: 5, now: t0 });
  queue.failJob(db, idF, new Error('final fail'), { now: t0 });
  const jobF = queue.getJob(db, idF);
  check('F. 达 max_attempts 后状态 failed', jobF.status === 'failed');
  check('F. 记录 last_error', jobF.last_error && jobF.last_error.includes('final fail'));
  resetJobs();

  // ---------- G. due_at 排序：未到期不可认领 ----------
  const futureId = queue.enqueue(db, { type: 't', dueAt: t0 + 100000 });
  const earlyClaim = queue.claimJobs(db, { limit: 5, now: t0 });
  check('G. 未来任务未到期不被认领', !earlyClaim.some((j) => j.id === futureId));
  const laterClaim = queue.claimJobs(db, { limit: 5, now: t0 + 200000 });
  check('G. 到期后可被认领', laterClaim.some((j) => j.id === futureId));
  resetJobs();

  // ---------- H. 租约过期回收（worker 崩溃保护）----------
  const idH = queue.enqueue(db, { type: 't', dueAt: t0, leaseMs: 60000 });
  queue.claimJobs(db, { limit: 5, now: t0, leaseMs: 60000 }); // claimed_at = t0
  const reclaimed = queue.reclaimExpired(db, t0 + 70000); // t0 + 60000 < t0+70000 → 过期
  check('H. 租约过期被回收（隔离后 1 个）', reclaimed === 1);
  const jobH = queue.getJob(db, idH);
  check('H. 回收后回到 pending', jobH.status === 'pending');
  check('H. 回收后 claimed_at 清空', jobH.claimed_at === null);
  resetJobs();

  // ---------- I. 自定义处理器：成功派发（必须 await runOnce）----------
  let okRan = 0;
  worker.registerHandler('test_ok', async (payload) => { okRan++; return { echo: payload.v }; });
  const idI = queue.enqueue(db, { type: 'test_ok', payload: { v: 42 }, dueAt: Date.now() });
  await worker.runOnce(db, { now: Date.now() });
  const jobI = queue.getJob(db, idI);
  check('I. 处理器被调用', okRan === 1);
  check('I. 成功后状态 done', jobI.status === 'done');
  check('I. 返回值写入 result', jobI.result && JSON.parse(jobI.result).echo === 42);
  resetJobs();

  // ---------- J. 自定义处理器：失败重试 → failed ----------
  let flakyCount = 0;
  worker.registerHandler('test_flaky', async () => { flakyCount++; throw new Error('boom'); });
  const idJ = queue.enqueue(db, { type: 'test_flaky', dueAt: t0, maxAttempts: 3, leaseMs: 60000 });
  await worker.runOnce(db, { now: t0 });            // attempt 1 → pending, due t0+60000
  await worker.runOnce(db, { now: t0 + 70000 });   // attempt 2 → pending, due t0+120000
  await worker.runOnce(db, { now: t0 + 130000 });  // attempt 3 → failed
  const jobJ = queue.getJob(db, idJ);
  check('J. 处理器被调用 3 次', flakyCount === 3);
  check('J. 达上限后状态 failed', jobJ.status === 'failed');
  check('J. attempts 累计为 3', jobJ.attempts === 3);
  resetJobs();

  // ---------- K. 真实集成：class_reminder 端到端 ----------
  const d = new Date(Date.now() + 3600000);
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // join_date 是 TEXT 列且全站按 'YYYY-MM-DD' 比较筛选，夹具也必须写日期串：
  // 此前直接绑 Date.now() 会落成 '1794509019310.0'（REAL），既与生产写入路径不一致，
  // 也会让 data-consistency-check 的 join_date 巡检误报存量脏数据。
  db.prepare("INSERT INTO students (id, name, status, join_date, created_at, updated_at) VALUES (?,?,?,?,?,?)").run('stu_q', 'Q', 'active', dateStr, Date.now(), Date.now());
  db.prepare("INSERT INTO parent_bindings (student_id, parent_openid, is_main) VALUES (?,?,?)").run('stu_q', 'openid_q', 1);
  db.prepare("INSERT INTO schedules (id, course_id, course_name, status, date, start_time, end_time, classroom_name, teacher_name) VALUES (?,?,?,?,?,?,?,?,?)").run('sch_q', 'course_q', '篮球', 'scheduled', dateStr, timeStr, timeStr, '馆', '王');
  db.prepare("INSERT INTO enrollments (id, schedule_id, student_id, course_id, status) VALUES (?,?,?,?,?)").run('enr_q', 'sch_q', 'stu_q', 'course_q', 'active');

  const idK = queue.enqueue(db, { type: 'class_reminder', dueAt: Date.now() });
  await worker.runOnce(db, { now: Date.now() });
  const jobK = queue.getJob(db, idK);
  check('K. class_reminder 任务成功完成', jobK.status === 'done');
  const note = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND template_id LIKE ?").get('openid_q', 'class_sch_q_%');
  check('K. 真实提醒已写入通知表（处理器端到端）', !!note);
  resetJobs();

  console.log(`\njobs 表残留 pending: ${db.prepare("SELECT COUNT(*) c FROM jobs WHERE status='pending'").get().c}`);
  console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})();
