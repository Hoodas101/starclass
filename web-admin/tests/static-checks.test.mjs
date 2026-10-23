/**
 * 静态防回归检查（源码级，无需浏览器）
 *
 * 每一条都对应一个真实发生过的缺陷，靠「编译期不会报错、运行时才炸」的类型：
 *  1. `$t` 出现在 <script> 块内 —— `$t` 只挂在 app.config.globalProperties，仅模板可用。
 *     在 setup 顶层引用会 ReferenceError 导致整页白屏（试听页真实发生过）。
 *  2. 用了 ColumnSettingsDialog 却没绑 @save —— 显隐/顺序改了不落盘，刷新即丢。
 *  3. SortableHeader 未传 :align —— 数字列右对齐时表头错位。
 *
 * 运行：node tests/static-checks.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

let pass = 0
let fail = 0
const rec = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : '  -> ' + detail}`)
}

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

const files = walk(SRC)
const rel = (p) => path.relative(SRC, p)
const read = (p) => fs.readFileSync(p, 'utf-8')

console.log('\n=== 静态防回归检查 ===\n')

// ===== [1] $t 不得出现在 script 块内 =====
console.log('[1] $t 作用域')
{
  const bad = []
  for (const f of files) {
    const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(read(f))
    if (!m) continue
    m[1].split('\n').forEach((line, i) => {
      if (line.includes('$t(')) bad.push(`${rel(f)}:${i + 1} ${line.trim().slice(0, 70)}`)
    })
  }
  rec('★ 无 $t( 出现在 script 块内（否则运行时 ReferenceError）', bad.length === 0, bad.join(' | '))
}

// ===== [2] 字段设置必须接 @save =====
console.log('\n[2] 字段设置持久化接线')
{
  const users = files.filter((f) => read(f).includes('<ColumnSettingsDialog'))
  rec('存在使用 ColumnSettingsDialog 的页面', users.length > 0, '未找到')
  for (const f of users) {
    rec(`${rel(f)} 绑定了 @save`, /<ColumnSettingsDialog[\s\S]*?@save=/.test(read(f)), '缺少 @save')
  }
}

// ===== [3] SortableHeader 必须传 :align =====
console.log('\n[3] 表头对齐')
{
  const users = files.filter((f) => read(f).includes('<SortableHeader'))
  for (const f of users) {
    const src = read(f)
    const blocks = src.split('<SortableHeader').slice(1)
    const missing = blocks.filter((b) => {
      const tag = b.split('/>')[0]
      return !tag.includes(':align=')
    })
    rec(`${rel(f)} 每个 SortableHeader 都传 :align`, missing.length === 0, `${missing.length} 处缺失`)
  }
}

// ===== [4] 时间选择器取值必须兼容字符串 =====
// el-time-picker 配 value-format 后 v-model 是字符串，直接 .format() 会抛 TypeError
console.log('\n[4] 时间段取值兼容')
{
  const bad = []
  for (const f of files) {
    const src = read(f)
    if (!src.includes('value-format="HH:mm"')) continue
    for (const m of src.matchAll(/(\w+(?:Form|form)\.timeRange\[[01]\])\.format\(/g)) {
      bad.push(`${rel(f)} ${m[0]}`)
    }
  }
  rec('★ 无对 timeRange[x] 直接调 .format()', bad.length === 0, bad.join(' | '))
}

// ===== [5] 设计令牌唯一性 =====
// 对应 trycompai/crm 的 design.md 规则：同一语义只能有一个值。
// 曾经并存两代令牌（v3 --t-* / v4 --v4-*），同一个「成功」有两种绿、同一个按钮有两种圆角；
// v4 全站零引用却仍在导出，后人照它写新页面就会让两套配色都变成"在用"。
console.log('\n[5] 设计令牌唯一性')
{
  const styleFiles = []
  const walkCss = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walkCss(p)
      else if (e.name.endsWith('.scss') || e.name.endsWith('.vue')) styleFiles.push(p)
    }
  }
  walkCss(SRC)

  // 5-1 不得再引用第二代令牌（$v4- 或 var(--v4-）
  const v4 = []
  for (const f of styleFiles) {
    const src = read(f)
    for (const m of src.matchAll(/(\$v4-[\w-]+|var\(--v4-[\w-]+\))/g)) v4.push(`${rel(f)} ${m[0]}`)
  }
  rec('★ 无第二代设计令牌（$v4- / var(--v4-）', v4.length === 0, v4.slice(0, 3).join(' | '))

  // 5-2 焦点环必须走 --focus-ring，不得硬编码宽度
  const focus = []
  for (const f of styleFiles) {
    const src = read(f)
    for (const m of src.matchAll(/outline:\s*\d+px\s+solid/g)) focus.push(`${rel(f)} ${m[0]}`)
  }
  rec('★ 焦点环统一走 --focus-ring（无硬编码 px）', focus.length === 0, focus.slice(0, 3).join(' | '))

  // 5-3 遮罩必须走 --t-scrim，不得在 .el-overlay 上写死 rgba
  const overlay = read(path.join(SRC, 'styles/index.scss')).match(/\.el-overlay\s*\{[^}]*\}/)
  const scrimOk = !!overlay && overlay[0].includes('var(--t-scrim)')
  rec('★ 弹窗遮罩走 --t-scrim（浅深主题各自可见）', scrimOk, overlay ? overlay[0].slice(0, 80) : '未找到 .el-overlay')
}

console.log(`\n结果汇总：PASS ${pass}  FAIL ${fail}`)
process.exit(fail > 0 ? 1 : 0)
