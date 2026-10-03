/**
 * 队列 worker：认领 → 派发到处理器 → 完成 / 失败退避
 *
 * 处理器通过 registerHandler(type, asyncFn) 注册；asyncFn(payload, job) 返回结果（可 JSON 序列化）。
 * 启动方式（可选，默认关闭以免干扰现有进程）：
 *   ENABLE_JOB_WORKER=true node server.js
 *
 * 设计约束（参照 DESIGN-v3 §7.2 智能逻辑在业务层）：
 *   - worker 只做"认领 + 派发 + 状态机"，不含任何业务规则；
 *   - 业务规则全部在 utils/reminders 等模块，worker 仅调用。
 */
const { claimJobs, completeJob, failJob, reclaimExpired } = require('./queue');
const { generateClassReminders, generateLowClassReminders, generateRenewalReminders } = require('./reminders');
const { recognizeTimeCardRevenue } = require('./revenue');

const handlers = new Map();
function registerHandler(type, fn) {
  handlers.set(type, fn);
}
function getHandler(type) {
  return handlers.get(type);
}

// 注册提醒类处理器（与现有提醒逻辑共用 utils/reminders 的纯函数，单一真相源）
registerHandler('class_reminder', async () => generateClassReminders(Date.now()));
registerHandler('low_class_reminder', async () => generateLowClassReminders(Date.now()));
registerHandler('renewal_reminder', async () => generateRenewalReminders(Date.now()));

/**
 * 每日维护任务（与 server.js 里的 expireOverdueCards 等日任务并列）。
 *
 * 目前只有一项：时效卡收入按时间摊销结转（P1-A3）。时效卡学员到课不产生
 * deduction_logs，扣课路径的「扣课即结转」够不到它们，若不在日任务里摊销，
 * recognizedRevenue 永远缺时效卡部分、合同负债被系统性高估。
 *
 * 幂等：recognizeTimeCardRevenue 内部同卡只保留一行、重复运行 delta ≤ 0 时不写入，
 * 因此多实例并存 / 重复调度都安全。
 *
 * 注意：本函数挂在 worker 启动流程上（ENABLE_JOB_WORKER=true 时生效）。
 * server.js 的日任务清单当前未调用它 —— 需要在 server.js 的日调度里
 * 增加 `require('./utils/worker').runDailyMaintenance()`（server.js 不在本次改动范围内，
 * 已在交付报告中标注为跨文件事项）。
 *
 * @param {number} [nowMs] 观察时间戳，便于测试控制
 * @returns {{recognized:number, amount:number}}
 */
function runDailyMaintenance(nowMs) {
  const r = recognizeTimeCardRevenue(nowMs);
  if (r.recognized > 0) {
    console.log(`[Revenue] 时效卡摊销结转 ${r.recognized} 张，本次新增确认收入 ${r.amount} 元`);
  }
  return r;
}

let controller = null;

async function processOne(db, job, { backoffMs }) {
  const handler = handlers.get(job.type);
  if (!handler) {
    // 无处理器：直接标记失败，避免无限重试空转
    failJob(db, job.id, new Error(`no handler registered for type "${job.type}"`), { now: Date.now(), backoffMs: 0 });
    return;
  }
  try {
    const payload = job.payload ? JSON.parse(job.payload) : null;
    const result = await handler(payload, job);
    completeJob(db, job.id, result);
  } catch (err) {
    failJob(db, job.id, err, { now: Date.now(), backoffMs });
  }
}

/**
 * 执行一轮：回收租约过期的任务，认领一批并处理。
 * @returns {number} 本轮处理的任务数
 */
async function runOnce(db, { batchSize = 5, leaseMs = 60000, backoffMs = 60000, now = Date.now() } = {}) {
  reclaimExpired(db, now);
  const jobs = claimJobs(db, { limit: batchSize, now, leaseMs });
  for (const job of jobs) {
    await processOne(db, job, { backoffMs });
  }
  return jobs.length;
}

/**
 * 启动常驻 worker（轮询）。同一进程仅一个实例。
 * @returns {{ stop: () => void } | null}
 */
function startWorker(db, { intervalMs = 5000, batchSize = 5, leaseMs = 60000, backoffMs = 60000 } = {}) {
  if (controller) return controller; // 已启动，避免重复
  let stopped = false;
  let timer = null;
  let dailyTimer = null;

  async function tick() {
    if (stopped) return;
    try {
      await runOnce(db, { batchSize, leaseMs, backoffMs });
    } catch (e) {
      console.error('[worker] tick error:', e && e.message);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  timer = setTimeout(tick, 0);
  // 每日维护：启动时先跑一次（保证首次摊销及时生效），此后每 24h 一次。
  // 单实例内不会重复；跨实例由 recognizeTimeCardRevenue 的幂等保证安全。
  const runMaintenance = () => {
    try { runDailyMaintenance(); } catch (e) { console.error('[worker] daily maintenance error:', e && e.message); }
  };
  runMaintenance();
  dailyTimer = setInterval(runMaintenance, 24 * 3600 * 1000);

  controller = {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (dailyTimer) clearInterval(dailyTimer);
      timer = null;
      dailyTimer = null;
      controller = null;
    },
  };
  return controller;
}

function stopWorker() {
  if (controller) controller.stop();
}

module.exports = {
  startWorker,
  stopWorker,
  registerHandler,
  getHandler,
  runOnce,
  runDailyMaintenance,
};
