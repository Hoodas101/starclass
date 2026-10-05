#!/usr/bin/env bash
# 在部署服务器上以 root 运行（由 Deploy 工作流 scp 上传后调用，
# 参数经 ssh 命令行传入，使本脚本保持为可直接测试的纯 shell 文件）。
#
#   REPO       本仓库完整克隆地址（github.com/Hoodas101/starclass）
#   SERVER     该服务器的公网主机名（IP 或域名）
#   SKIP_SEED  非空则跳过示例数据
#   ARGS       deploy/deploy.sh 的额外参数（如 --no-https）
#
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

command -v git >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq git; }
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh

# 保留 .env（内含首次部署生成的随机 JWT_SECRET）：直接 rm -rf 重克隆会把它抹掉，
# JWT_SECRET 一变，全员 token 立即失效（无提示集体掉线），且自定义配置全部丢失。
# 备份用 mktemp（随机路径防符号链接预置攻击/并发争用）+ 0600（密钥不明文暴露给其他用户）；
# clone 失败时 trap 兜底把 .env 放回原位，避免密钥滞留 /tmp。
ENV_BAK=""
if [[ -f /opt/edu-admin/.env ]]; then
  ENV_BAK="$(mktemp /tmp/edu-admin.env.XXXXXX)"
  chmod 600 "$ENV_BAK"
  cp /opt/edu-admin/.env "$ENV_BAK"
fi
restore_env() {
  [[ -n "$ENV_BAK" && -f "$ENV_BAK" ]] || return 0
  mkdir -p /opt/edu-admin && mv "$ENV_BAK" /opt/edu-admin/.env
  chmod 600 /opt/edu-admin/.env
}
trap 'restore_env' EXIT
rm -rf /opt/edu-admin
git clone --depth 1 "$REPO" /opt/edu-admin
cd /opt/edu-admin
if [[ -n "$ENV_BAK" && -f "$ENV_BAK" ]]; then mv "$ENV_BAK" /opt/edu-admin/.env; chmod 600 /opt/edu-admin/.env; echo "[remote] 已恢复原有 .env"; fi
chmod +x deploy/deploy.sh
SKIP_SEED="$SKIP_SEED" ./deploy/deploy.sh --host "$SERVER" $ARGS
