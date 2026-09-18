/**
 * 订单明细（orders.items）解析工具 —— 全后端唯一实现。
 *
 * 为什么需要收敛：orders.items 存的是 JSON 文本，但历史上存在两种形态：
 *   1. 正常形态：数组元素是对象
 *      [{ itemType, itemId, itemName, quantity, unitPrice, totalPrice }]
 *   2. 双重编码：数组元素本身是 JSON 字符串
 *      ['{"itemType":"membershipCard","itemName":"季卡",...}']
 *      直接取 item.itemName 恒为 undefined，金额恒为 0。
 * 且元素未必是对象（可能是裸字符串、null 等脏数据）。
 *
 * 导出报表、退卡退款、财务报表此前各自复制了一份解析逻辑，口径已经分叉
 * （例如退卡用 items.find 直接取 itemId，遇到双重编码必然落空 → 退化为卡类型标价）。
 * 现统一到本模块，任何「读 items 算钱」的地方都必须走这里。
 */
'use strict';

/**
 * 把 items 原始文本解析成「对象数组」，逐项兜底。
 * 非法 JSON / 非数组 → []；元素是 JSON 字符串 → 再解析一层；非对象元素 → 丢弃。
 * @param {string|null|undefined} raw orders.items 列原文
 * @returns {Array<object>}
 */
function parseItems(raw) {
  let arr;
  try { arr = JSON.parse(raw || '[]'); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => {
      if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return null; } }
      return (x && typeof x === 'object') ? x : null;
    })
    .filter(Boolean);
}

/**
 * 单项数量：非正数 / 缺失 / 非数字一律按 1 计（与导出报表口径一致）。
 * @param {object} item
 * @returns {number}
 */
function itemQuantity(item) {
  const q = item && item.quantity;
  return (typeof q === 'number' && q > 0) ? q : 1;
}

/**
 * 单项金额（行小计）：优先 totalPrice（订单写入时的行小计），
 * 缺失时回退 unitPrice × 数量（面值）；两者都拿不到记 0。
 * 注意 orders.js 写入的 totalPrice 是**标价**行小计（unitPrice × quantity），
 * 不是折后实付；整单折扣需由调用方按 payable_amount / total_amount 折减。
 * @param {object} item
 * @returns {number}
 */
function itemLineTotal(item) {
  const qty = itemQuantity(item);
  return Number((item && item.totalPrice) || ((item && item.unitPrice) * qty) || 0) || 0;
}

module.exports = { parseItems, itemQuantity, itemLineTotal };
