#!/bin/bash
# ========================================
#  教务系统一键启动（后端 + 管理端）
#  私有化部署 · 本地运行
# ========================================

GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}${CYAN}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║       教务系统 — 一键启动                      ║"
echo "  ║       Node.js + Express + SQLite              ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

cd "$(dirname "$0")"

# ─── 0. 依赖检查 ───
if [ ! -d "backend/node_modules" ]; then
  echo -e "\n${BOLD}━━━ 安装后端依赖 ━━━${NC}"
  (cd backend && npm install)
fi
if [ ! -d "web-admin/node_modules" ]; then
  echo -e "\n${BOLD}━━━ 安装管理端依赖 ━━━${NC}"
  (cd web-admin && npm install)
fi

# ─── 1. 初始化数据库（如果不存在）───
if [ ! -f "backend/db/data.db" ]; then
  echo -e "\n${BOLD}━━━ 初始化数据库 ━━━${NC}"
  cd backend
  node db/init.js
  node db/seed.js
  cd ..
else
  echo -e "\n${GREEN}✓ 数据库已存在${NC}"
fi

# ─── 1.5 构建管理端单入口（缺少构建产物或源码比产物新时重建）───
if [ ! -f "web-admin/dist/index.html" ] || [ -n "$(find web-admin/src -newer web-admin/dist/index.html -print -quit 2>/dev/null)" ]; then
  echo -e "\n${BOLD}━━━ 构建管理端（单入口 :3001 可用）━━━${NC}"
  (cd web-admin && npm run build)
else
  echo -e "\n${GREEN}✓ 管理端构建产物已是最新${NC}"
fi

# ─── 2. 启动后端 ───
echo -e "\n${BOLD}━━━ 启动后端服务 ━━━${NC}"
# 开发调试不设 production；统一走 service.sh 的跨平台启动与二次健康确认。
export NODE_ENV=development
export PORT="${PORT:-3001}"
if ! bash tools/service.sh start; then
  echo "✗ 后端启动失败，请查看 backend.log / backend.err.log"
  exit 1
fi
echo "  → http://localhost:${PORT}"

# ─── 3. 启动管理端 ───
echo -e "\n${BOLD}━━━ 启动管理端 ━━━${NC}"
if ! command -v lsof >/dev/null 2>&1 || lsof -ti :3000 >/dev/null 2>&1; then
  echo -e "${CYAN}ℹ 不启动独立 dev server（无 lsof 或端口 3000 已占用）${NC}"
  echo -e "${GREEN}✓ 使用后端托管的构建产物：http://localhost:3001 （管理端单入口）${NC}"
else
  cd web-admin
  nohup npm run dev > ../webadmin.log 2>&1 &
  echo $! > ../webadmin.pid
  echo -e "${GREEN}✓ 管理端已启动 (PID: $(cat ../webadmin.pid))${NC}"
  echo "  → http://localhost:3000"
fi

# ─── 完成 ───
echo -e "\n${BOLD}${CYAN}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║  ✅ 全部服务已就绪！                           ║"
echo "  ║                                               ║"
if ! command -v lsof >/dev/null 2>&1 || lsof -ti :3000 >/dev/null 2>&1; then
echo "  ║  🖥️ 管理端：http://localhost:3001（单入口）     ║"
else
echo "  ║  🖥️ 管理端：http://localhost:3000              ║"
fi
echo "  ║  ⚙️ 后端API：http://localhost:3001             ║"
echo "  ║                                               ║"
echo "  ║  🛑 停止所有服务：bash stop-all.sh             ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${NC}"
