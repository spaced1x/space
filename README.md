# SPACE v1.0

SPACE is an autonomous trading terminal for Polymarket BTC up/down markets. It
discovers the official BTC market, evaluates the Frozen Window strategy against
Binance and Chainlink price evidence, and executes on the Polymarket CLOB behind
a fourteen-check risk engine — all from a single operator console.

SPACE is deliberately small in topology and large in discipline: one repository,
one Node.js process, one SQLite (WAL) database, one PM2 application, one Nginx
reverse proxy. There is no external backend, no microservice, and no hosted
database.

## Architecture overview

```text
  Nginx (TLS, operator network only)
        |
  PM2 "space" -> dist/server/index.mjs   (single instance, lock-enforced)
        |
  +-----+-----------------------------+
  | scheduler (100ms heartbeat)       |
  | engine loop -> strategy -> risk   |
  | execution -> Polymarket CLOB      |
  | feeds: Binance WS, Chainlink RPC  |
  | settlement ingestion (Gamma)      |
  | telegram in/out, backup, metrics  |
  +-----------------------------------+
        |
  SQLite WAL at DB_PATH (7 migrations)
```

Two rules govern the whole system:

1. **The Environment Rule.** `.env` holds permanent secrets and immutable
   runtime facts only. Every operational setting (windows, buffers, sizes, order
   modes, retries) lives in the database and is edited from the Operations Desk.
2. **No bypass.** Nothing reaches the venue without passing Strategy → Risk →
   Execution, and every state-changing operator action passes through the
   audited Command Bus.

Full detail lives in [`docs/SPACE_SPECIFICATION.md`](docs/SPACE_SPECIFICATION.md)
(source of truth) and [`docs/SPACE_ARCHITECTURE.md`](docs/SPACE_ARCHITECTURE.md).

## Features

- Frozen Window strategy with 30s/60s settlement TWAPs and a deterministic
  window lifecycle.
- Fourteen mandatory risk checks, with every decision persisted.
- Execution modes: `LIMIT_ONLY`, `MARKET`, `LIMIT_THEN_MARKET` with retries and
  orphan-order adoption.
- Boot-time reconciliation between local and venue state; ARM is blocked until
  it succeeds.
- Health registry per component (`OK` / `DEGRADED` / `FAILED` / `DISABLED`) with
  automatic disarm on critical failure.
- Settlement ingestion from Polymarket Gamma, so realized PnL is
  settlement-derived rather than mark-to-cost.
- Single-instance lock: a second process refuses to boot against the same
  database.
- Environment stamping: a database created for V1 testnet cannot be opened by a
  V2 mainnet process.
- Telegram alerts and gated inbound operator commands.
- Scheduled backup with a rehearsed restore procedure.
- Seven-workspace operator terminal: Mission Control, Market, Strategy,
  Execution, Manual, Operations Desk, Statistics, Replay, Diagnostics.

## Milestone summary

| # | Milestone | Delivered |
| --- | --- | --- |
| 1 | Foundation | Zod-validated env, JSON logging, SQLite WAL + migrations, event/command bus, runtime state store, console shell |
| 2 | Runtime services | 100ms scheduler, Binance WS and Chainlink RPC feeds, Polymarket discovery, unified market state, engine loop, health registry |
| 3 | Strategy engine | Frozen Window, 30s/60s TWAP, window lifecycle, execution intents (no orders submitted) |
| 4 | Execution engine | 14-check risk engine, wallet and CLOB adapter, order lifecycle, fills, retries |
| 5 | Operator terminal | Operations Desk staged/active promotion, Replay, manual trading, Statistics, workspace UI |
| 6 | Production hardening | Rate limiting, orphan adoption, clock-drift monitoring, auto-disarm, Telegram, backup/restore |
| 7 | Validation & release gate | Single-instance lock, pre-ARM validation, emergency stop, settlement ingestion, environment conformance gate, versioned release artifacts |

## Technology stack

- **Runtime:** Node.js (production) / Bun (development toolchain)
- **Framework:** TanStack Start v1 (React 19, Vite 7, server functions)
- **Database:** SQLite in WAL mode via `better-sqlite3`
- **Chain / venue:** `ethers` v5, `@polymarket/clob-client`
- **Validation:** Zod
- **UI:** Tailwind CSS v4, shadcn/ui, Recharts
- **Tests:** Vitest
- **Process manager:** PM2; **reverse proxy:** Nginx

## Project structure

```text
src/
  core/
    backup/        scheduled backup + health
    bus/           command bus, commands, events
    clock/         monotonic clock service
    config/        env schema, operations desk config, snapshots
    db/            driver, migrations, repositories, instance lock
    engine/        engine loop
    execution/     risk, venue, order lifecycle, reconciliation, manual
    feeds/         Binance WS, Chainlink RPC
    health/        registry, auto-disarm
    logging/       structured logger + file sink
    market/        discovery, unified market state
    metrics/       sampling and persistence
    release/       release report generation
    replay/        market reconstruction
    scheduler/     heartbeat and drift monitoring
    settlement/    Gamma ingestion and PnL application
    startup/       pre-ARM validation gate
    stats/         statistics reductions
    strategy/      TWAP, windows, prediction, frozen trigger
    telegram/      inbound commands, outbound alerts
    validation/    failure-simulation harness
  components/space/  operator console panels
  lib/               server functions consumed by routes
  routes/            file-based routes (+ api/public/health)
tests/unit/          vitest suites
docs/                specification, architecture, deployment, release gate
docs/releases/v1.0.0/ immutable release artifacts
```

## Installation

```sh
git clone <this-repository-url> space && cd space
bun install
```

`better-sqlite3` is an optional dependency: authoring environments without a
native toolchain still install, and the database reports `DEGRADED` there
instead of crashing. On the VPS the native build must succeed.

## Environment configuration

```sh
cp .env.example .env
```

Fill in secrets only. `.env.example` documents every variable the schema reads:
runtime (`NODE_ENV`, `SPACE_ENVIRONMENT`, `PORT`), storage (`DB_PATH`), logging,
Polymarket CLOB credentials, wallet/chain, market data feeds, and optional
Telegram. Missing venue secrets keep the engine limited to `OBSERVE` rather than
blocking boot. Never commit a real `.env`.

## Running locally

```sh
bun run dev        # http://localhost:8080
```

## Test commands

```sh
bunx vitest run    # 9 suites, 52 tests
bun run lint
```

## Build commands

```sh
bun run build                            # authoring/preview target
NITRO_PRESET=node-server bun run build   # VPS artifact -> dist/server/index.mjs
```

`vite.config.ts` reads `NITRO_PRESET`; when set it pins the output layout to
`dist/` so PM2 always starts `dist/server/index.mjs`.

## Production deployment

```sh
git clone <repo> /opt/space && cd /opt/space
cp .env.example .env      # secrets only
bun install
NITRO_PRESET=node-server bun run build
pm2 start ecosystem.config.cjs && pm2 save
```

### PM2 setup

`ecosystem.config.cjs` defines a single app named `space`, fork mode, one
instance, `autorestart` with `min_uptime` 30s, and `kill_timeout` 15s so the
shutdown sequence can checkpoint WAL and close SQLite cleanly. Logs go to
`./logs/pm2-out.log` and `./logs/pm2-error.log`.

```sh
pm2 start ecosystem.config.cjs
pm2 logs space
pm2 restart space
pm2 stop space
```

### Nginx setup

Terminate TLS at Nginx, proxy to the app port, and never expose the app port
publicly. SPACE v1.0 has no internal authentication by design — access control
is the operator network's responsibility.

```nginx
server {
  listen 443 ssl;
  server_name space.example.com;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

Health probe: `GET /api/public/health` — 200 when healthy or degraded, 503 when
failed.

## Database information

SQLite in WAL mode at `DB_PATH` (default `./data/space.db`). Seven migrations
apply automatically on first boot and cover: core kv/audit/events, strategy
(`frozen_triggers`, `execution_intents`), execution (`orders`, `fills`,
`risk_decisions`), replay (`market_discoveries`), production hardening
(reconciliation, backups, telegram outbox), metrics/release artifacts, and
settlement (`settlements`, `space_meta` environment stamp).

Runtime state restores from the `kv` table on reboot — always into `OBSERVE`,
never `ARMED`.

## Telegram integration

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Outbound: critical `ERROR` and
`WARNING` events plus operator broadcasts, queued in the outbox and retried on
the next event. Inbound: commands are gated by an explicit permission map
(`SAFE_CONTROLS` vs `FULL_OPERATOR`) and routed through the audited Command Bus.
Telegram is optional; its absence degrades, never blocks.

## Operator workspaces

### Mission Control
Engine status, per-component health, wallet, positions and PnL, plus the ARM /
DISARM / PAUSE / RESUME / STOP command deck and the emergency-stop latch.

### Operations Desk
Every operational setting, edited in a staged copy and promoted to active only
by explicit operator action. Validation rejects nonsensical values. No secrets
are ever exposed here. Each configuration version is recorded so statistics can
be attributed to it.

### Diagnostics
Startup validation results, the environment conformance gate, scheduler drift,
reconnect counters, reconciliation divergences, and the failure-simulation
harness.

### Replay
Reconstructs any past market from persisted `market_discoveries` rows — the same
evidence Statistics reads, so the two cannot disagree.

### Statistics
Pure reduction over persisted evidence: realized PnL (settlement-derived), win
rate, latencies, and a PnL-by-configuration-version breakdown.

## Backup & restore

Backups are scheduled and recorded in the database. The database is one file
plus its WAL:

```sh
sqlite3 $DB_PATH ".backup space-backup.db"
```

Restore copies the file back and requires a process restart. Secrets are never
included in a backup; restore `.env` separately. Never roll a database backwards
across a migration boundary.

## Release process

1. Cut the version and record artifacts under `docs/releases/<version>/`.
2. Run `generateReleaseReport("<version>")` on the VPS in production mode; it
   writes a JSON snapshot and records the outcome in `release_artifacts`.
3. Complete the manual sign-off in
   [`docs/SPACE_PRODUCTION_RELEASE_GATE.md`](docs/SPACE_PRODUCTION_RELEASE_GATE.md).
4. Promote only when `gate.passed = true` and every manual item is signed off.

Rollback is documented verbatim in
[`docs/releases/v1.0.0/ROLLBACK.md`](docs/releases/v1.0.0/ROLLBACK.md) and must
never require manual database editing.

## Production release gate

The automated checklist requires: valid startup validation, overall health `OK`
or `DISABLED`, database `OK`, scheduler `OK`, emergency stop clear, engine not
`ARMED`, and at least one metrics sample. The environment conformance gate adds
six items covering CLOB host, chain id, live `eth_chainId`, wallet address and
the database environment stamp.

## Known limitations

- Max-exposure (notional) risk check is deferred; only max-positions is enforced.
- Daily loss limit is deferred; only a daily trading on/off switch exists.
- Gamma discovery has no response cache with an explicit TTL.
- Reconnect metrics are counters, not charts.
- No internal authentication: SPACE relies on VPS and Nginx access control.

None of these blocks safe operation of v1.0.0.

## License

Proprietary. All rights reserved.
