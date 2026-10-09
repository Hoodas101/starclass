// 轻量 CSV/TSV 解析（兼容 BOM / 引号字段 / 换行 / Tab 分隔）
export const parseCsv = (text, delimiter) => {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // 分隔符自动判别：Excel「另存为 → TSV 文本文件」用 Tab，中文 Windows 另存 CSV 用逗号。
  // 此前只认逗号，TSV 整批解析为 0 行（新手最常见的格式之一）。按首行 Tab / 逗号出现次数取多者。
  let delim = delimiter
  if (!delim) {
    const firstLine = src.split('\n')[0] || ''
    delim = firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ','
  }
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delim) {
      row.push(field.trim())
      field = ''
    } else if (ch === '\n') {
      row.push(field.trim())
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  row.push(field.trim())
  if (row.some((c) => c !== '')) rows.push(row)
  return rows
}

// 表头归一化：去空白 / 括号 / 冒号 / 星号并转小写，用于同义表头匹配（"学员姓名" ↔ "姓名"）
const normHeader = (s) => String(s == null ? '' : s).replace(/[\s()（）:：*]/g, '').toLowerCase()

/**
 * 构建「列定义下标 → 表头下标」映射。
 * 支持 label / key / aliases 三处候选，且经归一化后匹配（不再要求逐字相同）。
 * Excel 分支复用同一份实现，保证 CSV 与 XLSX 表头容错口径一致。
 */
export const buildHeaderIndex = (headers, columns) => {
  const normed = headers.map(normHeader)
  return columns.map((col) => {
    const cands = [col.label, col.key, ...(col.aliases || [])].map(normHeader).filter(Boolean)
    return normed.findIndex((h) => h && cands.includes(h))
  })
}

// 统计一行里命中已知列的数量（供表头行探测使用）
const matchCount = (row, columns) => {
  if (!Array.isArray(row)) return 0
  const indexMap = buildHeaderIndex(row.map((c) => String(c == null ? '' : c)), columns)
  return indexMap.filter((i) => i >= 0).length
}

/**
 * 表头行探测：机构自带台账常见「第 1 行是标题、第 2 行才是列名」的结构。
 * 此前固定把第 1 行当表头 → 一列都匹配不上 → 各列回退到「按列序猜」→ **整表错位一列**
 * （实测：收据单号被写进备注列）。改为在前 scanLimit 行中取「命中已知列最多」的一行作表头。
 * 阈值取 2：单列命中可能是巧合（标题里恰好含「姓名」二字），不足以判定为表头行。
 * @returns {{index: number, matched: number}}
 */
export const detectHeaderRow = (grid, columns, scanLimit = 10) => {
  const limit = Math.min(scanLimit, grid.length)
  let best = { index: 0, matched: -1 }
  for (let i = 0; i < limit; i += 1) {
    const n = matchCount(grid[i], columns)
    if (n > best.matched) best = { index: i, matched: n }
    if (n === columns.length) break
  }
  if (best.matched < 2) return { index: 0, matched: Math.max(0, best.matched) }
  return best
}

// 按表头行映射为对象数组（支持同义表头与标题行；返回未识别列与缺失必填列供界面提示）
export const csvToObjects = (rows, columns) => {
  if (!rows.length) return { objects: [], errors: ['文件为空'], unrecognized: [], missingRequired: [], headerRowIndex: 0 }
  const { index, matched } = detectHeaderRow(rows, columns)
  const headerRowIndex = matched >= 2 ? index : 0
  const header = rows[headerRowIndex].map((h) => String(h == null ? '' : h).trim())
  const indexMap = buildHeaderIndex(header, columns)
  const matchedIdx = new Set(indexMap.filter((i) => i >= 0))
  // 未识别的表头列：非必填列匹配失败是静默的（学员建了、手机号却为空），必须显式提示
  const unrecognized = header.filter((h, i) => h && !matchedIdx.has(i))
  const missingRequired = columns.filter((c, ci) => c.required && indexMap[ci] < 0).map((c) => c.label)
  const objects = []
  const errors = []
  rows.slice(headerRowIndex + 1).forEach((cells, ri) => {
    const obj = {}
    columns.forEach((col, ci) => {
      const idx = indexMap[ci]
      obj[col.key] = idx >= 0 ? (cells[idx] ?? '') : ''
    })
    const required = columns.filter((c) => c.required)
    const missing = required.filter((c) => !String(obj[c.key] ?? '').trim())
    if (missing.length) {
      // 行号按原始文件行计算（含被跳过的标题行），便于用户回到表格里定位
      errors.push(`第 ${headerRowIndex + ri + 2} 行：缺少必填列「${missing.map((m) => m.label).join('、')}」`)
    } else {
      objects.push(obj)
    }
  })
  return { objects, errors, unrecognized, missingRequired, headerRowIndex, header }
}

/**
 * 解码文本文件：优先 UTF-8，若出现大量替换字符（�）则回退 GBK。
 * 中文 Windows 上 Excel「另存为 CSV」默认是 GBK，此前固定按 UTF-8 解码 → 中文全乱码，
 * 而乱码字符非空，姓名列照样通过必填校验并入库，最终建出一批乱码档案。
 * @returns {{ text: string, encoding: string, garbled: boolean }}
 */
export const decodeTextFile = (buffer) => {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
  const decode = (label) => {
    try { return new TextDecoder(label, { fatal: false }).decode(bytes) } catch (e) { return null }
  }
  const countBad = (s) => (s ? (s.match(/\uFFFD/g) || []).length : Infinity)
  const utf8 = decode('utf-8')
  if (utf8 != null && countBad(utf8) === 0) return { text: utf8, encoding: 'utf-8', garbled: false }
  const gbk = decode('gbk')
  if (gbk != null && countBad(gbk) < countBad(utf8)) {
    return { text: gbk, encoding: 'gbk', garbled: false }
  }
  return { text: utf8 == null ? '' : utf8, encoding: 'utf-8', garbled: true }
}
