/**
 * 前端工具层功能测试（Node 直跑，无需浏览器）
 * 覆盖：表头行探测 / 导入列别名 / 排序三态与多列 / 空值末尾 / 中文拼音序 / 列宽自适应与固定规则 / 视图模型
 */
// 相对定位，保证在任意克隆目录下可跑：node tests/table-utils.test.mjs
const BASE = new URL('../src/utils/', import.meta.url).href
const { parseCsv, csvToObjects, detectHeaderRow } = await import(BASE + 'csv.js')
const { nextSortState, toggleSort, sortRows, sortStateOf, sortPriorityOf } = await import(BASE + 'tableSort.js')
const { computeAutoWidths, resolveColumnWidths, isCustomWidth } = await import(BASE + 'tableWidth.js')
const { userViews, allViews, makeView, VIEW_ALL, VIEW_FILTERED } = await import(BASE + 'tableView.js')

let pass = 0, fail = 0
const rec = (name, ok, detail) => {
  if (ok) pass++; else fail++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : '  -> ' + detail}`)
}

// ---- 销售表导入列定义（与 views/orders/index.vue 一致的关键别名）----
const orderColumns = [
  { key: 'studentName', label: '学员姓名', required: true, aliases: ['学员姓名', '学生姓名', '姓名', '会员姓名', '会员', '会员名', '客户姓名', 'studentName'] },
  { key: 'phone', label: '联系方式', aliases: ['联系方式', '手机号', '电话', 'parentPhone', 'phone'] },
  { key: 'itemName', label: '项目', required: true, aliases: ['项目', '课程', 'itemName'] },
  { key: 'amount', label: '金额', aliases: ['金额', '购买金额', 'amount'] },
  { key: 'paidDate', label: '购买日期', aliases: ['购买日期', '收款日期', 'paidDate'] },
  { key: 'orderNo', label: '收据单号', aliases: ['收据单号', '订单号', 'orderNo'] },
  { key: 'salesperson', label: '签单人', aliases: ['签单人', '销售', 'salesperson'] },
  { key: 'remark', label: '备注', aliases: ['备注', 'remark'] },
]

console.log('\n=== 前端工具层功能测试 ===\n')

// ===== [1] P0-1 表头行探测：机构台账「第 1 行标题 + 第 2 行列名」=====
console.log('[1] 表头行探测（P0-1）')
{
  const grid = [
    ['26年销售记录表', '', '', '', '', '', '', '', ''],
    ['序号', '会员', '联系方式', '项目', '金额', '购买日期', '收据单号', '签单人', '备注'],
    [1, '梁嘉言', '13828091210', '特惠月卡', 199, '2026/1/1', '0854196', '岑小明', ''],
    [2, '李小红', '13900000002', '1v1私教', '¥2,699.00', '1/24/26', '0854197', '岑小明', '续费'],
  ]
  const det = detectHeaderRow(grid, orderColumns)
  rec('标题行在表头上方时，识别第 2 行为表头', det.index === 1 && det.matched >= 2, JSON.stringify(det))

  const parsed = csvToObjects(grid, orderColumns)
  rec('返回 headerRowIndex=1（供界面提示）', parsed.headerRowIndex === 1, String(parsed.headerRowIndex))
  rec('★ 收据单号归位（不再错位到备注）', parsed.objects[0] && parsed.objects[0].orderNo === '0854196', JSON.stringify(parsed.objects[0]))
  rec('★ 备注列不再被单号污染', parsed.objects[0] && parsed.objects[0].remark === '', JSON.stringify(parsed.objects[0] && parsed.objects[0].remark))
  rec('「会员」别名命中姓名列', parsed.objects[0] && parsed.objects[0].studentName === '梁嘉言', JSON.stringify(parsed.objects[0] && parsed.objects[0].studentName))
  rec('金额原样保留（由后端宽松解析）', parsed.objects[1] && parsed.objects[1].amount === '¥2,699.00', JSON.stringify(parsed.objects[1] && parsed.objects[1].amount))
  rec('数据行不把标题行当数据（共 2 条）', parsed.objects.length === 2, String(parsed.objects.length))
  rec('行号按原始文件行计（含跳过行）', parsed.errors.length === 0, JSON.stringify(parsed.errors))
}

// ===== [2] 表头探测的边界：单列命中不算表头、无标题行不受影响 =====
console.log('\n[2] 表头探测边界')
{
  // 表头匹配是「精确匹配」：'备注说明' 不命中别名「备注」。
  // 构造「最佳行只命中 1 列」→ 低于阈值 2 → 必须回退第 1 行（而不是采信那一行）
  const single = [['报表', '', ''], ['姓名', '', ''], ['张三', '138', 100]]
  const sd = detectHeaderRow(single, orderColumns)
  rec('仅单列命中 → 不判为表头（阈值 ≥2，回退第 1 行）', sd.index === 0 && sd.matched === 1, JSON.stringify(sd))
  // 标题行命中 1 列、真表头命中 3 列 → 必须选后者
  const better = [['姓名统计表', ''], ['姓名', '联系方式'], ['张三', '138']]
  rec('标题行单列命中 vs 真表头多列命中 → 选真表头', detectHeaderRow(better, orderColumns).index === 1, JSON.stringify(detectHeaderRow(better, orderColumns)))

  const plain = [['姓名', '联系方式', '项目', '金额'], ['张三', '138', '团课', 100]]
  const p = csvToObjects(plain, orderColumns)
  rec('无标题行时仍取第 1 行为表头', p.headerRowIndex === 0 && p.objects[0].studentName === '张三', JSON.stringify(p.headerRowIndex))
  rec('缺失必填列被显式报告', Array.isArray(p.missingRequired), JSON.stringify(p.missingRequired))
}

// ===== [3] CSV/TSV 分隔符自动判别 =====
console.log('\n[3] CSV / TSV 解析')
{
  const tsv = parseCsv('姓名\t联系方式\t项目\n张三\t138\t团课')
  rec('Tab 分隔自动判别（3 列）', tsv[0].length === 3 && tsv[1][0] === '张三', JSON.stringify(tsv))
  const csv = parseCsv('姓名,联系方式\n"李,四",139')
  rec('逗号 + 引号字段', csv[1][0] === '李,四', JSON.stringify(csv))
}

// ===== [4] 排序：三态 / 多列 / 空值末尾 / 中文拼音 =====
console.log('\n[4] 排序（增强 4.1）')
{
  rec('三态循环：无 → 升 → 降 → 无', nextSortState(0) === 1 && nextSortState(1) === 2 && nextSortState(2) === 0, '')

  let s = toggleSort([], 'age')
  rec('首次点击 = 升序', s.length === 1 && s[0].state === 1, JSON.stringify(s))
  s = toggleSort(s, 'age')
  rec('再次点击 = 降序', s[0].state === 2, JSON.stringify(s))
  s = toggleSort(s, 'age')
  rec('第三次点击 = 取消', s.length === 0, JSON.stringify(s))

  let m = toggleSort(toggleSort([], 'age'), 'name', true)
  rec('Shift 追加 = 多列（age 优先）', m.length === 2 && sortPriorityOf(m, 'age') === 1 && sortPriorityOf(m, 'name') === 2, JSON.stringify(m))
  m = toggleSort(m, 'name', true)
  rec('次级列状态独立推进', sortStateOf(m, 'name') === 2, JSON.stringify(m))
  const single2 = toggleSort([{ key: 'age', state: 1 }, { key: 'name', state: 1 }], 'age')
  rec('非追加点击 = 单列（只留该列）', single2.length === 1 && single2[0].key === 'age' && single2[0].state === 2, JSON.stringify(single2))
  const cleared = toggleSort([{ key: 'age', state: 1 }, { key: 'name', state: 2 }], 'name')
  rec('非追加点击到「取消」→ 清空全部排序', cleared.length === 0, JSON.stringify(cleared))

  const rows = [
    { name: '张三', age: 10 },
    { name: '李四', age: null },
    { name: '王五', age: 9 },
    { name: '赵六', age: 11 },
  ]
  const getV = (k, r) => (k === 'age' ? r.age : r.name)
  const asc = sortRows(rows, [{ key: 'age', state: 1 }], getV).map((r) => r.name)
  rec('★ 空值恒排末尾（升序）', asc[asc.length - 1] === '李四', JSON.stringify(asc))
  rec('升序数值正确（9 < 10 < 11）', JSON.stringify(asc.slice(0, 3)) === JSON.stringify(['王五', '张三', '赵六']), JSON.stringify(asc))
  const desc = sortRows(rows, [{ key: 'age', state: 2 }], getV).map((r) => r.name)
  rec('★ 空值恒排末尾（降序）', desc[desc.length - 1] === '李四', JSON.stringify(desc))

  const cn = sortRows([{ name: '10号' }, { name: '9号' }, { name: '阿宝' }], [{ key: 'name', state: 1 }], getV).map((r) => r.name)
  rec('★ 中文 + 数字按拼音序（9 在 10 前）', cn.indexOf('9号') < cn.indexOf('10号'), JSON.stringify(cn))

  const stable = sortRows([{ name: 'a', age: 1 }, { name: 'b', age: 1 }], [{ key: 'age', state: 1 }], getV).map((r) => r.name)
  rec('同值稳定排序', JSON.stringify(stable) === JSON.stringify(['a', 'b']), JSON.stringify(stable))
  rec('无排序规则时原样返回', sortRows(rows, [], getV).length === 4, '')
}

// ===== [5] 列宽（P2-2 / P2-3 / P2-7）=====
console.log('\n[5] 列宽（P2-2 / P2-3 / P2-7）')
{
  const cols = [
    { key: 'seq', label: '序号', minWidth: 56 },
    { key: 'name', label: '姓名', minWidth: 100, tooltip: true },
    { key: 'remark', label: '备注', minWidth: 100, tooltip: true },
  ]
  // 10 行样本：9 条短备注 + 1 条超长备注 —— 只有样本足够时「85 分位」才与「最大值」有差异
  const rows = [
    { name: '张三', remark: '短备注' }, { name: '李四', remark: '短备注' }, { name: '王五', remark: '短备注' },
    { name: '赵六', remark: '短备注' }, { name: '钱七', remark: '短备注' }, { name: '孙八', remark: '短备注' },
    { name: '周九', remark: '短备注' }, { name: '吴十', remark: '短备注' }, { name: '郑一', remark: '短备注' },
    { name: '王二', remark: '这是一条非常长的备注内容用于测试典型值定宽是否生效不会把整列撑爆' },
  ]
  const textOf = (c, r) => r[c.key]

  // 无 document（Node）：measure 退化为按字符数估算 —— 仍可验证相对关系
  const w1 = computeAutoWidths(cols, rows, { textOf })
  const w2 = computeAutoWidths(cols.map((c) => ({ ...c, extra: 26 })), rows, { textOf })
  rec('col.extra 使表头占位计入宽度（P2-2）', w2.seq >= w1.seq, `无extra=${w1.seq} 有extra=${w2.seq}`)

  const noTooltip = computeAutoWidths([{ key: 'remark', label: '备注', minWidth: 100 }], rows, { textOf })
  rec('★ tooltip 列取典型值而非最大值（P2-7）', w1.remark < noTooltip.remark, `典型值=${w1.remark} 最大值=${noTooltip.remark}`)
  rec('宽度受 min 约束', w1.seq >= 56, String(w1.seq))

  const noCustom = resolveColumnWidths(cols, {}, w1)
  rec('无手动列宽 → 用 minWidth（窄屏可拉伸）', noCustom.name.minWidth !== undefined && noCustom.name.width === undefined, JSON.stringify(noCustom.name))

  const withCustom = resolveColumnWidths(cols, { name: 240 }, w1)
  rec('★ 有手动列宽 → 全部列固定 width（P2-3）', withCustom.seq.width !== undefined && withCustom.remark.width !== undefined && withCustom.name.width === 240, JSON.stringify(withCustom))
  rec('isCustomWidth 判定', isCustomWidth({ name: 240 }, 'name') === true && isCustomWidth({ name: 0 }, 'name') === false, '')
}

// ===== [6] 视图模型 =====
console.log('\n[6] 视图模型（增强 4.1）')
{
  const raw = [{ id: VIEW_ALL, name: '伪装的系统视图' }, { id: 'v_1', name: '视图1' }]
  rec('系统视图 id 被过滤（不可伪造）', userViews(raw).length === 1 && userViews(raw)[0].id === 'v_1', JSON.stringify(userViews(raw)))
  const list = allViews([{ id: 'v_1', name: '视图1' }])
  rec('全部视图 = 2 个系统 + 用户', list.length === 3 && list[0].id === VIEW_ALL && list[1].id === VIEW_FILTERED, JSON.stringify(list.map((v) => v.id)))
  rec('系统视图标记 system（不可删）', list[0].system === true && list[1].system === true, '')

  const v = makeView('  我的视图  ', { filters: { status: 'active' }, sorts: [{ key: 'age', state: 1 }], order: ['seq'], widths: { seq: 60 } })
  rec('新建视图：名称去空白 + 快照完整', v.name === '我的视图' && v.filters.status === 'active' && v.sorts.length === 1 && v.widths.seq === 60, JSON.stringify(v))
  rec('视图 id 唯一', makeView('a').id !== makeView('a').id, '')
  rec('空名回退为「新视图」', makeView('   ').name === '新视图', makeView('   ').name)
}

// ===== [7] 集成接线检查（源码级）=====
// 教训：工具层单测全绿，但视图里忘了把 colExtra 注入列定义 → P2-2 静默失效。
// 这类「接线漏了」的缺陷单测覆盖不到，用源码断言兜一层。
console.log('\n[7] 集成接线检查')
{
  const fs = await import('node:fs')
  const views = ['../src/views/students/index.vue', '../src/views/orders/index.vue']
  for (const v of views) {
    const p = new URL(v, import.meta.url)
    const src = fs.readFileSync(p, 'utf-8')
    rec(`${v.split('/').slice(-2, -1)[0]}: computeAutoWidths 注入 extra（P2-2 生效）`,
      /extra:\s*colExtra\(/.test(src), '未找到 extra: colExtra(...) 注入')
    rec(`${v.split('/').slice(-2, -1)[0]}: 列宽绑定走 colWidths（非 col.width）`,
      /:width="colWidths\[/.test(src) && !/:width="col\./.test(src), '仍在使用 col.width')
    // 只断言 el-table-column 标签内没有 :sortable（SortableHeader 自己也有同名 prop，不能误伤）
    rec(`${v.split('/').slice(-2, -1)[0]}: el-table-column 未挂自带 :sortable（避免双行表头）`,
      !/<el-table-column[^>]*:sortable/s.test(src), 'el-table-column 上存在 :sortable')
    rec(`${v.split('/').slice(-2, -1)[0]}: 已接入 TableViewBar 与 SortableHeader`,
      /TableViewBar/.test(src) && /SortableHeader/.test(src), '组件未接入')
  }
}

console.log(`\n结果汇总：PASS ${pass}  FAIL ${fail}`)
process.exit(fail > 0 ? 1 : 0)
