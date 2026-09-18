/**
 * 自动定时数据库备份模块
 *
 * 使用 better-sqlite3 的 backup API 创建一致性快照，
 * 按配置保留最近 N 份备份，超出自动清理最旧的。
 *
 * 备份文件存放于 backend/backups/ 目录，文件名格式：
 *   backup_YYYY-MM-DD_HHmmss.db
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../db');

// 备份目录跟随 DB_PATH 所在目录：
// Docker/自定义数据目录下，备份与数据库同落一个卷，重建容器不丢备份
// （旧实现固定 backend/backups，容器内属可写层，README「数据可恢复」卖点失效）。
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'db', 'data.db');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');

// 异地副本目录（可选）：本地备份校验通过后复制一份过去，规避「备份与数据库同盘，
// 单盘损坏即全丢」。未配置时该特性完全关闭，不影响任何既有行为。
const OFFSITE_DIR = process.env.BACKUP_OFFSITE_DIR
  ? path.resolve(process.env.BACKUP_OFFSITE_DIR)
  : '';

// 备份文件统一前缀（backup_ 为定时/手动备份；restore-backup- 为整库还原前的安全网备份）
const BACKUP_PREFIXES = ['backup_', 'restore-backup-'];
const isBackupFile = (f) => f.endsWith('.db') && BACKUP_PREFIXES.some((p) => f.startsWith(p));

// 确保备份目录存在
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * 校验备份文件是否可用（坏备份不得冒充成功）
 *
 * - .db：用 better-sqlite3 独立打开并执行 PRAGMA integrity_check，
 *   仅当返回 'ok' 才通过；打开失败 / 结果非 ok 均判定为坏备份。
 * - 其他归档：退化为「存在 + 文件大小 > 0」的基本校验。
 *
 * @returns {{ ok: boolean, size?: number, error?: string }}
 */
function verifyBackupFile(filepath) {
  try {
    if (!fs.existsSync(filepath)) return { ok: false, error: '备份文件不存在' };

    const stat = fs.statSync(filepath);
    if (stat.size <= 0) return { ok: false, error: '备份文件大小为 0' };

    if (filepath.endsWith('.db')) {
      const probe = new Database(filepath, { readonly: true, fileMustExist: true });
      try {
        const result = probe.pragma('integrity_check', { simple: true });
        if (result !== 'ok') return { ok: false, error: `integrity_check 未通过: ${result}` };
      } finally {
        probe.close(); // 必须关闭，否则后续 unlink 可能失败
      }
    }

    return { ok: true, size: stat.size };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 把已校验通过的备份复制到异地目录（fail-safe）
 *
 * 未配置 BACKUP_OFFSITE_DIR 时直接跳过；目录不存在会自动创建；
 * 任何失败（不可写 / 磁盘满等）只打日志，绝不抛出，不影响本地备份与业务主流程。
 */
function copyToOffsite(filepath, filename) {
  if (!OFFSITE_DIR) return;
  try {
    if (!fs.existsSync(OFFSITE_DIR)) fs.mkdirSync(OFFSITE_DIR, { recursive: true });
    const dest = path.join(OFFSITE_DIR, filename);
    fs.copyFileSync(filepath, dest);
    console.log(`[Backup] 异地副本已写入: ${dest}`);
  } catch (e) {
    console.error('[Backup] 异地副本失败（不影响本地备份）:', e.message);
  }
}

/**
 * 获取备份配置（从 settings 表读取，带默认值）
 */
function getBackupConfig() {
  const defaults = {
    enabled: true,
    frequency: 'daily',   // daily | every12h | every6h
    retention: 30,         // 保留最近 30 份备份
  };
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get();
    if (row && row.value) {
      return { ...defaults, ...JSON.parse(row.value) };
    }
  } catch (e) { /* 使用默认值 */ }
  return defaults;
}

/**
 * 执行一次数据库备份
 * @returns {{ success: boolean, filename?: string, size?: number, error?: string }}
 */
async function createBackup() {
  try {
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const filename = `backup_${ts}.db`;
    const filepath = path.join(BACKUP_DIR, filename);

    // 使用 better-sqlite3 v11+ 的 backup API（在线热备份，不阻塞读写，返回 Promise）
    await db.backup(filepath);

    // 完整性校验：坏备份不得冒充成功。校验不通过则删除该文件并返回失败。
    const check = verifyBackupFile(filepath);
    if (!check.ok) {
      console.error(`[Backup] 完整性校验失败，判定为坏备份: ${filename} - ${check.error}`);
      try { fs.unlinkSync(filepath); } catch (e) { /* 忽略删除失败 */ }
      return { success: false, error: `完整性校验失败: ${check.error}` };
    }

    const size = check.size;
    console.log(`[Backup] 数据库备份完成: ${filename} (${(size / 1024 / 1024).toFixed(2)} MB) 完整性校验通过`);

    // 异地副本（fail-safe，失败不影响主流程）
    copyToOffsite(filepath, filename);

    // 清理旧备份（本地 + 异地）
    cleanOldBackups();

    return { success: true, filename, size };
  } catch (err) {
    console.error('[Backup] 备份失败:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 清理指定目录中超出保留数量的旧备份（通用，可作用于本地或异地目录）
 */
function cleanDir(dir, retention) {
  let files;
  try {
    files = fs.readdirSync(dir)
      .filter(isBackupFile)
      .map(f => ({
        name: f,
        path: path.join(dir, f),
        mtime: fs.statSync(path.join(dir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime); // 新→旧
  } catch (e) {
    console.error(`[Backup] 读取备份目录失败 ${dir}:`, e.message);
    return;
  }

  if (files.length <= retention) return;

  for (const f of files.slice(retention)) {
    try {
      fs.unlinkSync(f.path);
      console.log(`[Backup] 清理旧备份: ${f.path}`);
    } catch (e) { /* 忽略删除失败 */ }
  }
}

/**
 * 清理超出保留数量的旧备份（本地备份目录 + 异地副本目录）
 */
function cleanOldBackups() {
  const config = getBackupConfig();
  const retention = Math.max(1, config.retention || 30);

  cleanDir(BACKUP_DIR, retention);
  if (OFFSITE_DIR && OFFSITE_DIR !== BACKUP_DIR) cleanDir(OFFSITE_DIR, retention);
}

/**
 * 列出所有备份
 */
function listBackups() {
  const dir = BACKUP_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(isBackupFile)
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return {
        filename: f,
        size: stat.size,
        createdAt: stat.mtime.getTime(),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 删除指定备份
 */
function deleteBackup(filename) {
  // 文件名白名单：仅接受本系统生成的 backup_<时间戳>.db / restore-backup-<时间戳>.db 格式，
  // 防止 ../ 遍历或与备份目录同前缀的兄弟目录（startsWith 单独判断挡不住）
  if (typeof filename !== 'string' || !/^(backup_[\w-]+|restore-backup-[\w-]+)\.db$/.test(filename)) throw new Error('非法路径');
  const filepath = path.join(BACKUP_DIR, filename);
  const resolved = path.resolve(filepath);
  if (resolved !== path.resolve(BACKUP_DIR, filename) || !resolved.startsWith(path.resolve(BACKUP_DIR) + path.sep)) {
    throw new Error('非法路径');
  }
  if (!fs.existsSync(resolved)) throw new Error('备份文件不存在');
  fs.unlinkSync(resolved);
  return true;
}

/**
 * 启动定时备份调度
 * 根据配置的频率自动执行备份
 */
function startScheduledBackup() {
  const config = getBackupConfig();
  if (!config.enabled) {
    console.log('[Backup] 自动备份已禁用');
    return;
  }

  // 计算备份间隔（毫秒）
  const intervals = {
    daily: 24 * 60 * 60 * 1000,
    every12h: 12 * 60 * 60 * 1000,
    every6h: 6 * 60 * 60 * 1000,
  };
  const interval = intervals[config.frequency] || intervals.daily;

  // 计算到下次执行的时间（默认每天凌晨 2:00 执行）
  function scheduleNext() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(2, 0, 0, 0); // 凌晨 2 点
    if (config.frequency === 'every12h') {
      next.setHours(now.getHours() < 2 || now.getHours() >= 14 ? 2 : 14, 0, 0, 0);
    } else if (config.frequency === 'every6h') {
      const nextHour = Math.ceil(now.getHours() / 6) * 6;
      next.setHours(nextHour >= 24 ? 0 : nextHour, 0, 0, 0);
    }
    if (next <= now) next.setTime(next.getTime() + interval);

    const delay = next.getTime() - now.getTime();
    console.log(`[Backup] 下次备份: ${next.toLocaleString('zh-CN')}（${Math.round(delay / 1000 / 60)}分钟后）`);

    setTimeout(() => {
      const cfg = getBackupConfig();
      if (cfg.enabled) {
        // createBackup 内部已捕获，此处再兜一层，防止定时器回调里出现未处理拒绝
        Promise.resolve(createBackup()).catch(e => console.error('[Backup] 定时备份异常:', e.message));
      }
      scheduleNext();
    }, delay);
  }

  // 启动时延迟 60 秒执行一次初始备份（确保服务完全启动）
  setTimeout(() => {
    const cfg = getBackupConfig();
    if (cfg.enabled) {
      console.log('[Backup] 执行启动备份...');
      createBackup();
    }
  }, 60 * 1000);

  scheduleNext();
}

module.exports = {
  getBackupConfig,
  createBackup,
  listBackups,
  deleteBackup,
  startScheduledBackup,
  BACKUP_DIR,
};
