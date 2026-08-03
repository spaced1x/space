# SPACE v1.0.0 — Rollback Procedure

Read this top to bottom before touching anything. Steps are ordered so that the
engine stops trading before any file changes.

## 1. Stop trading first

1. Trigger the emergency stop from the dashboard or Telegram (`/stop`).
2. Confirm the engine reports `OBSERVE` and no order is in flight.
3. `pm2 stop space`.

## 2. Preserve evidence

```bash
cp -a data/space.db      data/space.db.rollback-$(date +%s)
cp -a data/space.db-wal  data/space.db-wal.rollback-$(date +%s) 2>/dev/null || true
cp -a logs               logs.rollback-$(date +%s)
```

Never roll a database backwards across a migration boundary. If the previous
version predates a migration, restore the matching database backup as well.

## 3. Restore the previous version

```bash
git fetch --tags
git checkout v0.9.x            # the last known-good tag
bun install
NITRO_PRESET=node-server bun run build
```

## 4. Restart and verify

```bash
pm2 start ecosystem.config.cjs
curl -fsS http://127.0.0.1:8080/api/public/health
```

Verify in this order: health endpoint green → dashboard renders → environment
conformance gate all six items pass → engine sits in OBSERVE.

## 5. Record it

Call `recordRollback(version, reason)` so the `release_artifacts` table carries
the rollback with its reason. An unrecorded rollback is an unexplained one.

## 6. Re-arm deliberately

Only after the operator has read the failure reason and the pre-ARM validation
gate passes cleanly. Re-arming is a decision, never a reflex.