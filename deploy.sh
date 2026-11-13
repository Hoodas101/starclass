#!/bin/bash
# ========================================
#  星课 StarClass · 一键部署
#  适用：全新服务器 / 本机克隆后首次部署
#  用法：bash deploy.sh
#  说明：自动完成 依赖安装 → 数据库初始化+示例数据 → 管理端构建 → 服务启动
# ========================================

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}${CYAN}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║       星课 StarClass — 一键部署                ║"
echo "  ║       Node.js + Express + SQLite              ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

cd "$(dirname "$0")"

# 监听端口：与 server.js 读取的 PORT 保持一致，供健康检查复用
PORT="${PORT:-3001}"
export PORT

# ─── 0. 环境检查 ───
if ! command -v node >/dev/null 2>&1; then
  echo -e "${YELLOW}✗ 未检测到 Node.js，请先安装（>= 18）：https://nodejs.org${NC}"
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo -e "${YELLOW}✗ 当前 Node $(node -v) 过低，better-sqlite3 要求 >= 18。请升级后重试：https://nodejs.org${NC}"
  echo -e "${YELLOW}  （macOS 可用 brew install node@20 或 nvm install 20）${NC}"
  exit 1
fi

# ─── 0.5 生产安全提示 ───
if [ -z "$JWT_SECRET" ]; then
  echo -e "${YELLOW}⚠ 未设置 JWT_SECRET。将以生产模式启动并自动生成强随机密钥，持久化到 backend/db/.jwt-secret（请随数据库一起备份）。${NC}"
  echo -e "${YELLOW}    如需密钥可控/多实例共享，请先执行：export JWT_SECRET=\$(openssl rand -hex 32)${NC}\n"
fi

# ─── 1. 安装依赖 ───
# 优先 npm ci（严格按 lock 复现构建，最快）；无 lock 或失败时回退 npm install
echo -e "\n${BOLD}━━━ [1/4] 安装依赖 ━━━${NC}"
(cd backend && { npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund; })
(cd web-admin && { npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund; })
echo -e "${GREEN}✓ 依赖安装完成${NC}"

# ─── 2. 初始化数据库（已存在则跳过，绝不覆盖已有数据）───
echo -e "\n${BOLD}━━━ [2/4] 初始化数据库 ━━━${NC}"
if [ ! -f "backend/db/data.db" ]; then
  (cd backend && node db/init.js)
  if [ "${SEED_DEMO_DATA:-0}" = "1" ]; then
    # 演示数据含固定口令账号（13800000001 / 123456），仅用于本地评估，切勿在公网环境使用
    (cd backend && SEED_FORCE=1 node db/seed.js)
    echo -e "${YELLOW}✓ 已灌入演示数据（管理员 13800000001 / 123456，请立即改密）${NC}"
  else
    # 生产默认：只创建管理员，口令随机生成且仅打印这一次
    (cd backend && node db/create-admin.js)
    echo -e "${GREEN}✓ 数据库已初始化，管理员账号已生成（口令见上方，仅显示一次）${NC}"
    echo -e "${YELLOW}  如需演示数据：SEED_DEMO_DATA=1 bash deploy.sh${NC}"
  fi
else
  echo -e "${GREEN}✓ 检测到已有数据库，跳过初始化（数据不会被动）${NC}"
  # 升级前备份：迁移或启动失败时可回滚
  if [ -f "tools/backup.sh" ]; then
    if bash tools/backup.sh >/dev/null 2>&1; then
      echo -e "${GREEN}✓ 已创建部署前备份（项目根 backups/）${NC}"
    else
      echo -e "${YELLOW}⚠ 部署前备份失败，建议确认磁盘空间后再继续${NC}"
    fi
  fi
fi

# ─── 3. 构建管理端 ───
# 失败回滚：vite build 会先清空 outDir，若构建或后续启动失败，旧 dist 已被抹掉，
# 服务即使还活着也只能返回 SPA 空壳/404。先把上一版产物整体挪为快照，
# 用 EXIT trap 保证任何一步非零退出都还原；成功后才删除快照。
echo -e "\n${BOLD}━━━ [3/4] 构建管理端 ━━━${NC}"
DIST_SNAPSHOT="web-admin/dist.pre-deploy-$(date +%Y%m%d-%H%M%S)"
if [ -d web-admin/dist ]; then
  mv web-admin/dist "$DIST_SNAPSHOT"
fi
DEPLOY_DONE=0
rollback_dist() {
  if [ "$DEPLOY_DONE" -eq 1 ]; then
    [ -d "$DIST_SNAPSHOT" ] && rm -rf "$DIST_SNAPSHOT"
    return 0
  fi
  if [ -d "$DIST_SNAPSHOT" ]; then
    rm -rf web-admin/dist 2>/dev/null || true
    mv "$DIST_SNAPSHOT" web-admin/dist
    echo -e "${YELLOW}↩ 部署未成功：已回滚上一版前端产物（web-admin/dist）${NC}"
  fi
  # 启动阶段失败时旧服务已被 stop-all.sh 停掉，尝试用回滚后的产物重新拉起，
  # 避免「一次失败部署 = 线上直接下线」。
  bash tools/service.sh start >/dev/null 2>&1 || \
    echo -e "${YELLOW}  服务未能自动恢复，请查看 backend.log / backend.err.log${NC}"
}
trap rollback_dist EXIT
(cd web-admin && npm run build)
echo -e "${GREEN}✓ 构建完成（由后端 :3001 托管，单入口）${NC}"

# ─── 4. 停旧进程 + 启动 ───
echo -e "\n${BOLD}━━━ [4/4] 启动服务 ━━━${NC}"
bash stop-all.sh >/dev/null 2>&1 || true
# 旧进程收到 SIGTERM 后会优雅关闭（后端含最长 8s 的 forceTimer），期间仍会响应
# /api/health。若立刻 start，service.sh 的 health_ok 会判「已在运行」直接返回，
# 于是 DEPLOY_DONE=1 打印部署完成，但跑的仍是旧代码。必须等健康探测真正失败再启动。
for _ in $(seq 1 15); do
  if ! curl -sf -m 2 "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
# NODE_ENV=production：一键部署即生产模式（家长免密登录默认关闭、CORS 按 CORS_ORIGINS 白名单）。
# 开发调试请用 start-all.sh（不设 NODE_ENV），或在 .env 中显式 export PARENT_PHONE_LOGIN=true。
#
# 演示模式关闭「默认口令强制改密」（见 backend/utils/security.js）：
# 演示账号用的就是默认口令 123456，若强制生效，新用户按 README 登录后会被直接拦到改密页，
# 一屏演示数据都看不到。正式部署（不带 SEED_DEMO_DATA=1）保持强制改密开启，安全语义不变。
if [ "${SEED_DEMO_DATA:-0}" = "1" ]; then
  export FORCE_PASSWORD_CHANGE=0
else
  export FORCE_PASSWORD_CHANGE=1
fi
export NODE_ENV=production

# 启动与健康检查统一交给 tools/service.sh：
# Windows 用原生独立进程（不再被 Git Bash 会话回收），并做延迟二次确认，
# 避免「进程随即退出但首次健康检查已通过」的假阳性。
if ! bash tools/service.sh start; then
  echo -e "\n${YELLOW}✗ 部署失败：${NC}服务启动或健康检查未通过（http://localhost:${PORT}/api/health）"
  echo -e "${YELLOW}  请查看日志：tail -50 backend.log 与 backend.err.log${NC}"
  echo -e "${YELLOW}  前端产物已自动回滚；若为数据库迁移失败，可用项目根 backups/ 中的部署前快照（或 backend/db/backups/ 每日备份）回滚。${NC}"
  exit 1
fi

# ─── 5. 桌面入口 ───
# 在桌面放置「星课 StarClass」入口。Windows 同时生成 .url（纯链接）与
# StarClass-Launcher.cmd（先调用 tools/service.sh ensure 拉起服务，再打开浏览器）。
# 跨平台：macOS 生成 .app / Linux 生成 .desktop / Windows 生成 .url + 自启启动器。失败不影响部署。
bash tools/create-desktop-entry.sh "$PORT" || \
  echo -e "${YELLOW}  ⚠️  桌面入口创建失败（不影响使用），可稍后手动执行：bash tools/create-desktop-entry.sh${NC}"

# 全部步骤（含健康检查）已通过：解除回滚 trap，清理上一版 dist 快照
DEPLOY_DONE=1

echo -e "\n${BOLD}${CYAN}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║  ✅ 部署完成！                                 ║"
echo "  ║                                               ║"
echo "  ║  🖥️  管理后台：http://localhost:${PORT}           ║"
if [ "${SEED_DEMO_DATA:-0}" = "1" ]; then
echo "  ║      账号 13800000001 / 123456（演示数据）     ║"
else
echo "  ║      账号与随机口令见上方输出（请立即改密）    ║"
fi
echo "  ║  ⚙️  后端 API：http://localhost:${PORT}/api       ║"
echo "  ║                                               ║"
echo "  ║  🖥️  桌面入口：双击桌面「星课 StarClass」       ║"
echo "  ║  🛑 停止：bash stop-all.sh                     ║"
echo "  ║  📖 部署上线（域名/HTTPS）：                  ║"
echo "  ║     见《部署上线说明.md》                       ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "健康检查：http://localhost:${PORT}/api/health ${GREEN}✓${NC}"
