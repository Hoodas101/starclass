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
      echo -e "${GREEN}✓ 已创建部署前备份（backend/backups/）${NC}"
    else
      echo -e "${YELLOW}⚠ 部署前备份失败，建议确认磁盘空间后再继续${NC}"
    fi
  fi
fi

# ─── 3. 构建管理端 ───
echo -e "\n${BOLD}━━━ [3/4] 构建管理端 ━━━${NC}"
(cd web-admin && npm run build)
echo -e "${GREEN}✓ 构建完成（由后端 :3001 托管，单入口）${NC}"

# ─── 4. 停旧进程 + 启动 ───
echo -e "\n${BOLD}━━━ [4/4] 启动服务 ━━━${NC}"
bash stop-all.sh >/dev/null 2>&1 || true
# NODE_ENV=production：一键部署即生产模式（家长免密登录默认关闭、CORS 按 CORS_ORIGINS 白名单）。
# 开发调试请用 start-all.sh（不设 NODE_ENV），或在 .env 中显式 export PARENT_PHONE_LOGIN=true。
#
# 演示模式关闭「默认口令强制改密」（见 backend/utils/security.js）：
# 演示账号用的就是默认口令 123456，若强制生效，新用户按 README 登录后会被直接拦到改密页，
# 一屏演示数据都看不到。正式部署（不带 SEED_DEMO_DATA=1）保持强制改密开启，安全语义不变。
if [ "${SEED_DEMO_DATA:-0}" = "1" ]; then
  FORCE_PASSWORD_CHANGE=0
else
  FORCE_PASSWORD_CHANGE=1
fi
NODE_ENV=production FORCE_PASSWORD_CHANGE="$FORCE_PASSWORD_CHANGE" nohup node backend/server.js > backend.log 2>&1 &
echo $! > backend.pid

# 健康检查轮询（最多约 15 秒，兼容慢机器冷启动）
HEALTH_OK=0
for _ in $(seq 1 15); do
  if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 1
done

# 健康检查失败必须让脚本以非零码退出，否则 CI / 运维无法据此判定部署失败
if [ "$HEALTH_OK" != "1" ]; then
  echo -e "\n${YELLOW}✗ 部署失败：${NC}健康检查未通过（15 秒内 http://localhost:${PORT}/api/health 无响应）"
  echo -e "${YELLOW}  请查看日志：tail -50 backend.log${NC}"
  echo -e "${YELLOW}  若为数据库迁移失败，可用 backend/backups/ 中的部署前备份回滚。${NC}"
  exit 1
fi

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
echo "  ║  🛑 停止：bash stop-all.sh                     ║"
echo "  ║  📖 部署上线（域名/HTTPS）：                  ║"
echo "  ║     见《部署上线说明.md》                       ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "健康检查：http://localhost:${PORT}/api/health ${GREEN}✓${NC}"
