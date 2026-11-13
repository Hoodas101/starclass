#!/usr/bin/env bash
# ========================================
#  星课 StarClass · 服务控制（跨平台单一入口）
#  用法：bash tools/service.sh start | stop | status | ensure
#
#  为什么需要它：
#   · deploy.sh / start-all.sh 旧版用 `nohup node ... &` 启动，在 Windows / Git Bash
#     下进程随 shell 会话结束被回收（实测部署后 47 分钟～2 天出现 10061），
#     且 backend.pid 记的是 MSYS PID，不是 Windows 真实 PID，stop-all.sh 里的
#     `lsof`（Git Bash 缺失）与 `kill $(cat backend.pid)` 都清不掉旧进程。
#   · 健康检查旧版只轮询一次，刚启动的进程随后退出也会「假通过」。
#
#  本脚本统一：按端口定位真实进程、Windows 用原生独立进程启动、
#  启动后延迟二次确认，并把真实 Windows PID 写入 backend.pid。
# ========================================
set -u

PROJ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJ_DIR" || exit 1

PORT="${PORT:-3001}"
HEALTH="http://localhost:${PORT}/api/health"
PID_FILE="${PROJ_DIR}/backend.pid"
LOG="${PROJ_DIR}/backend.log"
ERR_LOG="${PROJ_DIR}/backend.err.log"
PS_ERR_LOG="${PROJ_DIR}/backend.ps.err.log"
UNAME="$(uname -s)"

is_windows() {
  case "$UNAME" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

health_ok() {
  command -v curl >/dev/null 2>&1 && curl -sf -m 2 "$HEALTH" >/dev/null 2>&1
}

# 按监听端口取真实进程号（Windows 用 PowerShell，不再依赖 lsof / MSYS PID）
port_pids() {
  if is_windows; then
    {
      # ① netstat 的 LISTENING 行（常规 Windows 环境可见）
      netstat -ano 2>/dev/null | awk -v p=":${PORT}" '$0 ~ p && /LISTENING/ { print $NF }' \
        | grep -E '^[0-9]+$' || true
      # ② 按命令行匹配：网络隔离 / 代理环境下端口可能查不到 LISTENING，
      #    但 node backend/server.js 仍在响应。按进程命令行定位最可靠。
      # 必须限定 node.exe：不限进程名时，任何命令行里恰好含该字符串的 shell
      # （例如排障命令）都会被误匹配并杀掉。
      powershell.exe -NoProfile -NonInteractive -Command \
        'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*backend/server.js*" } | Select-Object -ExpandProperty ProcessId' \
        2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' || true
    } | sort -u
  else
    if command -v lsof >/dev/null 2>&1; then
      # 必须限定 LISTEN：`lsof -ti :PORT` 也会返回「远端端口恰为该值」的客户端连接
      # （实测 :7844 命中 cloudflared），stop 会误杀浏览器/反向代理/监控进程。
      lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
    elif command -v fuser >/dev/null 2>&1; then
      fuser -n tcp "${PORT}" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
    else
      echo ""
    fi
  fi
}

do_stop() {
  local pids pid
  # Unix 可用 pid 文件直接 kill。Windows 下该文件可能是降级路径写入的 MSYS PID
  # （与 Windows PID 不是同一命名空间），贸然 taskkill 会误杀无关进程，
  # 因此 Windows 一律走下方「端口 + node.exe 命令行匹配」定位真实进程。
  if [ -f "$PID_FILE" ] && ! is_windows; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    case "$pid" in
      ''|*[!0-9]*) ;;
      *)
        # PID 可能已被系统复用给无关进程：kill 前必须核对命令行确实是本服务。
        cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
        case "$cmd" in
          *backend/server.js*|*backend\\server.js*) kill "$pid" 2>/dev/null || true ;;
          *) ;;
        esac
        ;;
    esac
  fi
  pids="$(port_pids)"
  for pid in $pids; do
      if is_windows; then
        taskkill //PID "$pid" //F >/dev/null 2>&1 || true
      else
        kill "$pid" 2>/dev/null || true
      fi
    done
  rm -f "$PID_FILE" "${PROJ_DIR}/webadmin.pid"
  echo "服务已停止（端口 ${PORT}）"
}

do_start() {
  if health_ok; then
    echo "服务已在运行：${HEALTH}"
    return 0
  fi

  # 端口被占用但健康检查不通（僵死进程）时先清干净，避免新进程 EADDRINUSE
  local stale
  stale="$(port_pids)"
  if [ -n "$stale" ]; then
    echo "检测到端口 ${PORT} 上的无响应进程，先清理"
    do_stop >/dev/null
  fi

  export NODE_ENV="${NODE_ENV:-production}"
  export FORCE_PASSWORD_CHANGE="${FORCE_PASSWORD_CHANGE:-1}"
  export PORT="$PORT"

  if is_windows; then
    # 默认 simple：兼容性最好，配合桌面启动器的 ensure 自愈（服务退出后双击即拉起）。
    # SERVICE_LAUNCH=native 用于无人值守/服务器部署：Start-Process 启动 Windows 原生
    # 独立进程，脱离 Git Bash 会话/job 管理，-PassThru 写入真实 Windows PID。
    # 部分容器 / 托管沙箱会禁止派生独立进程，此时必须保持 simple。
    if [ "${SERVICE_LAUNCH:-simple}" = "simple" ]; then
      nohup node backend/server.js >> "$LOG" 2>&1 < /dev/null &
      echo $! > "$PID_FILE"
    else
    local node_win proj_win log_win err_win ps_cmd newpid
    # PowerShell 5.1 的 Start-Process 在环境变量中同时存在 HTTPS_PROXY / https_proxy
    # 这类「仅大小写不同」的同名键时，会抛 ArgumentException「已添加项」并拒绝启动。
    # 代理型运行环境常见（沙箱 / 企业代理）。启动前移除小写变体，保留大写形式即可。
    unset https_proxy http_proxy all_proxy no_proxy 2>/dev/null || true
    node_win="$(cygpath -w "$(command -v node)" 2>/dev/null || command -v node)"
    proj_win="$(cygpath -w "$PROJ_DIR" 2>/dev/null || echo "$PROJ_DIR")"
    log_win="$(cygpath -w "$LOG" 2>/dev/null || echo "$LOG")"
    err_win="$(cygpath -w "$ERR_LOG" 2>/dev/null || echo "$ERR_LOG")"
    ps_cmd="\$env:NODE_ENV='${NODE_ENV}'; \$env:FORCE_PASSWORD_CHANGE='${FORCE_PASSWORD_CHANGE}'; \$env:PORT='${PORT}'; \$p = Start-Process -FilePath '${node_win}' -ArgumentList 'backend/server.js' -WorkingDirectory '${proj_win}' -WindowStyle Hidden -PassThru -RedirectStandardOutput '${log_win}' -RedirectStandardError '${err_win}'; \$p.Id"
    newpid="$(powershell.exe -NoProfile -NonInteractive -Command "$ps_cmd" 2>"$PS_ERR_LOG" | tr -d '\r' | grep -E '^[0-9]+$' | head -n 1)"
    if [ -n "$newpid" ]; then
      echo "$newpid" > "$PID_FILE"
    else
      # 降级：PowerShell 不可用或 Start-Process 被环境策略禁用时，仍用 nohup 保证服务可起。
      # 此时 backend.pid 是 MSYS PID，停止链路由「命令行匹配」一路兜底，不会残留旧实例。
      nohup node backend/server.js >> "$LOG" 2>&1 < /dev/null &
      echo $! > "$PID_FILE"
    fi
    fi
  else
    if command -v setsid >/dev/null 2>&1; then
      setsid nohup node backend/server.js >> "$LOG" 2>&1 < /dev/null &
    else
      nohup node backend/server.js >> "$LOG" 2>&1 < /dev/null &
    fi
    echo $! > "$PID_FILE"
  fi

  local ok=0
  for _ in $(seq 1 20); do
    if health_ok; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" != "1" ]; then
    echo "启动失败：20 秒内 ${HEALTH} 无响应，请查看 ${LOG} 与 ${ERR_LOG}"
    return 1
  fi

  # 二次确认：旧版只查一次，进程随即退出也会判成功。
  sleep 2
  if ! health_ok; then
    echo "启动失败：进程在健康检查后立即退出，请查看 ${LOG} 与 ${ERR_LOG}"
    return 1
  fi
  echo "服务已启动：${HEALTH}（PID $(cat "$PID_FILE" 2>/dev/null || echo 'unknown')）"
  return 0
}

case "${1:-status}" in
  start)
    do_start
    ;;
  stop)
    do_stop
    ;;
  status)
    if health_ok; then echo "running ${HEALTH}"; else echo "stopped ${HEALTH}"; fi
    ;;
  ensure)
    # 供桌面入口调用：服务不在就拉起，已在则直接返回，不重复启动。
    if health_ok; then echo "running"; else do_start; fi
    ;;
  *)
    echo "用法：bash tools/service.sh start|stop|status|ensure" >&2
    exit 2
    ;;
esac
