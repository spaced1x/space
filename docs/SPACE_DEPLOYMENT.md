# SPACE — Deployment (VPS)

One repository, one Node process, one SQLite file, one PM2 app, one Nginx server block.

## 1. Prepare

```bash
git clone <repo> /opt/space && cd /opt/space
cp .env.example .env      # fill secrets only
npm ci                    # builds better-sqlite3 natively
```

`better-sqlite3` is declared as an **optional** dependency: authoring environments without a native toolchain still install, and the database reports `DEGRADED` there instead of crashing. On the VPS the native build must succeed — verify `/api/public/health` reports `database: OK`.

## 2. Build

```bash
NITRO_PRESET=node_server npm run build   # -> dist/server/index.mjs
```

The default build target in the authoring workspace is the edge preset used by the preview host. Production on the VPS always builds with `node_server`; that is the only artifact PM2 runs.

## 3. Run

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

`kill_timeout` is 15s so the shutdown sequence can checkpoint WAL and close SQLite cleanly.

## 4. Nginx

Terminate TLS at Nginx, proxy to `127.0.0.1:$PORT`, and never expose the app port. Health probe: `GET /api/public/health` (200 healthy/degraded, 503 failed).

## 5. Backup

The database is one file plus its WAL. Back up with `sqlite3 $DB_PATH ".backup space-backup.db"` or copy after a checkpoint. Secrets are never included in a backup; restore `.env` separately. Clone -> restore file -> run.