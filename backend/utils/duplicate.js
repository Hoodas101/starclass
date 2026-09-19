/**
 * 成员建档查重 —— 防止同一人被录成两条。
 *
 * 为什么值得单独做：微型机构最典型的无效操作就是「同一个孩子被录两遍」
 * （换个人接待、隔几周又来一次、线索转成交时没先看已有档案）。
 * 后果不是多一条记录那么简单 —— 课时、积分、订单、考勤会全部裂成两份，
 * 而且几乎无法自动合并（两边都可能已产生消费记录），只能人工核对返工。
 * 这直接对应「减少返工和重复录入」的要求。
 *
 * 判据分两级：
 *   strong —— 家长手机号相同。手机号是家长登录凭据，同一号码基本可确定同一家庭，
 *             **构成拦截**（返回给前端由用户确认后才可继续）。
 *   weak   —— 仅同名。小机构同名并不罕见，只作提示，**不拦截**。
 */
'use strict';

const db = require('../db');

const PHONE_RE = /^1[3-9]\d{9}$/;

function normalizeName(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, '');
}

/**
 * 手机号规范化 —— 全站唯一实现（建档查重与批量导入共用）。
 * 从 Excel 复制过来的号码常带空格、横线、括号、全角数字或 +86 区号，
 * 直接拿原始串跑 `^1[3-9]\d{9}$` 会把这类行整行判为「没有手机号」。
 * 这里统一清洗为纯数字的大陆手机号串；无法识别时返回清洗结果（可能是空串或非 11 位），
 * 由调用方用 PHONE_RE 自行判定是否可用。
 * @param {string} v 原始号码
 * @returns {string} 清洗后的纯数字串
 */
function normalizePhone(v) {
  return String(v == null ? '' : v)
    // 全角数字（０-９）转半角，避免被下面的 \D 直接抹掉
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    // 去掉空格、横线、括号、加号等一切非数字字符
    .replace(/\D/g, '')
    // 去掉国际区号 0086 / 86。仅在去掉后正好是合法 11 位手机号时才去，
    // 避免把 86 开头的座机等其他号码误截断成看似合法的手机号。
    .replace(/^0{0,2}86(?=1[3-9]\d{9}$)/, '');
}

/**
 * 查找可能与待建档案重复的成员
 * @param {object} args
 * @param {string} args.name   待建档案姓名
 * @param {string} args.phone  待建档案家长手机号
 * @param {string} [args.excludeId] 排除自身（更新场景）
 * @returns {{
 *   list: Array<{id:string, member_no:string, name:string, archived:number,
 *                phone:string|null, reason:string, strength:'strong'|'weak'}>,
 *   hasStrong: boolean
 * }}
 */
function findDuplicateStudents({ name, phone, excludeId } = {}) {
  const nm = normalizeName(name);
  const ph = normalizePhone(phone);
  const list = [];
  const seen = new Set();

  // ── 强匹配：家长手机号相同 ──
  if (PHONE_RE.test(ph)) {
    const rows = db.prepare(`
      SELECT DISTINCT s.id, s.member_no, s.name, s.archived, pb.parent_phone AS phone
        FROM students s
        JOIN parent_bindings pb ON pb.student_id = s.id
       WHERE pb.parent_phone = ?
    `).all(ph);
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      list.push({
        id: r.id,
        member_no: r.member_no || '',
        name: r.name || '',
        archived: Number(r.archived) || 0,
        phone: r.phone || ph,
        reason: `家长手机号 ${ph} 已被该成员使用`,
        strength: 'strong',
      });
    }
  }

  // ── 弱匹配：同名（仅提示，不拦截）──
  if (nm) {
    const rows = db.prepare(`
      SELECT s.id, s.member_no, s.name, s.archived,
             (SELECT pb.parent_phone FROM parent_bindings pb
               WHERE pb.student_id = s.id AND pb.is_main = 1 LIMIT 1) AS phone
        FROM students s
       WHERE s.name = ?
    `).all(nm);
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      list.push({
        id: r.id,
        member_no: r.member_no || '',
        name: r.name || '',
        archived: Number(r.archived) || 0,
        phone: r.phone || null,
        reason: '存在同名成员（小机构同名较常见，请人工确认）',
        strength: 'weak',
      });
    }
  }

  const filtered = excludeId ? list.filter((x) => x.id !== excludeId) : list;
  return { list: filtered, hasStrong: filtered.some((x) => x.strength === 'strong') };
}

module.exports = { findDuplicateStudents, normalizeName, normalizePhone, PHONE_RE };
