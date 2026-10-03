'use strict';

/**
 * D3 时区确定性工具
 *
 * 业务日期统一按 Asia/Shanghai（UTC+8，无夏令时）解释，与部署形态解耦：
 * server.js 启动时已强制 process.env.TZ = 'Asia/Shanghai'，无论裸机还是容器，
 * Date 的行为都一致，消除「跨日统计错乱」。此模块供展示层集中格式化，
 * 不依赖宿主时区。
 */

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

function businessDate(ts) {
  const d = new Date((ts == null ? Date.now() : ts) + SHANGHAI_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatShanghai(ts, withTime) {
  const d = new Date((ts == null ? Date.now() : ts) + SHANGHAI_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (!withTime) return date;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

module.exports = { businessDate, formatShanghai, SHANGHAI_OFFSET_MS };
