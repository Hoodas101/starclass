// ============================================================
// 极简 XLSX 导出工具（零依赖）
// 生成标准 .xlsx 文件：ZIP(STORE) + SpreadsheetML XML
// 兼容 Excel / WPS / Numbers / 飞书 / 微信等表格软件
// ============================================================

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (data) => {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ---------- 基础工具 ----------
const enc = new TextEncoder()
const u8 = (str) => enc.encode(str)

const concatBytes = (arrays) => {
  const total = arrays.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

// ---------- ZIP（STORE 不压缩） ----------
const zipStore = (files) => {
  const chunks = []
  const central = []
  let offset = 0

  for (const f of files) {
    const name = u8(f.name)
    const data = f.data
    const crc = crc32(data)
    const header = new DataView(new ArrayBuffer(30))
    header.setUint32(0, 0x04034b50, true)
    header.setUint16(4, 20, true)
    header.setUint16(6, 0x0800, true)
    header.setUint16(8, 0, true)
    header.setUint16(10, 0, true)
    header.setUint16(12, 0, true)
    header.setUint32(14, crc, true)
    header.setUint32(18, data.length, true)
    header.setUint32(22, data.length, true)
    header.setUint16(26, name.length, true)
    header.setUint16(28, 0, true)
    chunks.push(new Uint8Array(header.buffer), name, data)

    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 20, true)
    cd.setUint16(6, 20, true)
    cd.setUint16(8, 0x0800, true)
    cd.setUint16(10, 0, true)
    cd.setUint16(12, 0, true)
    cd.setUint16(14, 0, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, data.length, true)
    cd.setUint32(24, data.length, true)
    cd.setUint16(28, name.length, true)
    cd.setUint16(30, 0, true)
    cd.setUint16(32, 0, true)
    cd.setUint16(34, 0, true)
    cd.setUint16(36, 0, true)
    cd.setUint32(38, 0, true)
    cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), name)

    offset += 30 + name.length + data.length
  }

  const centralSize = central.reduce((n, a) => n + a.length, 0)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(4, 0, true)
  eocd.setUint16(6, 0, true)
  eocd.setUint16(8, files.length, true)
  eocd.setUint16(10, files.length, true)
  eocd.setUint32(12, centralSize, true)
  eocd.setUint32(16, offset, true)
  eocd.setUint16(20, 0, true)

  return concatBytes([...chunks, ...central, new Uint8Array(eocd.buffer)])
}

// ---------- XLSX 内容 ----------
// XML 1.0 只允许 #x9 / #xA / #xD 及 #x20 以上的字符。学员姓名、备注、课程名等
// 自由文本可能带控制字符（从 Excel 粘贴、从旧系统同步最常见）；若原样写入
// sheet*.xml，生成的是**非法 XML**，Excel / WPS 打开会直接报「文件已损坏」，
// 而且整份导出不可用。先在转义前剔除非法码位，保留制表/换行/回车。
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g

const esc = (v) => String(v ?? '')
  .replace(XML_ILLEGAL, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;')

const colName = (index) => {
  let n = index
  let s = ''
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  }
  return s
}

// 估算列宽：中文按 2 个字符计
const displayLen = (v) => {
  const s = String(v ?? '')
  let len = 0
  for (const ch of s) {
    len += ch.charCodeAt(0) > 255 ? 2 : 1
  }
  return len
}

const buildSheetXml = (headers, rows) => {
  // 表头/数据行必须在这里一次性规范化：分页拼接、字段映射或后端稀疏数组都可能
  // 产生 null / undefined 行或非数组行。此前 bodyRows 用 (row || []) 做了保护，
  // 但下方列宽估算直接写 row[i]，遇到空行即抛 TypeError，整份导出中断且无提示。
  const head = Array.isArray(headers) ? headers : []
  const normRows = (Array.isArray(rows) ? rows : []).map((r) => Array.isArray(r) ? r : [])

  const headerRow = head.map((h, i) =>
    `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${esc(h)}</t></is></c>`
  ).join('')

  const bodyRows = normRows.map((row, rIdx) => {
    const rowNum = rIdx + 2
    const cells = row.map((cell, cIdx) => {
      const ref = `${colName(cIdx)}${rowNum}`
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        // -0 在 OOXML 数值单元格里会写成 "-0"，Excel 显示为 -0；统一归零。
        return `<c r="${ref}"><v>${cell === 0 ? 0 : cell}</v></c>`
      }
      // xml:space="preserve"：不加时 Excel 会裁掉单元格文本首尾空格，
      // 导出再导入会静默改掉原始备注/姓名。
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`
    }).join('')
    return `<row r="${rowNum}">${cells}</row>`
  }).join('')

  // 列宽：根据表头与数据内容估算
  const widths = head.map((h, i) => {
    let max = displayLen(h)
    for (const row of normRows) {
      const len = displayLen(row[i])
      if (len > max) max = len
    }
    const w = Math.min(40, Math.max(9, max + 2))
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`
  }).join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>${widths}</cols>
  <sheetData>
    <row r="1">${headerRow}</row>
    ${bodyRows}
  </sheetData>
</worksheet>`
}

const CONTENT_TYPES = (sheetCount) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${Array.from({ length: sheetCount }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n  ')}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const buildWorkbook = (sheets) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n    ')}
  </sheets>
</workbook>`

const buildWorkbookRels = (sheetCount) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${Array.from({ length: sheetCount }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n  ')}
  <Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

// 表头样式：加粗 + 浅蓝底 + 边框（跟随主题主色 #2E8BF0 的浅色）
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="PingFang SC"/><name val="Microsoft YaHei"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="PingFang SC"/><name val="Microsoft YaHei"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAF3FE"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFD5E4F3"/></left>
      <right style="thin"><color rgb="FFD5E4F3"/></right>
      <top style="thin"><color rgb="FFD5E4F3"/></top>
      <bottom style="thin"><color rgb="FFD5E4F3"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

// ---------- 主入口 ----------
/**
 * 生成 xlsx 二进制内容（可测试）
 * @param {string[]} headers 表头数组
 * @param {Array<Array<string|number>>} rows 数据行
 * @param {{ sheetName?: string }} [opts]
 */
const sanitizeSheetName = (name) => {
  // Excel 禁止 : \ / ? * [ ]，且工作表名不能以单引号开头或结尾；超过 31 字符会被拒绝。
  // 名称可能来自数据（如按教练分表），需同时清掉控制字符，否则 workbook.xml 非法。
  const s = String(name || 'Sheet1')
    .replace(XML_ILLEGAL, '')
    .slice(0, 31)
    .replace(/[\\/?*[\]:]/g, ' ')
    .replace(/^'+|'+$/g, '')
    .trim()
  return s || 'Sheet1'
}

const normalizeSheets = (headers, rows, opts = {}) => {
  // 多表模式：sheets = [{ name, headers, rows }]
  // typeof null === 'object'，原判定直接对 headers[0] 用 `in` 会在首元素为 null 时抛 TypeError。
  // 只看首元素会在多表数组以 null 开头时误判为单表：整份 sheets 被当成表头，
  // 静默生成一张错表而不是抛错。改为「任一元素是 sheet 描述对象」即进入多表模式。
  const isSheetDesc = (x) => !!x && typeof x === 'object' && !Array.isArray(x)
    && ('headers' in x || 'rows' in x)
  const isMulti = Array.isArray(headers) && headers.some(isSheetDesc)
  if (isMulti) {
    const used = new Set()
    return headers.map((s, i) => {
      const sh = (s && typeof s === 'object' && !Array.isArray(s)) ? s : {}
      let name = sanitizeSheetName(sh.name || sh.sheetName || `Sheet${i + 1}`)
      // Excel 保留名（History，大小写不敏感）与多表重名都会让 workbook 被判为损坏。
      if (/^history$/i.test(name)) name = `${name}_${i + 1}`.slice(0, 31)
      let unique = name
      let n = 2
      while (used.has(unique.toLowerCase())) {
        const suffix = `_${n++}`
        unique = `${name.slice(0, 31 - suffix.length)}${suffix}`
      }
      used.add(unique.toLowerCase())
      return {
        name: unique,
        headers: Array.isArray(sh.headers) ? sh.headers : [],
        rows: Array.isArray(sh.rows) ? sh.rows : []
      }
    })
  }
  return [{
    name: sanitizeSheetName(opts.sheetName),
    headers: Array.isArray(headers) ? headers : [],
    rows: Array.isArray(rows) ? rows : []
  }]
}

export const buildXlsxBytes = (headers = [], rows = [], opts = {}) => {
  const sheets = normalizeSheets(headers, rows, opts)
  const files = [
    { name: '[Content_Types].xml', data: u8(CONTENT_TYPES(sheets.length)) },
    { name: '_rels/.rels', data: u8(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: u8(buildWorkbook(sheets)) },
    { name: 'xl/_rels/workbook.xml.rels', data: u8(buildWorkbookRels(sheets.length)) },
    { name: 'xl/styles.xml', data: u8(STYLES) }
  ]
  sheets.forEach((s, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: u8(buildSheetXml(s.headers, s.rows)) })
  })
  return zipStore(files)
}

/**
 * 导出 Excel 文件（浏览器下载）
 * @param {string} filename 文件名（不含扩展名，如 '成员列表_20260806'）
 * @param {string[]} headers 表头数组
 * @param {Array<Array<string|number>>} rows 数据行
 * @param {{ sheetName?: string }} [opts]
 */
export const exportXlsx = (filename, headers = [], rows = [], opts = {}) => {
  // 文件名可能由数据拼接（如「积分明细_${成员姓名}」）：除 Windows 非法字符外，
  // 还要清掉换行/制表与控制字符，并限长，避免下载名被截断或含不可见字符。
  const safeFilename = (String(filename || '导出数据')
    .replace(XML_ILLEGAL, '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .trim()
    .slice(0, 120)) || '导出数据'
  const blob = new Blob([buildXlsxBytes(headers, rows, opts)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${safeFilename}.xlsx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export default exportXlsx
