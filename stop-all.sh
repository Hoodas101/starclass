#!/bin/bash
# 停止所有服务
#
# 旧版用 `lsof -ti :3001`（Windows / Git Bash 无 lsof）与 `kill $(cat backend.pid)`
# （该文件记的是 MSYS PID，不是 Windows 真实 PID），两者都定位不到真实监听进程，
# 端口被旧实例占用时清不掉，重新部署会误连旧进程或直接 EADDRINUSE。
# 现统一交给 tools/service.sh 按端口定位真实进程。
set -u
cd "$(dirname "$0")" || exit 1

bash tools/service.sh stop

# 开发模式可能另起管理端 dev server（:3000）；仅 Unix 有 lsof 时清理。
if command -v lsof >/dev/null 2>&1; then
  lsof -ti :3000 2>/dev/null | xargs -r kill 2>/dev/null || true
fi
if [ -f "webadmin.pid" ]; then
  pid="$(cat webadmin.pid 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) ;;
    *) kill "$pid" 2>/dev/null || true ;;
  esac
  rm -f webadmin.pid
fi
echo "全部服务已停止"
