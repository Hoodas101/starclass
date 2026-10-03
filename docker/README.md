# edu-admin-system

Self-hosted management system for training institutions —
Express + SQLite API, Vue 3 + Element Plus web console.

## Quick start (Docker)

```sh
git clone <your-fork-url> edu-admin-system
cd edu-admin-system

# 1. Environment
cp .env.example .env
# Set NODE_ENV=production and a real JWT_SECRET:
#   echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
#   echo "NODE_ENV=production" >> .env

# 2. Build the image
docker compose build

# 3. Start
docker compose up -d

# 4. Initialize the database (schema + migrations)
docker compose exec app node db/init.js

# 5. Load demo data (optional)
docker compose exec app node db/seed.js
```

Open <http://localhost:3001>. Health check:
`GET http://localhost:3001/api/health`. Sign in with the seeded admin account
(phone `13800000001`, password `123456`) if you ran the seed step.

> **One command** — [`deploy/deploy.sh`](../deploy/deploy.sh) does the whole
> walkthrough for you: it generates `JWT_SECRET`, sets production mode, builds,
> starts, initializes the DB and waits for the health check. It also supports
> automatic HTTPS via a Caddy sidecar (`--host app.example.com`). See
> [deploy/README.md](../deploy/README.md).

The container runs the production build of the web console, so no separate
frontend step is needed. `backend/uploads` is a volume so avatars survive
container rebuilds.

> **Backups** — the scheduled backup (if enabled via `backup_config` in the
> admin settings) writes to `/app/backend/backups`, which is **not** a volume.
> The live database lives on the `/data` volume and is safe; backup snapshots
> are reset on container rebuild. Export a copy (`docker compose cp app:/app/backend/backups .`)
> before rebuilding if you want to keep them.

## Environment

| Variable     | Purpose                                            |
| ------------ | -------------------------------------------------- |
| `JWT_SECRET` | JWT signing secret (required; random 32+ bytes)    |
| `DB_PATH`    | SQLite file path inside the container (`/data/data.db` by default) |
| `NODE_ENV`   | `production` enables the built console + secret check |

See [.env.example](.env.example) for the full list.
