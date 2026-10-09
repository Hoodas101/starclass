/**
 * 视图模型：一套「筛选条件 + 排序规则 + 字段顺序 + 列宽」的快照，可多套并存切换。
 *
 * 两个系统视图**不可删**，保证任何时候都有安全落点（用户删光自定义视图后
 * 仍能一键回到「全部成员」，不会卡在某个筛选态里出不来）。
 */

export const VIEW_ALL = '__all__'
export const VIEW_FILTERED = '__filtered__'

export const SYSTEM_VIEWS = [
  { id: VIEW_ALL, name: '全部成员', system: true },
  { id: VIEW_FILTERED, name: '当前筛选', system: true },
]

const isSystem = (id) => SYSTEM_VIEWS.some((s) => s.id === id)

/** 用户视图列表（过滤掉 id 非法或与系统视图重名的脏数据） */
export const userViews = (raw) => (Array.isArray(raw) ? raw.filter((v) => v && v.id && v.name && !isSystem(v.id)) : [])

/** 全部视图 = 系统视图 + 用户视图 */
export const allViews = (raw) => [...SYSTEM_VIEWS, ...userViews(raw)]

/** 新建视图：name + 当前快照（筛选/排序/字段顺序/列宽） */
export const makeView = (name, snapshot = {}) => ({
  id: `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  name: String(name || '').trim().slice(0, 12) || '新视图',
  filters: snapshot.filters || {},
  sorts: Array.isArray(snapshot.sorts) ? snapshot.sorts : [],
  order: Array.isArray(snapshot.order) ? snapshot.order : [],
  widths: snapshot.widths || {},
})

export const isSystemView = isSystem
