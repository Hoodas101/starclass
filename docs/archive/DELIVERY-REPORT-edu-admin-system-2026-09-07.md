# edu-admin-system 开源交付报告

**日期**：2026-09-07
**范围**：backend + web-admin（公开）· miniprogram（私有，可上传）

> 本报告中的真实业务值（客服电话、小程序 appid 等）一律以占位符表示，符合公开仓库的脱敏标准。

---

## 一、交付物总览

| 项目 | 位置 | 可见性 | 内容 |
| ---- | ---- | ------ | ---- |
| 公开仓库 | `~/project/edu-admin-open/` | 可公开 | backend + web-admin + 文档 + CI + Docker |
| 私有仓库 | `~/project/edu-admin-miniprogram/` | 私有，可上传体验版 | 微信小程序源码（213 文件） |
| 源码来源 | `~/edu-admin/` | 本机 | 不动，保持原状 |

## 二、公开仓库（edu-admin-open）

### 2.1 已完成的准备

1. **脱敏清理**：源码、文档、脚本全量扫描，清除个人路径、手机号、占位密钥、内部云环境标识与短信服务密钥等内部引用。
2. **文档对齐 Comp AI CRM 标准**：README 重写为英文、含 What this is / Features / Stack / Quick start / Configuration / Deploying / Contributing / License 结构；.env.example 全变量注释；CHANGELOG / CONTRIBUTING / CODE_OF_CONDUCT / SECURITY / LICENSE（MIT）齐备。
3. **CI**：`.github/workflows/ci.yml` — 每次 push/PR 自动跑敏感值扫描（含对 `package-lock.json`、`ci.yml` 自身的豁免）、拒绝提交数据库/上传/小程序文件、安装依赖并跑后端测试、构建 web console。
4. **Docker 部署**：`Dockerfile`（多阶段、非 root 用户）+ `docker-compose.yml`（命名卷持久化 data + uploads）+ `.dockerignore` + `docker/README.md`。全新环境：`cp .env.example .env && docker compose build && docker compose up -d && docker compose exec app node db/init.js`（+ 可选 `seed.js`）。
5. **全新环境可运行验证**：backend 单测通过；`db/init.js` / `db/seed.js` / `server.js` 语法检查通过；README 本地链接全部有效；工作树干净。

### 2.2 安全设计（对齐 trycompai/crm 的「安全默认」原则）

- 生产环境拒绝使用占位 `JWT_SECRET` 启动。
- 凭据只存在于 `.env`（`env_file`），仓库内零凭据。
- 真实业务数据库、上传文件、备份均不入库；`.dockerignore` + CI 双重拒绝。
- 生产模式单进程：Express 同源提供 web-admin/dist，无 CORS 配置面。

### 2.3 提交历史

```
bf009ee docs(docker): document that backups are not on a volume
b4c5248 feat: add Docker deployment (Dockerfile + compose) and phase-4 docs
0c5c746 ci: add GitHub Actions workflow and lockfiles
363bb6a docs: rewrite README and .env.example for public consumption
22e49c6 feat: open-source repo scaffold for edu-admin-system
```

## 三、私有仓库（edu-admin-miniprogram）

### 3.1 内容

- `miniprogram/` 全部源码（209 文件，1.3M），含 40 个页面、自定义 tabBar、组件。
- `project.config.json`（保留真实 appid，仅存在于私有仓库）。
- `check-compile.mjs` 编译门禁。
- `.gitignore`：排除 `local-config.js`、`project.private.config.json`、`miniprogram_npm/`、`node_modules/`、`.env*` 等。
- `README.md`：本地运行、上传体验版步骤、敏感信息说明。

### 3.2 验证

- 编译门禁通过：`49 个 wxss + 全部页面 WXML`，退出码 0。
- 预提交空白检查通过（已修复 3 个 wxss 尾部多余空行）。
- 已提交：`69414cd chore: private miniprogram initial commit`（工作树干净）。

### 3.3 敏感信息处理

- `config.js` 中的 `SERVICE_PHONE`（真实客服电话，12 处出现）为兜底值 — **私有仓库可接受**；正式使用可在管理端设置 `service_phone` 覆盖。
- `AD_UNIT_ID` 为广告位占位符。
- `local-config.js`（含局域网/隧道地址）不入库；提供 `local-config.example.js` 文档。

## 四、上传体验版（miniprogram）

**前置条件（需手动操作一次）**：微信开发者工具 → 设置 → 安全设置 → **开启「服务端口」**。

- 方式一（推荐，手动）：开发者工具中点击右上角「上传」→ 填版本号与备注。
- 方式二（命令行）：
  ```sh
  cli login   # 首次登录
  cli upload --project "$(pwd)" --version 1.0.0 --desc "体验版"
  ```

## 五、遗留事项（不阻塞交付）

1. **Docker 构建未在本机验证**：本机未安装 Docker。Dockerfile / compose 已按路径逐一核对，CI 未含 docker 构建步骤；建议首次部署机器上跑一遍 `docker compose build`。
2. **微信服务端口**：CLI 上传依赖用户在开发者工具中手动开启「服务端口」。
3. **一键部署的实机验证**：Deploy workflow（Actions 手动触发）需一台 Linux 服务器 + `SSH_PRIVATE_KEY` 仓库密钥才能端到端跑通；`deploy/remote-deploy.sh` 与 `deploy/deploy.sh` 已通过 `bash -n` 语法检查，Docker 镜像构建与真实部署待目标机器上首次运行验证。
4. **上线前业务配置**：正式使用需在管理端配置 `service_phone`、微信支付/订阅消息相关密钥（.env），并将小程序后台 request 合法域名指向正式 API。

## 六、核对清单

- [x] 公开仓库零敏感值（最终扫描 0 命中，排除 ci.yml 自我匹配）
- [x] backend 单测通过、关键入口语法检查通过
- [x] README 链接有效、.env.example 无硬编码真实密钥
- [x] 私有仓库编译门禁通过、无 `local-config.js` / `project.private.config.json` 入库
- [x] 两仓库工作树干净，提交历史清晰
- [x] 公开仓库已推送至 GitHub（`Mihooni/edu-admin-system`，PUBLIC，137 文件）
- [x] 私有仓库已推送至 GitHub（`Mihooni/edu-admin-miniprogram`，PRIVATE）
- [x] 推送后 CI 全绿（后端测试 ×3 Node 版本、web 构建、敏感值扫描）
