# syntax=docker/dockerfile:1
#
# 星课 StarClass — 单镜像构建（后端 API + Web 管理后台同端口托管）
#
# 构建阶段：后端生产依赖 + 管理后台 Vite 构建
# 运行阶段：Express 同端口托管 API 与构建产物
# 容器以非特权 node 用户运行；/data 卷存放 SQLite，/app/backend/uploads 存放附件

# ---------- Builder ----------
FROM node:20-slim AS builder
WORKDIR /app

# 先装后端生产依赖（better-sqlite3 对 node:20-slim 有预编译产物，无需编译工具链）
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

# 安装管理后台依赖并构建
COPY web-admin/package.json web-admin/package-lock.json ./web-admin/
RUN cd web-admin && npm ci
COPY backend ./backend
COPY web-admin ./web-admin
# 纵深防御：即使 .dockerignore 被绕过，也确保本地密钥/数据库不会进入镜像层。
# 容器首次启动会自行生成新的 JWT 密钥。
RUN rm -f backend/db/.jwt-secret backend/db/data.db backend/db/data.db-wal backend/db/data.db-shm
RUN cd web-admin && npm run build

# ---------- Runtime ----------
FROM node:20-slim AS runtime
WORKDIR /app/backend

ENV NODE_ENV=production
ENV DB_PATH=/data/data.db
ENV PORT=3001
# 时区：SQL 中的 'localtime' 修饰符依赖系统时区库解析 TZ。
# Debian slim 默认不含 tzdata，若不安装，TZ 会解析失败并静默回落到 UTC，
# 导致「今日收入 / 今日课表」按 UTC 日切分（东八区 00:00–08:00 的数据算到前一天）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*
ENV TZ=Asia/Shanghai

# 命名卷以镜像内属主初始化，先建目录（data/uploads/backups）再降权；
# /app/backend 本身也要 chown，否则 node 用户启动时无法在运行时创建子目录
RUN mkdir -p /data /app/backend/uploads /app/backend/backups \
    && chown -R node:node /data /app/backend
USER node

COPY --from=builder --chown=node:node /app/backend/package.json ./
COPY --from=builder --chown=node:node /app/backend/node_modules ./node_modules/
COPY --from=builder --chown=node:node /app/backend ./
COPY --from=builder --chown=node:node /app/web-admin/dist ../web-admin/dist

EXPOSE 3001

# server.js 相对自身解析 uploads/ 与 ../web-admin/dist，
# 因此 WORKDIR /app/backend 保证 `docker compose exec app node db/init.js` 可用
CMD ["node", "server.js"]
