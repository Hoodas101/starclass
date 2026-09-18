/**
 * 测试库引导 —— 后端 HTTP 套件的唯一入口（full-system / p2-fixes / card-expiry 共用）。
 *
 * 为什么必须唯一：这三套件历史上各自复制了一份「本地快照 vs CI 夹具」双分支引导，
 * 三份已经分叉（环境变量名不同、是否支持强制夹具不同、是否额外解析 teacher_id 不同）。
 * 后果是**本地绿与 CI 绿测的不是同一套代码路径**，实测差异包括：
 *   - 教练身份：本地快照取 phone_13800000011（permissions 显式存为
 *     ["students","schedule","checkin","leave"]）；CI 夹具取 wx_teacher_001
 *     （permissions 为空串 → 回退 DEFAULT_PERMS.coach，多出一个 coachstats）。
 *     于是同一份 403 权限矩阵在两条路径上验证的是**两套不同的权限配置**。
 *   - 排课 teacher_id：本地快照写入 phone_13800000011，而 teachers 表中并无该 id
 *     （含 phone_ 前缀的 teachers 行为 0），CI 夹具则写入真实的 teacher_001。
 *
 * 回归套件的职责是发现**代码**回归，因此输入必须固定：唯一合法的输入是 seed 夹具。
 * 真实库快照是可变输入，无法区分「代码改坏了」与「本地数据变了」，绿了也不代表对方绿。
 *
 * 用法（必须在 require('../db') / require('./server') 之前调用）：
 *   const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
 *   bootstrap('/tmp/edu-test');
 *
 * 环境变量：
 *   KEEP_TEST_DB=1  保留临时库以便排查（默认在进程退出时删除）
 */
'use strict';

const path = require('path');
const fs = require('fs');

/**
 * 建一个干净的夹具库，并把 process.env.DB_PATH 指向它。
 * @param {string} dir 临时库目录（各套件使用不同目录，避免相互覆盖）
 * @returns {string} 实际的 DB_PATH
 */
function bootstrap(dir) {
  process.env.NODE_ENV = 'test';
  // 整目录重建，而不是逐个 unlink「已存在的」文件：旧实现只覆盖快照里存在的文件，
  // 上一轮遗留的 -wal / -shm 不会被清掉，会与新的 data.db 组成不确定输入。
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  process.env.DB_PATH = path.join(dir, 'data.db');

  // db/index.js 在 require 时自动建表并跑完全部迁移；seed 随后灌入确定性夹具数据。
  // 必须在 DB_PATH 设置之后调用，否则会落到真实库上。
  require('../db/seed')();

  // 收尾清理：默认删除临时库，避免 /tmp 长期堆积与跨轮次污染。
  // Windows 上删除被打开的文件会失败，因此尽力而为，不阻断测试结果。
  if (process.env.KEEP_TEST_DB !== '1') {
    process.on('exit', () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
    });
  }
  return process.env.DB_PATH;
}

/**
 * 按角色解析夹具中的员工身份。
 * 夹具 openid 是 wx_ 前缀（而非快照的 phone_ 前缀），必须动态解析，不能硬编码。
 * 解析不到即视为夹具损坏 —— 直接失败，避免拿不存在的身份继续跑出一片假绿。
 * @param {import('better-sqlite3').Database} db
 * @returns {{admin:string, coach:string, sales:string}}
 */
function resolveStaffIdentities(db) {
  const out = {};
  for (const role of ['admin', 'coach', 'sales']) {
    const row = db.prepare(
      "SELECT openid FROM users WHERE role = ? AND status = 'active' ORDER BY created_at LIMIT 1"
    ).get(role);
    if (!row) {
      console.error(`[TestBootstrap] 夹具缺少 ${role} 角色用户 —— seed 未按预期生成，无法继续。`);
      process.exit(2);
    }
    out[role] = row.openid;
  }
  return out;
}

module.exports = { bootstrap, resolveStaffIdentities };
