# 一键部署（Docker，公网服务器）

> 本文档面向**正式上线**：把后端 + 管理后台部署到你自己的 Linux 服务器。
> 本机/旧电脑快速体验请用根目录的 `bash deploy.sh`（免 Docker）。

两种方式任选其一。

## 方式一：GitHub Actions 点击部署（推荐新手）

1. 买一台全新的 Linux 服务器（任意厂商的 Ubuntu 22.04/24.04 虚机即可，
   1 核 2G 起步够用），开通 SSH root 访问。
2. 把 SSH **私钥**添加到仓库：
   `Settings → Secrets and variables → Actions → New repository secret`，
   命名为 `SSH_PRIVATE_KEY`，粘贴能登录该服务器 root 的私钥。
3. 仓库页面打开 **Actions** 标签 → **Deploy** → **Run workflow**，
   填入服务器公网 IP（或已解析到服务器的域名），点击运行。

工作流会自动：装 Docker（如缺失）→ 克隆本仓库 → 构建镜像 → 初始化
SQLite → 启动服务。勾选 **Automatic HTTPS** 并填真实域名时，管理后台在
`https://<域名>/`；未勾选 HTTPS（默认）时服务在 **`http://<服务器IP>:3001/`**
（80 端口未启用）。

以后再次部署 = 再点一次 Run workflow —— SQLite 数据卷与上传文件都保留。

## 方式二：一条命令（任何装了 Docker 的机器）

```sh
./deploy/deploy.sh                 # 内网/局域网：http 模式
./deploy/deploy.sh --host app.example.com   # 有域名：自动 HTTPS
```

| 参数 | 含义 |
| --- | --- |
| `--host HOST` | 公网域名/IP；配合默认 HTTPS 启用 Caddy 自动证书 |
| `--no-https` | 纯 HTTP（内网/局域网），不启动 Caddy |
| `--port P` | 暴露到宿主机的端口（默认 `3001`） |
| `--fresh-db` | 从零重建数据库（会清空数据，慎用） |

## 部署完成后你得到

| 项目 | 位置 |
| --- | --- |
| 管理后台 | `http://<host>/`（体验账号 `13800000001` / `123456`，上线后请改密） |
| API | `http://<host>/api`（健康检查 `/api/health`） |
| 数据库 | SQLite 在 Docker 命名卷中（跨重新部署保留） |
| 上传附件 | Docker 命名卷 `uploads` |
| 备份 | `docker compose exec app ls /data/backups`（在 data 卷内，随卷保留；建议配置 `BACKUP_OFFSITE_DIR` 做异地副本） |

容器内强制 `NODE_ENV=production` + 随机 `JWT_SECRET`；数据库、上传、
备份永远不离开你的服务器，除非你自己导出。

## 故障排查

- **健康检查一直不过** —— `docker compose logs -f app` 看报错；
  确认防火墙放行 `3001`（HTTP）或 `80/443`（HTTPS）。
- **裸 IP 上 HTTPS 失败** —— Let's Encrypt 只给域名签证书。
  给 `--host` 用域名，或去掉 `--host` 改 `--no-https`。
- **重新部署到同一台服务器** —— 放心重跑，数据卷保留；
  只有想清空数据时才用 `--fresh-db`。
- **想迁移数据** —— `docker compose cp app:/data/data.db ./backup.db`
  导出，新机部署后拷回 `/data/` 即可（详见 `docs/常见问题FAQ.md` Q20）。
