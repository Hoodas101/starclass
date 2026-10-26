/**
 * visual-sweep.mjs — 全页面渲染巡检 + 截图基线对比（纳入常规流程）
 *
 * 干啥：
 *   1) 用后端 /auth/login 拿 token，注入浏览器 localStorage，绕过 UI 登录的脆弱性；
 *   2) 遍历应用全部「页面」（各 Hub 的每一个页签 + 系统设置子页 + 关键弹窗/抽屉）；
 *   3) 对每一页采集：视口截图（用于与基线像素对比）、整页截图（人工复核）、
 *      控制台 error、>=400 的请求、以及多个断点宽度下的横向溢出；
 *   4) 与已提交的 baseline/ 做像素 diff（pngjs + pixelmatch），输出 JSON + Markdown 报告。
 *
 * 用法：
 *   node web-admin/tests/visual-sweep.mjs                 # 对比模式（CI 门禁）
 *   node web-admin/tests/visual-sweep.mjs --update        # 重新采集基线（设计变更后）
 *   node web-admin/tests/visual-sweep.mjs --fail-on-diff  # 视觉漂移也视为失败
 *
 * 环境变量：
 *   BASE_URL      前端静态服务地址（默认 http://127.0.0.1:3000）
 *   API_BASE      后端地址（默认 http://127.0.0.1:3001/api）
 *   ADMIN_PHONE / ADMIN_PASS  登录凭据（默认 13800000001 / Demo@2026）
 *   VIEWPORT_W / VIEWPORT_H   基线视口（默认 1440 / 900）
 *   MAX_DIFF_PCT  判定为「明显变化」的像素漂移阈值（默认 1.5）
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(__dirname, '..', '..')
const BASELINE_DIR = path.join(__dirname, 'baseline')
const SHOTS_DIR = path.join(__dirname, 'shots')
const LATEST_DIR = path.join(SHOTS_DIR, 'latest')

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000'
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3001/api'
const ADMIN_PHONE = process.env.ADMIN_PHONE || '13800000001'
const ADMIN_PASS = process.env.ADMIN_PASS || 'Demo@2026'
const MODE = process.argv.includes('--update') ? 'capture' : 'compare'
const FAIL_ON_DIFF = process.argv.includes('--fail-on-diff')
const VW = Number(process.env.VIEWPORT_W || 1440)
const VH = Number(process.env.VIEWPORT_H || 900)
const MAX_DIFF_PCT = Number(process.env.MAX_DIFF_PCT || 1.5)
const OVERFLOW_LIMIT = 2 // 视口下横向溢出超过 2px 视为问题

// 用于检出横向溢出的断点宽度
const BREAKPOINTS = [1280, 1024, 768, 390]

// ───────────────────────── 加载 playwright（兼容全局安装） ─────────────────────────
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/homebrew/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright',
    process.env.PLAYWRIGHT_PATH,
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      const m = require(c)
      const pw = m && m.chromium ? m : m && m.default && m.default.chromium ? m.default : null
      if (pw) return pw
    } catch {
      /* 下一个候选 */
    }
  }
  throw new Error('无法加载 playwright，请确认已安装（npm i -D playwright 或全局安装）')
}

// ───────────────────────── 全部页面清单 ─────────────────────────
// action 在截图前执行；actions 为有序数组（可串联，如「切到实物商品 → 打开新建弹窗」）。
const TARGETS = [
  { id: 'login', path: '/login', auth: false },
  { id: 'dashboard', path: '/dashboard', auth: true },

  // 教学运营 Hub
  { id: 'ops-classes', path: '/operations?tab=classes', auth: true },
  { id: 'ops-schedule', path: '/operations?tab=schedule', auth: true },
  { id: 'ops-checkin', path: '/operations?tab=checkin', auth: true },
  { id: 'ops-leave', path: '/operations?tab=leave', auth: true },
  { id: 'ops-attendance', path: '/operations?tab=attendance', auth: true },
  { id: 'ops-makeup', path: '/operations?tab=makeup', auth: true },

  // 学员档案 Hub
  { id: 'students-main', path: '/students?tab=students', auth: true },
  { id: 'students-drawer', path: '/students?tab=students', auth: true, actions: ['studentDrawer'] },
  { id: 'students-points', path: '/students?tab=points', auth: true },

  // 销售增长 Hub
  { id: 'sales-orders', path: '/sales?tab=orders', auth: true },
  { id: 'sales-products', path: '/sales?tab=products', auth: true },
  { id: 'products-card-dialog', path: '/sales?tab=products', auth: true, actions: ['cardDialog'] },
  { id: 'sales-products-goods', path: '/sales?tab=products', auth: true, actions: ['goodsMode'] },
  { id: 'sales-products-goods-dialog', path: '/sales?tab=products', auth: true, actions: ['goodsMode', 'goodsDialog'] },
  { id: 'sales-finance', path: '/sales?tab=finance', auth: true },
  { id: 'sales-growth', path: '/sales?tab=growth', auth: true },
  { id: 'sales-trial', path: '/sales?tab=trial', auth: true },

  // 家校沟通 Hub（管理专属）
  { id: 'parents-dir', path: '/parents?tab=parents', auth: true },
  { id: 'parents-notif', path: '/parents?tab=notifications', auth: true },
  { id: 'parents-feedback', path: '/parents?tab=feedback', auth: true },

  // 团队管理 Hub
  { id: 'staff-employees', path: '/staff?tab=staff', auth: true },
  { id: 'staff-coachstats', path: '/staff?tab=coachstats', auth: true },

  // 个人设置 + 系统设置
  { id: 'profile', path: '/profile', auth: true },
  { id: 'settings-default', path: '/settings', auth: true },
  ...['机构信息', '称呼设置', '积分规则', '推送规则', '退费规则', '订阅卡规则', '请假规则', '看板设置', '数据备份', '操作日志']
    .map((label) => ({ id: `settings-${label}`, path: '/settings', auth: true, actions: [{ type: 'settingsTab', label }] })),
]

// ───────────────────────── 工具函数 ─────────────────────────
function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

async function apiLogin() {
  const passwords = [ADMIN_PASS, '123456']
  for (const pw of passwords) {
    const res = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: ADMIN_PHONE, role: 'admin', password: pw }),
    })
    const json = await res.json().catch(() => ({}))
    if (json && json.code === 0 && json.data && json.data.token) {
      // 默认口令会触发「强制改密」，token 带 mcp=1，前端会弹回改密页。
      // 巡检用隔离 demo 库，这里直接改成非默认口令，拿到干净 token（mcp=0），
      // 否则每个已登录页面都会被前端重定向到 /profile，截图全错。
      if (json.data.mustChangePassword) {
        await fetch(API_BASE + '/auth/changePassword', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${json.data.token}` },
          body: JSON.stringify({ oldPassword: pw, newPassword: ADMIN_PASS }),
        })
        return apiLoginWith(ADMIN_PASS)
      }
      return { token: json.data.token, user: json.data }
    }
  }
  throw new Error(`登录失败（已尝试 ${ADMIN_PASS} 与默认 123456）`)
}

async function apiLoginWith(pw) {
  const res = await fetch(API_BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: ADMIN_PHONE, role: 'admin', password: pw }),
  })
  const json = await res.json().catch(() => ({}))
  if (json && json.code === 0 && json.data && json.data.token) {
    return { token: json.data.token, user: json.data }
  }
  throw new Error('改密后重新登录失败')
}

async function runAction(page, action) {
  const a = typeof action === 'string' ? { type: action } : action
  try {
    switch (a.type) {
      case 'goodsMode': {
        await page.locator('.el-select').first().click({ timeout: 5000 })
        await page.waitForTimeout(250)
        await page.locator('.el-select-dropdown__item', { hasText: '其他商品' }).first().click({ timeout: 5000 })
        await page.waitForTimeout(400)
        break
      }
      case 'goodsDialog': {
        await page.getByRole('button', { name: '新建商品' }).click({ timeout: 5000 })
        await page.waitForTimeout(450)
        break
      }
      case 'cardDialog': {
        await page.locator('.el-table__row').first().click({ timeout: 5000 })
        await page.waitForTimeout(450)
        break
      }
      case 'studentDrawer': {
        await page.locator('.el-table__row').first().click({ timeout: 5000 })
        await page.waitForTimeout(550)
        break
      }
      case 'settingsTab': {
        await page.locator('.nav-group [role="button"]', { hasText: a.label }).first().click({ timeout: 5000 })
        await page.waitForTimeout(350)
        break
      }
      default:
        break
    }
  } catch (e) {
    console.warn(`  ⚠ action ${a.type} 执行失败：${e.message}`)
  }
}

async function measureOverflow(page) {
  const out = []
  for (const w of BREAKPOINTS) {
    await page.setViewportSize({ width: w, height: VH })
    await page.waitForTimeout(250)
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
    }))
    const overflow = Math.max(0, r.sw - r.iw)
    out.push({ width: w, overflow })
  }
  await page.setViewportSize({ width: VW, height: VH })
  await page.waitForTimeout(150)
  return out
}

// 像素对比：尺寸不一致时把多余像素计入「变化」，避免误判为一致
function diffImages(fileA, fileB, outPath) {
  const pa = PNG.sync.read(fs.readFileSync(fileA))
  const pb = PNG.sync.read(fs.readFileSync(fileB))
  const w = Math.min(pa.width, pb.width)
  const h = Math.min(pa.height, pb.height)
  const total = Math.max(pa.width * pa.height, pb.width * pb.height)
  const ca = pa.data.subarray(0, w * h * 4)
  const cb = pb.data.subarray(0, w * h * 4)
  const out = new PNG({ width: w, height: h })
  const mismatch = pixelmatch(ca, cb, out.data, w, h, { threshold: 0.1 })
  const extra = pa.width * pa.height - w * h + (pb.width * pb.height - w * h)
  const changed = mismatch + extra
  const pct = total > 0 ? (changed / total) * 100 : 0
  if (changed > 0) fs.writeFileSync(outPath, PNG.sync.write(out))
  return { changed, total, pct }
}

// ───────────────────────── 主流程 ─────────────────────────
async function main() {
  const pw = await loadPlaywright()
  ensureDir(BASELINE_DIR)
  ensureDir(LATEST_DIR)
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = MODE === 'capture' ? BASELINE_DIR : path.join(SHOTS_DIR, `run-${runStamp}`)
  ensureDir(runDir)

  console.log(`\n▶ 视觉巡检 [${MODE}]  BASE_URL=${BASE_URL}  API_BASE=${API_BASE}  VWxVH=${VW}x${VH}`)
  console.log(`  输出目录：${runDir}`)

  const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] })

  // 匿名上下文（登录页专用，不注入 token）
  const anonContext = await browser.newContext({ viewport: { width: VW, height: VH } })
  // 已登录上下文：注入 token + 用户信息，绕过 UI 登录脆弱性
  const { token, user } = await apiLogin()
  const authContext = await browser.newContext({ viewport: { width: VW, height: VH } })
  await authContext.addInitScript(
    ({ token, user }) => {
      try {
        localStorage.setItem('edu_token', token)
        localStorage.setItem('edu_user_info', JSON.stringify(user))
      } catch (e) { /* ignore */ }
    },
    { token, user }
  )

  const results = []

  for (const t of TARGETS) {
    const ctx = t.auth ? authContext : anonContext
    const page = await ctx.newPage()
    const consoleErrors = []
    const failedRequests = []
    const onConsole = (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) }
    const onResponse = (resp) => { if (resp.status() >= 400) failedRequests.push(`${resp.status()} ${resp.url()}`) }
    const onReqFail = (req) => failedRequests.push(`REQFAIL ${req.url()} ${req.failure()?.errorText || ''}`)
    page.on('console', onConsole)
    page.on('response', onResponse)
    page.on('requestfailed', onReqFail)

    const url = BASE_URL + t.path
    process.stdout.write(`• ${t.id.padEnd(26)} `)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => consoleErrors.push('goto: ' + e.message))
    await page.waitForSelector('.app-shell, .main-layout, .page-shell, .hub-tabs, .login-page', { timeout: 15000 }).catch(() => {})

    if (Array.isArray(t.actions)) {
      for (const act of t.actions) await runAction(page, act)
    } else if (t.actions) {
      await runAction(page, t.actions)
    }

    await page.waitForTimeout(450)

    // 基准视口截图（用于对比）
    const shotPath = path.join(runDir, `${t.id}.png`)
    await page.screenshot({ path: shotPath })
    // 整页截图（人工复核长页面）
    const fullPath = path.join(runDir, `${t.id}-full.png`)
    await page.screenshot({ path: fullPath, fullPage: true })
    // 横向溢出（多断点）
    const overflow = await measureOverflow(page)

    page.off('console', onConsole)
    page.off('response', onResponse)
    page.off('requestfailed', onReqFail)
    await page.close()

    // 对比基线
    let diff = null
    const basePath = path.join(BASELINE_DIR, `${t.id}.png`)
    if (fs.existsSync(basePath) && MODE === 'compare') {
      const diffPath = path.join(runDir, `${t.id}.diff.png`)
      diff = diffImages(shotPath, basePath, diffPath)
    }

    // 同步到 latest 供快速查看
    fs.copyFileSync(shotPath, path.join(LATEST_DIR, `${t.id}.png`))
    fs.copyFileSync(fullPath, path.join(LATEST_DIR, `${t.id}-full.png`))

    const baseOverflow = overflow.find((o) => o.width === VW)?.overflow ?? overflow[0]?.overflow ?? 0
    const worstOverflow = overflow.reduce((m, o) => Math.max(m, o.overflow), 0)
    const hasHardIssue = consoleErrors.length > 0 || failedRequests.length > 0 || baseOverflow > OVERFLOW_LIMIT
    let status = 'ok'
    if (diff) {
      if (diff.pct >= MAX_DIFF_PCT) status = 'changed'
      else if (diff.pct > 0.05) status = 'minor'
    } else if (MODE === 'compare' && !fs.existsSync(basePath)) {
      status = 'new-baseline'
    }
    if (hasHardIssue) status = 'issue'

    results.push({
      id: t.id,
      path: t.path,
      status,
      consoleErrors,
      failedRequests,
      overflow,
      worstOverflow,
      baseOverflow,
      diffPct: diff ? Number(diff.pct.toFixed(3)) : null,
      baselineExists: fs.existsSync(basePath),
    })
    const tag = hasHardIssue ? '⛔' : diff ? (status === 'changed' ? '🔺' : '🔹') : '✅'
    process.stdout.write(`${tag}  err=${consoleErrors.length} fail=${failedRequests.length} ovf=${baseOverflow}px${diff ? ` diff=${diff.pct.toFixed(2)}%` : ''}\n`)
  }

  await anonContext.close()
  await authContext.close()
  await browser.close()

  // ───── 报告 ─────
  const issues = results.filter((r) => r.status === 'issue')
  const changed = results.filter((r) => r.status === 'changed')
  const minor = results.filter((r) => r.status === 'minor')
  const news = results.filter((r) => r.status === 'new-baseline')
  const ok = results.filter((r) => r.status === 'ok')

  const report = {
    mode: MODE,
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
    viewport: `${VW}x${VH}, breakpoints:${BREAKPOINTS.join('/')}`,
    summary: { total: results.length, ok: ok.length, minor: minor.length, changed: changed.length, issue: issues.length, newBaseline: news.length },
    pages: results,
  }
  const reportPath = path.join(runDir, 'REPORT.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

  const md = [
    `# 视觉巡检报告 — ${MODE} @ ${report.timestamp}`,
    '',
    `视口：${report.viewport}`,
    '',
    `| 状态 | 页数 |`,
    `| --- | --- |`,
    `| ✅ 一致 | ${ok.length} |`,
    `| 🔹 轻微漂移(<${MAX_DIFF_PCT}%) | ${minor.length} |`,
    `| 🔺 明显变化(>=${MAX_DIFF_PCT}%) | ${changed.length} |`,
    `| ⛔ 问题(报错/失败请求/溢出) | ${issues.length} |`,
    `| 🆕 新基线 | ${news.length} |`,
    '',
    `## 明细`,
    '',
    `| 页面 | 状态 | 控制台错误 | 失败请求 | 基准溢出 | 最差溢出 | 漂移% |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    ...results.map((r) =>
      `| ${r.id} | ${r.status} | ${r.consoleErrors.length} | ${r.failedRequests.length} | ${r.baseOverflow}px | ${r.worstOverflow}px | ${r.diffPct == null ? '-' : r.diffPct + '%'} |`
    ),
    '',
    issues.length ? `## ⛔ 问题页明细` : `## 问题页明细（无）`,
    ...issues.flatMap((r) => [
      `### ${r.id} (${r.path})`,
      ...(r.consoleErrors.length ? ['**控制台错误:**', ...r.consoleErrors.map((e) => `  - ${e}`)] : []),
      ...(r.failedRequests.length ? ['**失败请求:**', ...r.failedRequests.map((e) => `  - ${e}`)] : []),
      ...(r.baseOverflow > OVERFLOW_LIMIT ? [`**基准视口横向溢出:** ${r.baseOverflow}px`] : []),
      ...(r.overflow.filter((o) => o.overflow > 0).map((o) => `  - ${o.width}px 宽度下溢出 ${o.overflow}px`)),
      '',
    ]),
    '',
  ].join('\n')
  fs.writeFileSync(path.join(runDir, 'REPORT.md'), md)

  console.log(`\n──────── 汇总 ────────`)
  console.log(`总页: ${results.length} | ✅${ok.length} 🔹${minor.length} 🔺${changed.length} ⛔${issues.length} 🆕${news.length}`)
  if (issues.length) {
    console.log('问题页:')
    issues.forEach((r) => console.log(`  - ${r.id}: err=${r.consoleErrors.length} fail=${r.failedRequests.length} ovf=${r.baseOverflow}px`))
  }
  if (changed.length && !FAIL_ON_DIFF) console.log(`🔺 ${changed.length} 页视觉漂移（未开启 --fail-on-diff，仅提示）`)
  console.log(`报告: ${reportPath}`)

  // 退出码：硬问题一律失败；--fail-on-diff 时明显漂移也算失败
  const hardFail = issues.length > 0
  const diffFail = FAIL_ON_DIFF && changed.length > 0
  process.exit(hardFail || diffFail ? 1 : 0)
}

main().catch((e) => {
  console.error('视觉巡检异常:', e)
  process.exit(2)
})
