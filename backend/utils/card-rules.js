/**
 * 订阅卡规则中心 —— 全站唯一读取入口。
 *
 * 为什么要有这一层：顺延起点、周期锚定、退费公式这三件事**没有唯一正确答案**，
 * 取决于机构的经营习惯与跟家长的沟通方式。写死在代码里等于替机构做经营决策；
 * 散在多个路由里各读一次，则必然出现「设置页改了 A、某条路径还在读旧值」。
 *
 * 设计约束：
 *   1. 读不到 / 读坏了 / 字段缺失 → 一律回落默认值，**绝不因为配置损坏而放行**；
 *   2. 保存时逐字段校验类型与取值范围，非法值丢弃并保留原值；
 *   3. 按组浅合并 —— 前端只提交「暂停」这一组时，不得把「顺延」「退费」冲成空。
 *      （这是设置页的历史通病：任何一处只传半截对象就会覆盖整组配置。）
 */
const db = require('../db');

const DEFAULTS = {
  defer: {
    enabled: true,          // 顺延总开关；关闭后下单传 defer 也按立即生效处理（并回 warnings）
    startAnchor: 'day',     // day = 旧卡到期次日 00:00；exact = 旧卡到期时刻 + 1ms
    crossScope: false,      // 是否允许不同科目的卡排队（默认各算各的）
    allowActivateNow: true, // 是否允许把待生效的顺延卡提前激活
  },
  period: {
    // 周/月限次的周期切分起点。natural = 自然周/月（存量口径，保留兼容）
    defaultAnchor: 'activated',
  },
  refund: {
    formula: '',            // 空 = 用内置默认公式（与改造前行为一致）
    allowPartial: true,     // 是否允许中途部分退款
  },
};

const ANCHORS = ['natural', 'activated', 'first_use'];
const START_ANCHORS = ['day', 'exact'];

function readRaw() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'card_rules'").get();
    if (!row || !row.value) return {};
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    // 配置损坏时回落默认，且留下痕迹 —— 静默吞掉会让"改不生效"无从排查
    console.warn('[card-rules] settings.card_rules 解析失败，使用默认值:', e && e.message);
    return {};
  }
}

/** 逐字段归一：类型不对或超出取值范围的值直接丢弃，保留默认 */
function normalizeDefer(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULTS.defer };
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (START_ANCHORS.includes(src.startAnchor)) out.startAnchor = src.startAnchor;
  if (typeof src.crossScope === 'boolean') out.crossScope = src.crossScope;
  if (typeof src.allowActivateNow === 'boolean') out.allowActivateNow = src.allowActivateNow;
  return out;
}

function normalizePeriod(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULTS.period };
  if (ANCHORS.includes(src.defaultAnchor)) out.defaultAnchor = src.defaultAnchor;
  return out;
}

function normalizeRefund(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULTS.refund };
  if (typeof src.formula === 'string' && src.formula.length <= 500) out.formula = src.formula.trim();
  if (typeof src.allowPartial === 'boolean') out.allowPartial = src.allowPartial;
  return out;
}

/** 一次读三组，合并默认值 */
function getCardRules() {
  const raw = readRaw();
  return {
    defer: normalizeDefer(raw.defer),
    period: normalizePeriod(raw.period),
    refund: normalizeRefund(raw.refund),
  };
}

/**
 * 按组浅合并：patch 里出现哪一组，就只更新那一组。
 * @param {object} prev 已存的完整配置
 * @param {object} patch 本次提交（可能只有一组）
 */
function mergeGroup(prev, patch) {
  const base = {
    defer: normalizeDefer(prev && prev.defer),
    period: normalizePeriod(prev && prev.period),
    refund: normalizeRefund(prev && prev.refund),
  };
  const src = patch && typeof patch === 'object' ? patch : {};
  if (src.defer !== undefined) base.defer = normalizeDefer({ ...base.defer, ...(src.defer || {}) });
  if (src.period !== undefined) base.period = normalizePeriod({ ...base.period, ...(src.period || {}) });
  if (src.refund !== undefined) base.refund = normalizeRefund({ ...base.refund, ...(src.refund || {}) });
  return base;
}

module.exports = {
  DEFAULTS,
  ANCHORS,
  START_ANCHORS,
  getCardRules,
  mergeGroup,
  normalizeDefer,
  normalizePeriod,
  normalizeRefund,
};
