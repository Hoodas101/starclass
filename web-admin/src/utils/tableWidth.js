/**
 * 表格列宽：canvas 实测文本像素 + 手动微调 + 自适应开关。
 *
 * 背景（审计 2026-10-08 · P2-2/P2-3/P2-7）：
 *  · 短列名被截断（「序号」→「序·」）：自适应只量列名文字，未计入表头里**仍占位**的
 *    排序箭头与优先级角标；实测「序号」列 th 仅 50px，扣内边距后文字只剩 15px（需 25px）。
 *  · 自定义列宽被相邻列挤压：只给某列设固定 width、其余仍是 min-width 时，
 *    Element Plus 会压缩 min-width 列来腾空间（把「姓名」设 240px 后「加入时间」被从 109px 压到 97px）。
 *  · 自由文本列长尾：跟随最长值会把整列撑爆（备注列多数行 204px、个别行 334px），
 *    跟随多数值又会截断个别行。
 */

// 与 .el-table 实际渲染保持一致的字体（PingFang SC 是 macOS 默认中文字体）
const CELL_FONT = '13px "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif'
const HEADER_FONT = '600 13px "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif'

let measureCtx = null
const measure = (text, font) => {
  const s = String(text == null ? '' : text)
  // 非浏览器环境（SSR/测试）退化为按字符数估算，避免抛错
  if (typeof document === 'undefined') return s.length * 13
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  measureCtx.font = font
  return measureCtx.measureText(s).width
}

/** 该列是否被手动指定了列宽 */
export const isCustomWidth = (customWidths, key) => {
  const w = customWidths && customWidths[key]
  return typeof w === 'number' && w > 0
}

/** 第 p 分位（0~1），用于「典型值定宽」 */
const percentile = (arr, p) => {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

/**
 * 计算各列自适应宽度。
 * @param {Array} colDefs 列定义（key / label / tooltip / extra）
 * @param {Array} rows 当前数据
 * @param {{cellPadding?: number, min?: number, max?: number, textOf?: Function}} opts
 *        textOf(col, row) 返回该单元格的纯文本（用于量宽）
 * @returns {Object} { [key]: number }
 */
export const computeAutoWidths = (colDefs, rows, opts = {}) => {
  const { cellPadding = 20, min = 56, max = 320, textOf } = opts
  const out = {}
  for (const col of colDefs) {
    // 表头控件占位（col.extra）：排序箭头/角标/筛选触发器在表头里常驻占位，
    // 只量文字会让短列名被 ellipsis 截断
    const headerW = measure(col.label, HEADER_FONT) + cellPadding + (col.extra || 0)
    let bodyW = 0
    if (textOf) {
      const widths = []
      for (const row of rows) {
        const t = textOf(col, row)
        if (t) widths.push(measure(t, CELL_FONT))
      }
      // 自由文本列（tooltip 列）取典型值（85 分位）而非最大值：个别超长值不该把整列撑爆，
      // 被截断的个别行由 show-overflow-tooltip 兜底 —— 表格类产品的常规做法
      bodyW = col.tooltip ? percentile(widths, 0.85) : (widths.length ? Math.max(...widths) : 0)
    }
    out[col.key] = Math.round(Math.min(max, Math.max(min, Math.max(headerW, bodyW + cellPadding))))
  }
  return out
}

/**
 * 生成 el-table-column 的宽度绑定。
 *
 * 关键规则（P2-3）：一旦存在**任何**手动列宽，全部列改为固定 `width` ——
 * 否则 Element Plus 会压缩其余 min-width 列来给手动列腾空间（用户调的是这列，却让别人买单）。
 * 无手动列宽时保留 min-width，维持「窄屏自动拉伸填满」。
 *
 * @returns {Object} { [key]: {width?: number, minWidth?: number} }
 */
export const resolveColumnWidths = (colDefs, customWidths, autoWidths) => {
  const hasCustom = colDefs.some((c) => isCustomWidth(customWidths, c.key))
  const out = {}
  for (const col of colDefs) {
    const w = isCustomWidth(customWidths, col.key) ? customWidths[col.key] : autoWidths[col.key]
    const fallback = col.minWidth || 80
    out[col.key] = hasCustom ? { width: w || fallback } : { minWidth: w || fallback }
  }
  return out
}
