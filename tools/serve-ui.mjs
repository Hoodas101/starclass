/**
 * serve-ui.mjs — 渲染巡检用的静态前端服务（镜像生产产物）
 *
 * 托管 web-admin/dist，并把 /api 反向代理到后端（默认 127.0.0.1:3001）。
 * 不用 vite dev：其依赖预构建会触发某些环境的批量删除守卫，与本项目的构建无关。
 *
 * 用法：
 *   node tools/serve-ui.mjs                      # 默认 3000 → 3001
 *   PORT=3000 API_HOST=127.0.0.1 API_PORT=3001 node tools/serve-ui.mjs
 *   DIST_DIR=/abs/path/to/dist node tools/serve-ui.mjs
 */
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = process.env.DIST_DIR || path.resolve(__dirname, '..', 'web-admin', 'dist')
const API_HOST = process.env.API_HOST || '127.0.0.1'
const API_PORT = Number(process.env.API_PORT || 3001)
const PORT = Number(process.env.PORT || 3000)

if (!fs.existsSync(DIST_DIR)) {
  console.error(`[serve-ui] 找不到构建产物目录：${DIST_DIR}\n请先执行 npm run build:web`)
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

http
  .createServer((req, res) => {
    if (req.url.startsWith('/api')) {
      const proxy = http.request(
        {
          host: API_HOST,
          port: API_PORT,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `${API_HOST}:${API_PORT}` },
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers)
          r.pipe(res)
        }
      )
      proxy.on('error', (e) => {
        res.writeHead(502)
        res.end('proxy error: ' + e.message)
      })
      req.pipe(proxy)
      return
    }

    let file = path.join(DIST_DIR, decodeURIComponent(req.url.split('?')[0]))
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST_DIR, 'index.html')
    const ext = path.extname(file)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  .listen(PORT, '127.0.0.1', () => console.log(`[serve-ui] UI → http://127.0.0.1:${PORT}  (dist: ${DIST_DIR}, api→ ${API_HOST}:${API_PORT})`))
