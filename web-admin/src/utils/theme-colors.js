// 共享调色板常量 —— 与 src/styles/variables.scss / index.scss 的 --t-chart-* / --t-class-fallback 保持一致。
// ECharts / 运行时 JS 不读 CSS 变量的场景，统一从此处取值；暗色主题下优先读 CSS 变量，
// 保证与 index.scss 的 html[data-theme='dark'] token 块同步（切主题后重绘即可换色）。
//
// 响应式约定：本文件函数会在组件 render 期间被调用（模板 :style 绑定），
// 内部读取 themeTick 即可让「主题切换」触发这些组件重渲染，派生色随之更新。
import { themeTick } from './theme'

// 班级 / 课程默认色（亮色主题值；作为 CSS 变量不可用时的兜底）
export const CLASS_FALLBACK = '#0071e3'

// 图表调色板（亮色值；与 --t-chart-1..6 对应，两处必须同步修改）
// 已改为「色盲安全序列」并整体压暗：避免相邻红绿对撞，且每色对白底 ≥3:1（WCAG 1.4.11）。
// 明细与依据见 src/styles/index.scss 的 --t-chart-* 注释。
export const CHART_PALETTE = ['#0071e3', '#C93400', '#6D28D9', '#DB2777', '#0F766E', '#B45309']

// 教师配色（周视图等按教师区分场景），首项与班级默认色一致
export const TEACHER_COLORS = [
  '#0071e3', '#34C759', '#FF9500', '#FF3B30',
  '#AF52DE', '#FF2D55', '#FF9F0A', '#30D158'
]

function cssVar(name, fallback = '') {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

// 在组件 render 期间调用可建立对主题切换的响应式依赖（主题变化 → 组件重渲染 → 派生色更新）
function reactToTheme() {
  void themeTick.value
}

// 读取运行时班级默认色（暗色主题下为 #0A84FF），保证 JS 侧与 CSS 同步
export function classFallback() {
  reactToTheme()
  return cssVar('--t-class-fallback', CLASS_FALLBACK)
}

// 主题感知的图表调色板：优先读 --t-chart-1..6，缺失时回落亮色常量
export function chartPalette() {
  const out = []
  for (let i = 1; i <= 6; i++) out.push(cssVar(`--t-chart-${i}`, CHART_PALETTE[i - 1]))
  return out
}

// 主题感知的教师配色：亮色沿用固定苹果色板；暗色下提亮同名色以贴合深色底
export function teacherColors() {
  if (isDarkTheme()) {
    return ['#0A84FF', '#30D158', '#FF9F0A', '#FF453A', '#BF5AF2', '#FF375F', '#FFD60A', '#64D2FF']
  }
  return TEACHER_COLORS
}

// 读取当前是否暗色主题
export function isDarkTheme() {
  if (typeof document === 'undefined') return false
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

// 课程文字色：亮色主题压暗保证浅色课程色在浅底可读；暗色主题提亮保证在深底可读
export function courseTextColor(hex) {
  reactToTheme()
  if (!hex) return classFallback()
  const m = hex.replace('#', '')
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  let r = parseInt(full.slice(0, 2), 16)
  let g = parseInt(full.slice(2, 4), 16)
  let b = parseInt(full.slice(4, 6), 16)
  if (isDarkTheme()) {
    // 暗色：向白色提亮，保证文字在深色卡面上有足够对比
    const mix = (c) => Math.round(c + (255 - c) * 0.55)
    r = mix(r); g = mix(g); b = mix(b)
  } else {
    r = Math.round(r * 0.45); g = Math.round(g * 0.45); b = Math.round(b * 0.45)
  }
  return `rgb(${r}, ${g}, ${b})`
}
