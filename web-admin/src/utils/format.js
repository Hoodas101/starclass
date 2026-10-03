// 相对时间（借鉴 trycompai/crm 的 relativeTimeFromIso）
export const relativeTime = (ts) => {
  if (!ts) return '—'
  const n = Number(ts)
  if (Number.isNaN(n)) return String(ts)
  const diff = Date.now() - n
  const min = 60 * 1000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  const d = new Date(n)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const relativeDue = (ts) => {
  if (!ts) return '—'
  const n = Number(ts)
  const diff = n - Date.now()
  const hour = 60 * 60 * 1000
  const day = 24 * hour
  if (diff < 0) return `已逾期 ${relativeTime(n)}`
  if (diff < hour) return `${Math.max(1, Math.round(diff / (60 * 1000)))} 分钟后`
  if (diff < day) return `${Math.round(diff / hour)} 小时后`
  if (diff < 7 * day) return `${Math.round(diff / day)} 天后`
  const d = new Date(n)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 会员卡“不限有效期”哨兵时间戳（2100-01-01，次数卡无期限时使用） */
export const CARD_NO_EXPIRY_TS = 4102444800000

export const isCardNoExpiry = (ts) => !!ts && Number(ts) >= CARD_NO_EXPIRY_TS

export const formatCardExpiry = (ts) => {
  if (!ts) return '—'
  if (isCardNoExpiry(ts)) return '不限'
  const d = new Date(Number(ts))
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ============================================================================
// 金额 / 数字 / 日期 —— 全站统一口径（2026-10 审计修复新增）
//
// 背景：审计实测同一笔订单在财务页显示 ¥2,999.00、在订单页显示 ¥2,999，
// 学员详情侧栏同一屏出现 ¥4997 与 ¥4,997 两种写法 —— 用户会以为金额变了。
// 根因是各页各自调 toLocaleString() / 自拼千分位，没有单一实现。
//
// 口径决策：**金额一律整数元 + 千分位**。理由：
//   · 系统全库金额列均为 INTEGER（整数元），不存在分位精度；
//   · 强制 2 位小数（¥2,999.00）会在整数数据上凭空多出「.00」噪音，
//     且与其余页不一致，制造「金额变了」的错觉。
// 若将来引入分位精度，只需改这一个函数。
// ============================================================================

/**
 * 金额格式化（整数元 + 千分位）。
 * @param {*} v 金额（元）
 * @param {{symbol?: boolean, decimals?: number, fallback?: string}} [opts]
 *        symbol=false 时不含 ¥ 前缀；decimals 默认 0（整数元）
 * @returns {string} 例：¥4,997 / 4,997
 */
export const formatMoney = (v, opts = {}) => {
  const { symbol = true, decimals = 0, fallback = '¥0' } = opts
  const n = Number(v)
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return fallback
  const s = n.toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return symbol ? `¥${s}` : s
}

/**
 * 数字格式化（千分位，默认 0 位小数）。课时/次数/人数等非金额数值用这个。
 * @returns {string} 例：1,254
 */
export const formatNumber = (v, decimals = 0) => {
  const n = Number(v)
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return '0'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 解析成 Date：兼容 epoch 毫秒数字、'YYYY-MM-DD'、ISO 字符串 */
const toDate = (v) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' || /^\d{10,}$/.test(String(v))) {
    const d = new Date(Number(v))
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * 标准日期格式：全站统一 YYYY-MM-DD（排期页此前同屏并存 MM/DD、MM月DD日、
 * YYYY-MM-DD 三种写法，用户无法判断哪个是权威日期）。
 * @returns {string} 例：2026-10-03；无法解析时返回 fallback（默认 '—'）
 */
export const formatDate = (v, fallback = '—') => {
  const d = toDate(v)
  if (!d) return fallback
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 中文短日期：MM月DD日（仅用于空间受限的表头/导航，语义需与 formatDate 一致） */
export const formatDateCn = (v, fallback = '—') => {
  const d = toDate(v)
  if (!d) return fallback
  return `${pad2(d.getMonth() + 1)}月${pad2(d.getDate())}日`
}

/** 日期 + 时间：YYYY-MM-DD HH:mm */
export const formatDateTime = (v, fallback = '—') => {
  const d = toDate(v)
  if (!d) return fallback
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
