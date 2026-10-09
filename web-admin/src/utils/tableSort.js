/**
 * 表格排序：三态循环 + 多列优先级 + 空值恒排末尾 + 中文按拼音序。
 *
 * 设计决策：**纯前端排序，不加后端 sortBy**。筛选态下数据已由 fetchAllPages 全量拉回，
 * 排序无需再请求；新增可排序列也不必动后端（作者维护成本显著降低）。
 * 代价是单页排序只作用于本页 —— 这是表格类产品的常规语义（含飞书多维表格）。
 */

export const SORT_NONE = 0
export const SORT_ASC = 1
export const SORT_DESC = 2

/** 三态循环：升序 → 降序 → 取消 */
export const nextSortState = (state) => {
  if (state === SORT_ASC) return SORT_DESC
  if (state === SORT_DESC) return SORT_NONE
  return SORT_ASC
}

/**
 * 点击列头后的新排序数组。
 * @param {Array} sorts 形如 [{key, state}]
 * @param {string} key
 * @param {boolean} additive true=追加为次级排序（保留已有列），false=单列排序
 */
export const toggleSort = (sorts, key, additive = false) => {
  const list = (Array.isArray(sorts) ? sorts : []).map((s) => ({ ...s }))
  const idx = list.findIndex((s) => s.key === key)
  const next = nextSortState(idx >= 0 ? list[idx].state : SORT_NONE)

  // 非追加点击 = 单列语义：只保留该列（取消时清空全部）。
  // 此前在「取消」分支提前 return 整个列表，会出现「点了 A 列取消、B 列的排序却留着」，
  // 与「非追加 = 单列排序」的语义自相矛盾。
  if (!additive) return next === SORT_NONE ? [] : [{ key, state: next }]

  if (next === SORT_NONE) {
    if (idx >= 0) list.splice(idx, 1)
    return list
  }
  if (idx >= 0) list[idx].state = next
  else list.push({ key, state: next })
  return list
}

const isEmpty = (v) => v === null || v === undefined || v === ''

/** 数值按数值比；其余按中文拼音（localeCompare + numeric，否则「10」会排在「9」之前） */
const compareValues = (a, b) => {
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return String(a).localeCompare(String(b), 'zh-CN', { numeric: true })
}

/**
 * 按 sorts 排序（多列按优先级依次比较）。
 * 空值**恒排末尾**：升序对「没填生日」没有意义，夹在中间才是错。
 * @param {Array} rows
 * @param {Array} sorts [{key, state}]
 * @param {Function} getValue (key, row) => 参与比较的原始值
 */
export const sortRows = (rows, sorts, getValue) => {
  const active = (Array.isArray(sorts) ? sorts : []).filter((s) => s && s.state)
  if (!active.length) return rows
  const decorated = rows.map((row, i) => ({ row, i }))
  decorated.sort((x, y) => {
    for (const s of active) {
      const va = getValue(s.key, x.row)
      const vb = getValue(s.key, y.row)
      const ea = isEmpty(va)
      const eb = isEmpty(vb)
      if (ea && eb) continue
      if (ea) return 1
      if (eb) return -1
      const c = compareValues(va, vb)
      if (c !== 0) return s.state === SORT_DESC ? -c : c
    }
    return x.i - y.i // 稳定排序：同值时保持原有相对顺序
  })
  return decorated.map((d) => d.row)
}

/** 取某列的排序状态（0/1/2） */
export const sortStateOf = (sorts, key) => {
  const hit = (Array.isArray(sorts) ? sorts : []).find((s) => s.key === key)
  return hit ? hit.state : SORT_NONE
}

/** 取某列在多列排序里的优先级序号（1 起；未参与返回 0） */
export const sortPriorityOf = (sorts, key) => {
  const list = Array.isArray(sorts) ? sorts : []
  const idx = list.findIndex((s) => s.key === key && s.state)
  return idx < 0 ? 0 : idx + 1
}
