# SPACE v1.0 — Production Readiness Report

This is the consolidated release-engineering report for v1.0.0. Each section
either states a measured result or points at the artifact that contains it.
Nothing here is an estimate.

## 1. Runtime audit

- One runtime process owns boot, shutdown, scheduling and execution. Ownership
  is asserted from the source tree by `tests/unit/ownership.test.ts` and
  documented in `OWNERSHIP.md`.
- Boot is deterministic and staged; every stage is timed and surfaced in the
  snapshot (`bootTrace`). A failed stage is reported, never silently skipped.
- The runtime holds a single-instance lock on the environment database. A
  second process refuses to boot rather than sharing state.
- The resource audit runs on START, STOP, SWITCH and periodically. During the
  accelerated soak it reported no duplicate schedulers, engine loops, database
  handles or locks.

## 2. Repository audit

See `docs/audit/REPOSITORY_AUDIT.md`. 43 unused starter-kit files and 37
orphaned dependencies were removed; every remaining module is reachable from
the runtime or the operator UI.

## 3. Security audit

- No credential ever reaches the browser: the snapshot is scanned by the
  release gate against private-key, PEM, Telegram-token and RPC-key patterns.
- Stack traces are suppressed in production health payloads.
- `/api/public/*` exposes component states and messages only; it performs no
  work and no longer triggers boot.
- Secrets live in `.env` (never committed; the gate fails if `.env` is present
  in the working tree). Operational settings live in the database.
- Inbound Telegram control is authenticated by chat allow-list and routed
  through the command bus, so no external caller can bypass risk checks.

## 4. Performance

Measured by the production stability instrumentation during the accelerated
soak (see `SOAK_RESULTS.md` for the exact run):

- Heap and RSS flat over the run; no positive growth trend.
- Handle counts (timers, sockets, database handles, locks, listeners, scheduler
  tasks) identical at the end of the run to the first sample.
- Scheduler: zero overlaps, zero duplicate registrations, bounded tick drift
  and jitter under 10x cadence compression.

## 5. Connection conformance

Every external connection is configuration-driven and uses an officially
documented endpoint: Gamma (discovery), CLOB REST + market websocket
(execution and books), Polymarket RTDS (TWAP), Binance (reference price),
Chainlink (alternative TWAP provider), Polygon RPC (wallet), Telegram.
Each is registered in the connection registry with state, latency, reconnect
count, last success, last error, endpoint and environment.

## 6. Database integrity

- SQLite in WAL mode, one handle, per-environment isolation
  (`space-v1.db` / `space-v2.db`) with an environment stamp that refuses a
  mismatched open.
- Migrations are append-only and sequential; the gate verifies this statically.
- Orders, order transitions, position transitions, sizing decisions and parity
  comparisons are append-only. Positions are derived from transitions, never
  stored mutably.
- Replay and Statistics read one shared persisted dataset. Regeneration is
  verified deterministic by `bun run verify:replay`, which reattaches the
  database with no engine running and rebuilds both twice.

## 7. VPS guide

`docs/SPACE_DEPLOYMENT.md` (Node artifact, PM2, Nginx, `.env`, backups) and
`ROLLBACK.md` (rollback under pressure).

## 8. Release gate

`bun run release:gate` runs three stages and writes a machine-readable report
into this directory:

1. Static — TypeScript, ESLint, tests (including ownership and fault-target
   catalogue), production build, dependency audit, secret scan, migration
   sequence, `.env.example`/manifest sync, replay & statistics regeneration.
2. Runtime — boots the real Node artifact and validates it only through the
   public runtime API: health, snapshot version, snapshot determinism and
   sequence advance, resource audit clean, stability verdict, scheduler
   integrity, recovery ledger, trading pipeline, V1/V2 parity, no secrets in
   the snapshot.
3. Accelerated soak — `bun run soak:accelerated` against an isolated database.

## 9. Known limitations

- The accelerated soak is evidence of leak-freedom over minutes, not the
  operational 24–48h VPS soak, which remains an acceptance step performed on
  the host.
- Chainlink Streams is present as a TWAP provider but disabled by default;
  promotion is refused until it reports a fresh sample, by design.
- Live trading has not been exercised against mainnet in this environment;
  execution evidence to date is paper-venue and testnet.
- `bun` cannot load `better-sqlite3`; every harness runs on Node (via `jiti`),
  which is also the production runtime.
