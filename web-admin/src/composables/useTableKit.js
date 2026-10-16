/**
 * 多维表格能力复用：排序（三态 / 多列优先级 / 空值末尾）+ 列宽（自适应 / 拖拽 / 复位）+
 * 视图快照（筛选 + 排序 + 字段顺序 + 列宽）+ 字段设置持久化。
 *
 * 学员档案与销售表是内联实现（先做的，历史包袱），增长中心 / 试听预约 / 财务报表复用本 composable，
 * 避免同一套逻辑在多个页签各写一遍、各自出 bug。
 *
 * 持久化走「先重读服务端 → 按键合并 → 写回」+ 300ms 去抖，与学员档案同一套并发安全写法：
 * 设置表是「一个键 = 一整个对象」的覆盖语义，直接写回会抹掉期间其他写入。
 */
import { computed, ref } from 'vue'
import { getSettings, saveSettings } from '@/api/modules'
import { sortRows, toggleSort, sortStateOf, sortPriorityOf } from '@/utils/tableSort'
import { computeAutoWidths, resolveColumnWidths, headerExtra } from '@/utils/tableWidth'
import { allViews, makeView, userViews, VIEW_ALL, VIEW_FILTERED } from '@/utils/tableView'

/**
 * @param {object} opts
 * @param {string} opts.settingsKey 持久化键（growth_columns / trial_columns / finance_columns）
 * @param {Function|import('vue').Ref} opts.defs 列定义（函数或 ref）
 * @param {import('vue').ComputedRef<Array>} opts.rows 当前数据（用于量宽与排序）
 * @param {Function} opts.textOf (col, row) => 单元格纯文本（量宽用）
 * @param {Function} opts.getValue (key, row) => 排序取值
 * @param {object} opts.defaults 默认列显隐
 * @param {Function} [opts.extraOf] (col) => 表头控件占位像素
 */
export const useTableKit = ({ settingsKey, defs, rows, textOf, getValue, defaults = {}, extraOf }) => {
  const settings = ref({ ...defaults })
  const sorts = ref([])
  const customWidths = ref({})
  const autoColumnWidth = ref(true)
  const views = ref([])
  const activeViewId = ref(VIEW_FILTERED)

  const colDefs = computed(() => (typeof defs === 'function' ? defs() : defs.value) || [])

  // 按保存的顺序渲染列（未保存顺序时保持定义顺序）
  const visibleDefs = computed(() => {
    const order = Array.isArray(settings.value.order) ? settings.value.order : []
    const all = colDefs.value.filter((c) => settings.value[c.key] !== false)
    const ordered = order.map((k) => all.find((c) => c.key === k)).filter(Boolean)
    return [...ordered, ...all.filter((c) => !order.includes(c.key))]
  })

  const autoWidths = computed(() => {
    const cols = visibleDefs.value
    if (!autoColumnWidth.value) {
      const out = {}
      for (const c of cols) out[c.key] = c.minWidth || 80
      return out
    }
    // 必须注入 extra（排序箭头/筛选触发器占位），否则短列名会被截断
    const withExtra = extraOf ? cols.map((c) => ({ ...c, extra: extraOf(c) })) : cols
    return computeAutoWidths(withExtra, rows.value, { textOf })
  })

  const colWidths = computed(() => resolveColumnWidths(visibleDefs.value, customWidths.value, autoWidths.value))
  const sortedRows = computed(() => sortRows(rows.value, sorts.value, getValue))

  const sortState = (key) => sortStateOf(sorts.value, key)
  const sortPriority = (key) => sortPriorityOf(sorts.value, key)

  let persistTimer = null
  const persist = () => {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(async () => {
      const payload = {
        ...settings.value,
        sorts: sorts.value,
        widths: customWidths.value,
        autoColumnWidth: autoColumnWidth.value,
        views: views.value,
        activeViewId: activeViewId.value,
      }
      try {
        let remote = {}
        try {
          const cur = await getSettings()
          remote = (cur && cur[settingsKey]) || {}
        } catch (e) {
          // 读不到服务端就退化为直接写（不能因为一次读失败让保存整个失败）
          await saveSettings({ [settingsKey]: payload })
          return
        }
        await saveSettings({ [settingsKey]: { ...remote, ...payload } })
      } catch (e) {
        // 拦截器已提示
      }
    }, 300)
  }

  /** 首次进入页面时加载（与其它数据并行即可，不阻塞渲染） */
  const load = async () => {
    try {
      const data = await getSettings()
      const s = (data && data[settingsKey]) || null
      if (s) {
        settings.value = { ...defaults, ...s }
        sorts.value = Array.isArray(s.sorts) ? s.sorts : []
        customWidths.value = s.widths || {}
        if (s.autoColumnWidth === false) autoColumnWidth.value = false
        views.value = userViews(s.views)
        activeViewId.value = s.activeViewId || VIEW_FILTERED
      }
    } catch (e) {
      // 用默认值
    }
  }

  const onSort = (key, { additive } = {}) => {
    sorts.value = toggleSort(sorts.value, key, additive)
    persist()
  }
  const onResize = (key, w) => {
    customWidths.value = { ...customWidths.value, [key]: w }
    persist()
  }
  const resetWidths = () => {
    customWidths.value = {}
    persist()
  }
  const onWidthsChange = (w) => {
    customWidths.value = w
    persist()
  }
  const onAutoWidthChange = (v) => {
    autoColumnWidth.value = !!v
    persist()
  }

  const viewList = computed(() => allViews(views.value))

  const currentSnapshot = (filters) => ({
    filters: filters || {},
    sorts: sorts.value,
    order: settings.value.order || [],
    widths: customWidths.value,
  })

  /**
   * 切换视图。applySnapshot(filters) 由页面提供，用于把快照里的筛选条件写回页面自身状态。
   */
  const applyView = (id, applySnapshot) => {
    activeViewId.value = id
    if (id === VIEW_FILTERED) return // 「当前筛选」= 保持现状
    const v = id === VIEW_ALL
      ? { filters: {}, sorts: [], order: [], widths: {} }
      : userViews(views.value).find((x) => x.id === id)
    if (!v) return
    sorts.value = Array.isArray(v.sorts) ? v.sorts : []
    customWidths.value = v.widths || {}
    if (Array.isArray(v.order) && v.order.length) settings.value = { ...settings.value, order: v.order }
    if (typeof applySnapshot === 'function') applySnapshot(v.filters || {})
    persist()
  }

  const createView = (name, filters) => {
    const v = makeView(name, currentSnapshot(filters))
    views.value = [...views.value, v]
    activeViewId.value = v.id
    persist()
    return v
  }
  const renameView = (id, name) => {
    views.value = views.value.map((v) => (v.id === id ? { ...v, name } : v))
    persist()
  }
  const removeView = (id) => {
    views.value = views.value.filter((v) => v.id !== id)
    if (activeViewId.value === id) activeViewId.value = VIEW_FILTERED
    persist()
  }

  return {
    settings, colDefs, visibleDefs, colWidths, sortedRows,
    sorts, sortState, sortPriority, onSort,
    customWidths, autoColumnWidth, onResize, resetWidths, onWidthsChange, onAutoWidthChange,
    views, viewList, activeViewId, applyView, createView, renameView, removeView,
    load, persist,
  }
}

// 表头控件占位口径的唯一实现在 utils/tableWidth.js，这里再导出便于页面统一从此处引入
export { headerExtra }
