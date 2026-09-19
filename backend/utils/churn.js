/**
 * 流失与召回规则 —— 全站流失阈值的唯一来源。
 *
 * 背景：流失判定此前在三处各自硬编码，同一学员在不同页面被判定为「流失」的时间
 * 并不一致（followups 14 天 / growth 30、60 天 / students 30 天）。现统一从
 * settings 表的 churn_rules 键读取；未配置、JSON 解析失败或字段非法时回退默认值，
 * 保证任何情况下调用方都能拿到一组可用的阈值。
 *
 * 两个阈值的语义：
 *   dormantDays —— 「沉睡」阈值（天）：连续未到课达到该天数即生成流失挽回跟进任务
 *   churnDays   —— 「流失」阈值（天）：连续未到课达到该天数即判定为流失学员
 *
 * 返回值每次都是新构造的对象（浅拷贝语义）：调用方就地修改不会污染默认值，
 * 也不会影响其他调用方。
 */
'use strict';

const DEFAULT_CHURN_RULES = Object.freeze({ dormantDays: 14, churnDays: 30 });

/**
 * 只接受正整数。非数字、NaN、Infinity、0、负数一律回退默认。
 * 0 虽不是负数，但会让全部学员瞬间被判为流失，与非法值同样危险，故一并兜底。
 */
function positiveIntOr(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * 读取「流失与召回规则」。
 * @param {import('better-sqlite3').Database} db 数据库实例
 * @returns {{ dormantDays: number, churnDays: number }}
 */
function getChurnRules(db) {
  // 先展开默认值，任何分支都返回这个独立副本
  const rules = { ...DEFAULT_CHURN_RULES };
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'churn_rules'").get();
    if (!row || !row.value) return rules;
    let parsed = null;
    try {
      parsed = JSON.parse(row.value);
    } catch (e) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rules;
    rules.dormantDays = positiveIntOr(parsed.dormantDays, DEFAULT_CHURN_RULES.dormantDays);
    rules.churnDays = positiveIntOr(parsed.churnDays, DEFAULT_CHURN_RULES.churnDays);
  } catch (e) {
    // settings 表不可用等异常：静默回退默认，绝不阻断业务
  }
  return rules;
}

module.exports = { getChurnRules, DEFAULT_CHURN_RULES };
