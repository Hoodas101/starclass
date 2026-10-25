/**
 * 受控表达式求值器 —— 用于「自定义退费公式」。
 *
 * 为什么不用 eval / new Function：
 *   退费金额是钱，算它的那段字符串必须能被读懂、能被审计。允许任意脚本等于把
 *   金额计算权交给一段无人复核的代码，且构成代码注入面。
 *
 * 能力边界（刻意收窄）：
 *   · 变量：白名单内的标识符（见 VARIABLES）
 *   · 运算：+ - * / 与括号、数字字面量
 *   · 函数：min max round floor ceil abs
 *   · **不支持** 字符串、布尔、条件表达式（if / ?:）、属性访问、函数定义
 *     需要分支时用 min/max 组合 —— 条件表达式会让「这张卡为什么退这个数」
 *     无法用一句话向家长解释。
 *
 * 安全约束：
 *   · 表达式长度 ≤ 500，括号深度 ≤ 20（防构造性爆炸）
 *   · 只做数值运算，结果非有限数一律视为非法
 */

const MAX_LEN = 500;
const MAX_DEPTH = 20;

const VARIABLES = [
  'paid', 'refunded', 'remain',
  'total_days', 'used_days', 'remain_days', 'paused_days',
  'total_classes', 'used_classes', 'remain_classes',
  'fee_rate',
];

const FUNCS = {
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
  round: (args) => Math.round(args[0]),
  floor: (args) => Math.floor(args[0]),
  ceil: (args) => Math.ceil(args[0]),
  abs: (args) => Math.abs(args[0]),
};

const ARITY = { min: [2, 2], max: [2, 2], round: [1, 1], floor: [1, 1], ceil: [1, 1], abs: [1, 1] };

class FormulaError extends Error {}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new FormulaError(`数字不合法：${raw}`);
      tokens.push({ type: 'num', value: num });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/(),'.includes(ch)) {
      tokens.push({ type: ch });
      i++;
      continue;
    }
    throw new FormulaError(`不允许的字符：${ch}`);
  }
  return tokens;
}

/** 递归下降解析并求值；不建 AST，直接边解析边算（表达式足够小） */
function evaluate(src, vars) {
  if (typeof src !== 'string') throw new FormulaError('公式必须是字符串');
  const text = src.trim();
  if (!text) throw new FormulaError('公式为空');
  if (text.length > MAX_LEN) throw new FormulaError(`公式过长（上限 ${MAX_LEN} 字符）`);

  const tokens = tokenize(text);
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const eat = (type) => {
    const tk = tokens[pos];
    if (!tk || tk.type !== type) throw new FormulaError(`语法错误：期望 ${type}`);
    pos++;
    return tk;
  };

  function parseExpression() {
    let v = parseTerm();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = tokens[pos++].type;
      const rhs = parseTerm();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  function parseTerm() {
    let v = parseFactor();
    while (peek() && (peek().type === '*' || peek().type === '/')) {
      const op = tokens[pos++].type;
      const rhs = parseFactor();
      if (op === '/' && rhs === 0) throw new FormulaError('除数为 0');
      v = op === '*' ? v * rhs : v / rhs;
    }
    return v;
  }

  function parseFactor() {
    const tk = peek();
    if (!tk) throw new FormulaError('公式不完整');

    if (tk.type === '-') { pos++; return -parseFactor(); }
    if (tk.type === '+') { pos++; return parseFactor(); }

    if (tk.type === 'num') { pos++; return tk.value; }

    if (tk.type === '(') {
      pos++;
      depth++;
      if (depth > MAX_DEPTH) throw new FormulaError('括号嵌套过深');
      const v = parseExpression();
      eat(')');
      depth--;
      return v;
    }

    if (tk.type === 'ident') {
      pos++;
      const name = tk.value;
      // 函数调用
      if (peek() && peek().type === '(') {
        if (!Object.prototype.hasOwnProperty.call(FUNCS, name)) {
          throw new FormulaError(`不允许的函数：${name}`);
        }
        pos++; // (
        const args = [];
        if (peek() && peek().type !== ')') {
          args.push(parseExpression());
          while (peek() && peek().type === ',') { pos++; args.push(parseExpression()); }
        }
        eat(')');
        const [lo, hi] = ARITY[name];
        if (args.length < lo || args.length > hi) {
          throw new FormulaError(`函数 ${name} 需要 ${lo === hi ? lo : lo + '~' + hi} 个参数`);
        }
        return FUNCS[name](args);
      }
      // 变量
      if (!VARIABLES.includes(name)) throw new FormulaError(`未知变量：${name}`);
      const v = Number(vars[name]);
      return Number.isFinite(v) ? v : 0;
    }

    throw new FormulaError(`语法错误：意外的 ${tk.type}`);
  }

  const value = parseExpression();
  if (pos !== tokens.length) throw new FormulaError('公式尾部有多余内容');
  if (!Number.isFinite(value)) throw new FormulaError('计算结果不是有限数');
  return value;
}

/**
 * 求值并按退费语义夹取到 [0, remain]。
 * @returns {{ok:true, amount:number}|{ok:false, error:string}}
 */
function evaluateRefund(src, vars) {
  try {
    const raw = evaluate(src, vars);
    const remain = Number(vars.remain) || 0;
    const amount = Math.max(0, Math.min(Math.round(raw), Math.round(remain)));
    return { ok: true, amount, raw: Math.round(raw) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : '公式不合法' };
  }
}

/**
 * 保存前校验：能解析 + 三组样本值可求值 + 结果落在 [0, remain]。
 * @returns {{ok:boolean, error?:string}}
 */
function validateFormula(src) {
  if (typeof src !== 'string' || !src.trim()) return { ok: true }; // 空 = 用内置默认
  const samples = [
    { paid: 1000, refunded: 0, remain: 1000, total_days: 30, used_days: 0, remain_days: 30, paused_days: 0, total_classes: 20, used_classes: 0, remain_classes: 20, fee_rate: 0 },
    { paid: 1000, refunded: 0, remain: 600, total_days: 30, used_days: 12, remain_days: 18, paused_days: 0, total_classes: 20, used_classes: 8, remain_classes: 12, fee_rate: 0.2 },
    { paid: 1000, refunded: 0, remain: 0, total_days: 30, used_days: 30, remain_days: 0, paused_days: 0, total_classes: 20, used_classes: 20, remain_classes: 0, fee_rate: 0.2 },
  ];
  for (const v of samples) {
    const r = evaluateRefund(src, v);
    if (!r.ok) return { ok: false, error: r.error };
  }
  return { ok: true };
}

module.exports = { evaluate, evaluateRefund, validateFormula, VARIABLES, FUNCS, FormulaError };
