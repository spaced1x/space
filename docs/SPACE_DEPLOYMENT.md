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
NITRO_PRESET=node-server npm run build   # -> dist/server/index.mjs
```

The default build target in the authoring workspace is the edge preset used by the preview host. Production on the VPS always builds with `node-server`; that is the only artifact PM2 runs. `vite.config.ts` reads `NITRO_PRESET` and, when set, pins the output layout to `dist/` (`dist/server`, `dist/client`) so PM2 always starts `dist/server/index.mjs` — the Node preset's default `.output/` layout is never used.

Verified end to end on 2026-08-03 with a clean copy of the repository: `cp .env.example .env` → install → `NITRO_PRESET=node-server` build (`preset: "node-server"` in `dist/nitro.json`) → `pm2 start ecosystem.config.cjs` → `GET /` returns 200 and the console renders → `GET /api/public/health` returns the full component report with `database: OK (sqlite WAL)`, `clock: OK`, and `configuration: DEGRADED` while `.env` still holds placeholder secrets.

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

## 6. Rollback procedure

Every production deployment must have a deterministic rollback path. If any release gate fails after deployment:

1. Stop the SPACE process: `pm2 stop ecosystem.config.cjs`.
2. Restore the most recent verified SQLite backup.
3. Restore the previous `.env`.
4. Deploy the previous tagged release.
5. Start PM2: `pm2 start ecosystem.config.cjs`.
6. Verify startup validation via `/api/public/health`.
7. Verify reconciliation reports no divergences.
8. Verify Replay, Statistics and Diagnostics render correctly.
9. Record the rollback reason in the production report.

A rollback must never require manual database editing or recovery scripts. Every release is recorded in `release_artifacts` with `version`, `rollback_version`, `deployed_at`, `rollback_timestamp` (if applicable), `operator`, and `reason`.
