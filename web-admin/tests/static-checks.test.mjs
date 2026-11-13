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
import { createHash } from 'node:crypto'

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

// ===== [6] 样式层叠与组件样式完整性 =====
// 这两条都是「渲染出来才发现」的缺陷，静态检查能提前挡住：
//   · 基规则用 !important 时，修饰规则若不带 !important 就永远不生效（文字按钮被画成实心块）；
//   · 按需引入时 ElFormItem 解析到 form 目录，el-form-item.css 不在包里（全站表单没行间距）。
console.log('\n[6] 样式层叠与组件样式完整性')
{
  // 先剥掉注释：注释里常引用「旧写法」做对照（如 `.el-button.is-text { color: accent }`），
  // 不剥会被当成真实代码，守卫就变成误报源。
  const scss = read(path.join(SRC, 'styles/index.scss'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  // 6-1 若 .el-button--primary 的 background 带 !important，
  //     则 .el-button.is-text.el-button--primary 也必须带，否则修饰规则被压制
  // 只看「嵌套块之前」的顶层声明：块内还有 &:hover，其中同样写了
  // background: ... !important，直接对整块取正则会把 hover 的 !important 误当成主体声明
  //（守卫会永远 PASS，等于没有守卫）。
  const topDecls = (block) => (block ? block.slice(block.indexOf('{') + 1).split('&')[0] : '')
  const baseBlock = scss.match(/\.el-button--primary\s*\{[^}]*\}/)
  const baseImportant = /background\s*:[^;]*!important/.test(topDecls(baseBlock && baseBlock[0]))
  const modBlock = scss.match(/\.el-button\.is-text\.el-button--primary\s*\{[^}]*\}/)
  const modImportant = /background\s*:[^;]*!important/.test(topDecls(modBlock && modBlock[0]))
  rec('★ 文字型主按钮的修饰规则不被 !important 压制', !baseImportant || modImportant,
    baseImportant && !modImportant ? '基规则带 !important，修饰规则未带 → 会被渲染成实心按钮' : '')

  // 6-2 文字按钮的默认色必须限定「无 type」，否则会盖掉 warning/danger 等语义色
  const plainTextBtn = scss.match(/\.el-button\.is-text(?![\.\w-])\s*\{[^}]*color/ )
  rec('★ 文字按钮默认色不覆盖语义类型色', !plainTextBtn,
    plainTextBtn ? '.el-button.is-text 无条件设 color，会盖掉 warning/danger 语义色' : '')

  // 6-3 ElFormItem 的样式必须显式引入（按需解析器只带 el-form.css）
  const main = read(path.join(SRC, 'main.js'))
  rec('★ 已显式引入 el-form-item 样式', main.includes('form-item/style/css'),
    main.includes('form-item/style/css') ? '' : 'main.js 缺 form-item/style/css → 表单无行间距、错误提示错位')
}

// [7] CSP 与首屏内联主题脚本的 sha256 必须一致
// index.html 的内联脚本在首帧设置 data-theme，CSP 只能用哈希放行。哈希与脚本**原文**
//（含首尾空白）强绑定：改脚本、换构建工具或重建产物后忘记重算，暗色首帧会白闪，
// 而编译期完全不报错。此处同时校验源与构建产物，避免只改一边的漂移。
{
  const server = fs.readFileSync(path.resolve(SRC, '../../backend/server.js'), 'utf8')
  const csp = (server.match(/Content-Security-Policy',\s*"([^"]+)"/) || [])[1] || ''
  const declared = [...csp.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1])
  // HTML 解析器按规范把源码里的 CRLF 规范化为 LF 后再校验内联脚本哈希；
  // Node 读到的是原始字节（本项目 index.html 为 CRLF），直接哈希得到 AF2W… 而非浏览器
  // 实际校验的 EFh1…，会产生两条恒定 FAIL 的误报。此处与浏览器口径对齐。
  const inlineHash = (file) => {
    const m = fs.readFileSync(file, 'utf8').match(/<script>([\s\S]*?)<\/script>/)
    if (!m) return ''
    return createHash('sha256').update(m[1].replace(/\r\n/g, '\n'), 'utf8').digest('base64')
  }
  const srcHash = inlineHash(path.resolve(SRC, '../index.html'))
  rec('★ CSP 声明了源 index.html 内联脚本的 sha256', !!srcHash && declared.includes(srcHash),
    `src=${srcHash || 'missing'} declared=[${declared.join(', ') || 'none'}]`)
  // dist 被 .gitignore 忽略，CI 全新 checkout 时不存在。不能判 FAIL（流程是先 test 后 build），
  // 但也不能静默跳过：显式打印 SKIP，让运维知道产物哈希这一层本次没有覆盖。
  const distPath = path.resolve(SRC, '../dist/index.html')
  if (fs.existsSync(distPath)) {
    const distHash = inlineHash(distPath)
    rec('★ CSP 声明了构建产物内联脚本的 sha256', !!distHash && declared.includes(distHash),
      `dist=${distHash || 'missing'}；若与源不同请重建 dist 或重算哈希`)
  } else {
    console.log('  [SKIP] dist/index.html 未构建，跳过产物哈希校验（构建后重跑将自动覆盖）')
  }
}

// [8] 第五轮加固：破坏性操作二次确认、Hub 运行时 URL 回退
// 两条都是「编译期不报错、运行时才体现」的交互缺陷，靠静态守卫防复发。
console.log('[8] 第五轮加固静态守卫')
{
  const parents = read(path.join(SRC, 'views/parents/index.vue'))
  const start = parents.indexOf('const removeSuppression')
  const end = parents.indexOf('const error =', start)
  const seg = start >= 0 ? parents.slice(start, end > start ? end : start + 900) : ''
  // 只判断字符串存在会被「把 DELETE 挪到 confirm 之前」骗过：
  // 必须校验控制流顺序 —— confirm 在前、删除请求在后、且取消分支 return。
  const confirmAt = seg.indexOf('ElMessageBox.confirm')
  const delAt = seg.indexOf('deleteSuppression(')
  rec('★ 勿扰名单「移除」必须二次确认（U9）',
    !!seg && confirmAt >= 0 && delAt > confirmAt && seg.includes('return'),
    'removeSuppression 的确认框必须在删除请求之前，且取消分支 return；否则误点即生效')

  const hubDir = path.join(SRC, 'views/hubs')
  const hubs = fs.readdirSync(hubDir).filter((f) => f.endsWith('Hub.vue'))
  const bad = []
  for (const h of hubs) {
    const src = read(path.join(hubDir, h))
    const idx = src.indexOf('watch(route')
    const w = idx >= 0 ? src.slice(idx, idx + 900) : ''
    // 初始化阶段的 onMounted 回退（B5）不能覆盖运行时 URL 变更，故必须检查 watch 段
    if (!w.includes('router.replace') || !w.includes('visibleTabs.value.some')) bad.push(h)
  }
  rec('★ 5 个 Hub 运行时不可见页签回退 URL（U11）',
    hubs.length === 5 && bad.length === 0,
    `Hub 数 ${hubs.length}；缺运行时回退：[${bad.join(', ') || '无'}]`)
}

// [9] 第六轮修复防复发守卫
// 四条都曾被「补丁自身」或「旧实现」引入，且编译期完全不报错。
console.log('\n[9] 第六轮修复防复发守卫')
{
  const finance = read(path.join(SRC, 'views/finance/index.vue'))
  rec('★ 财务年份下拉不得直绑带 seq 形参的加载函数',
    /@change="loadAll"/.test(finance) && !/@change="loadMonthly"/.test(finance),
    'el-select 的 @change 首参是年份数值，直绑 loadMonthly 会顶替 seq 导致响应被丢弃、loading 卡死')

  const router = read(path.join(SRC, 'router/index.js'))
  // 只看实际 return 行，避免注释里描述旧写法的字面量造成误报
  const tokenReturn = (router.match(/return\s+Number\.isFinite\(payload\.exp\)[^\n]*/) || [])[0] || ''
  rec('★ JWT 可用性必须校验 exp 为有限正数（不接受 !payload.exp）',
    router.includes('Number.isFinite(payload.exp)')
      && !/return\s+!payload\.exp/.test(router)
      && tokenReturn.includes('payload.exp > 0')
      && tokenReturn.includes('Date.now()'),
    '旧写法 !payload.exp 会把 exp=0 / 缺失 / 字符串全部放行，伪造三段式 token 可进页面壳')

  const attendance = read(path.join(SRC, 'views/attendance-records/index.vue'))
  rec('★ CSV 公式注入守卫须剔除零宽/双向/软连字符',
    attendance.includes('CSV_INVISIBLE') && /\\u200B/.test(attendance),
    '仅靠 [\\s\\uFEFF]* 会被 \\u200B=1+1 之类的前缀绕过')

  const xlsx = read(path.join(SRC, 'utils/xlsx.js'))
  rec('★ 多表模式判定须扫描全部表描述（不能只看首元素）',
    xlsx.includes('headers.some(isSheetDesc)') && /used\.has/.test(xlsx),
    '首元素为 null 时只判 headers[0] 会把整份 sheets 当成单表表头；同名/History 会让 Excel 报损坏')
}

console.log(`\n结果汇总：PASS ${pass}  FAIL ${fail}`)
process.exit(fail > 0 ? 1 : 0)
