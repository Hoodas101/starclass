/**
 * XLSX 导出器回归测试（Node 直跑，无需浏览器）
 * 覆盖：稀疏/空行、多表模式 null 首元素、非法 XML 控制字符、文本首尾空格保真、
 *       -0 数值、工作表名与下载文件名净化、生成的 ZIP/XML 结构完整。
 * 运行：node tests/xlsx-export.test.mjs
 */
const { buildXlsxBytes, exportXlsx } = await import('../src/utils/xlsx.js')

let pass = 0, fail = 0
const rec = (name, ok, detail) => {
  if (ok) pass++; else fail++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : '  -> ' + detail}`)
}

// ZIP(STORE) 解包：只读 local file header，按文件名取回内容
const unzip = (bytes) => {
  const b = Buffer.from(bytes)
  const out = {}
  let o = 0
  while (o + 30 <= b.length && b.readUInt32LE(o) === 0x04034b50) {
    const nl = b.readUInt16LE(o + 26)
    const el = b.readUInt16LE(o + 28)
    const dl = b.readUInt32LE(o + 18)
    out[b.slice(o + 30, o + 30 + nl).toString()] = b.slice(o + 30 + nl + el, o + 30 + nl + el + dl).toString('utf8')
    o += 30 + nl + el + dl
  }
  return out
}
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/
const safe = (fn) => { try { return { ok: true, value: fn() } } catch (e) { return { ok: false, error: e.message } } }

console.log('\n[1] 生成结构与基线')
{
  const r = safe(() => unzip(buildXlsxBytes(['姓名', '金额'], [['张三', 100], ['李四', 200]])))
  rec('正常导出返回合法 ZIP', r.ok && !!r.value['xl/worksheets/sheet1.xml'])
  rec('包含 6 个必需部件', r.ok && ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']
    .every((n) => !!r.value[n]))
  rec('表头与数据均写成 inlineStr 文本', r.ok && r.value['xl/worksheets/sheet1.xml'].includes('<t xml:space="preserve">'))
}

console.log('\n[2] 稀疏行 / 空行（既往抛 TypeError 导致导出中断）')
{
  const r = safe(() => unzip(buildXlsxBytes(['姓名', '金额'], [null, ['张三', 100], undefined])))
  rec('null / undefined 行不再抛错', r.ok, r.ok ? '' : r.error)
  rec('空行仍保留行号且不丢数据', r.ok && r.value['xl/worksheets/sheet1.xml'].includes('<row r="3">')
    && r.value['xl/worksheets/sheet1.xml'].includes('张三'))
  const r2 = safe(() => buildXlsxBytes(['姓名'], [[1, 2], 'not-an-array', 42]))
  rec('非数组行与非数组 rows 被规范化', r2.ok, r2.ok ? '' : r2.error)
}

console.log('\n[3] 多表模式健壮性')
{
  const r = safe(() => unzip(buildXlsxBytes([null, { name: '第二表', headers: ['A'], rows: [['x']] }], [], {})))
  rec('首元素为 null 不再触发 `in` 抛错', r.ok, r.ok ? '' : r.error)
  const r2 = safe(() => unzip(buildXlsxBytes([
    { name: '表一', headers: ['A'], rows: [['1']] },
    { name: '表二', headers: ['B'], rows: [['2']] }
  ], [], {})))
  rec('双表生成 sheet1/sheet2 且 workbook 声明两张表', r2.ok
    && !!r2.value['xl/worksheets/sheet2.xml']
    && r2.value['xl/workbook.xml'].includes('name="表二"'))
}

console.log('\n[4] XML 合法性（既往生成 Excel 打不开的文件）')
{
  const xml = unzip(buildXlsxBytes(['备注'], [['张\u0001三'], ['李\u0007四'], ['正常']]))['xl/worksheets/sheet1.xml']
  rec('非法控制字符已剔除', !ILLEGAL_XML.test(xml))
  rec('其余文本未被破坏', xml.includes('张三') || xml.includes('三'))
  const x2 = unzip(buildXlsxBytes(['A'], [['<b>&"\'']]))['xl/worksheets/sheet1.xml']
  rec('XML 特殊字符仍按实体转义', x2.includes('&lt;b&gt;&amp;&quot;&apos;'))
}

console.log('\n[5] 数据保真')
{
  const xml = unzip(buildXlsxBytes(['备注'], [['  前后空格  '], [-0]]))['xl/worksheets/sheet1.xml']
  rec('单元格带 xml:space="preserve"', xml.includes('<t xml:space="preserve">  前后空格  </t>'))
  rec('-0 归零写入', xml.includes('<v>0</v>') && !xml.includes('<v>-0</v>'))
  const wb = unzip(buildXlsxBytes(['A'], [['x']], { sheetName: "'含单引号'" }))['xl/workbook.xml']
  rec('工作表名首尾单引号被清理', wb.includes('name="含单引号"'))
}

console.log('\n[6] 下载文件名净化')
{
  const captured = {}
  const prev = { document: globalThis.document, URL: globalThis.URL, Blob: globalThis.Blob, setTimeout: globalThis.setTimeout }
  globalThis.document = {
    createElement: () => ({ set download(v) { captured.name = v }, click() {} }),
    body: { appendChild() {}, removeChild() {} }
  }
  globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }
  globalThis.Blob = class { constructor(parts) { captured.parts = parts } }
  globalThis.setTimeout = () => 0
  try {
    const r = safe(() => exportXlsx('积分明细_张\n三\u0001/非法', ['A'], [['x']]))
    rec('含控制字符文件名不抛错', r.ok, r.ok ? '' : r.error)
    rec('下载名已净化且带 .xlsx', captured.name === '积分明细_张_三_非法.xlsx', captured.name)
  } finally {
    Object.assign(globalThis, prev)
  }
}

console.log(`\n结果汇总：PASS ${pass}  FAIL ${fail}\n`)
process.exit(fail ? 1 : 0)
