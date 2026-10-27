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
    // 简易模式（默认）：机构只需填数字，不写表达式。
    //   退款 = 基数 × (1 − 手续费比例%) − 最低手续费
    //   基数 base：unused = 整单剩余额 × 未消耗比例；remain = 整单剩余额
    // 高级模式 formula：沿用原表达式引擎，仅对需要按天/按次自定义折算的机构开放。
    mode: 'simple',         // simple | formula
    base: 'unused',         // unused | remain
    deductPercent: 0,       // 手续费比例 %（0~100，直接填数字）
    minFee: 0,              // 最低手续费 ¥（≥0，直接填数字；0 = 不设）
    formula: '',            // 仅 mode==='formula' 生效
    allowPartial: true,     // 是否允许中途部分退款
  },
};

const REFUND_MODES = ['simple', 'formula'];
const REFUND_BASES = ['unused', 'remain'];

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
  if (REFUND_MODES.includes(src.mode)) out.mode = src.mode;
  if (REFUND_BASES.includes(src.base)) out.base = src.base;
  // 数字字段：非数字/负数/超范围一律丢弃保默认 —— 配置写坏不能让退款算成负数或超退
  if (Number.isFinite(Number(src.deductPercent))) {
    out.deductPercent = Math.max(0, Math.min(100, Number(src.deductPercent)));
  }
  if (Number.isFinite(Number(src.minFee))) {
    out.minFee = Math.max(0, Number(src.minFee));
  }
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
  REFUND_MODES,
  REFUND_BASES,
  getCardRules,
  mergeGroup,
  normalizeDefer,
  normalizePeriod,
  normalizeRefund,
};
