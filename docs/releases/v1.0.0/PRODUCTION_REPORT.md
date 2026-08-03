# SPACE v1.0.0 — Production Report

## 1. What v1.0.0 is

SPACE is a single Node.js application that discovers Polymarket BTC up/down
markets, evaluates the Frozen Window strategy against Binance and Chainlink
price evidence, and executes on the Polymarket CLOB under a fourteen-check risk
engine. It runs as one repository, one process, one SQLite (WAL) database, one
PM2 application behind one Nginx reverse proxy.

## 2. Topology

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

## 3. Subsystem status

| Subsystem | State | Notes |
| --- | --- | --- |
| Configuration | Complete | Zod-validated `.env`; all operational settings in the database |
| Storage | Complete | SQLite WAL, 7 migrations, environment stamp in `space_meta` |
| Single instance | Complete | Lock file beside the database; a second process refuses to boot |
| Scheduler / feeds | Complete | Drift-monitored heartbeat, reconnect counters, health registry |
| Strategy | Complete | Frozen Window, 30s/60s TWAP, deterministic window lifecycle |
| Risk | Complete | 14 mandatory checks, every decision persisted |
| Execution | Complete | LIMIT_ONLY / MARKET / LIMIT_THEN_MARKET, retries, orphan adoption |
| Settlement | Complete | Resolved outcomes ingested and applied to realized PnL |
| Statistics | Complete | Pure reduction over persisted evidence, attributed to config version |
| Replay | Complete | Market reconstruction from persisted discovery rows |
| Operator terminal | Complete | Seven workspaces; Operations Desk staged/active promotion |
| Telegram | Complete | Outbound alerts; inbound commands gated by a permission map |
| Backup / restore | Complete | Scheduled backup with restore procedure |
| Release gate | Complete | Startup validation + composite environment conformance gate |

## 4. Guarantees

- The engine cannot reach `ARMED` while any required validation item fails.
- A database stamped for one environment cannot be opened by the other.
- The RPC chain id is verified live against `SPACE_ENVIRONMENT` before ARM.
- Every state-changing operator action passes through the audited Command Bus.
- Realized PnL is settlement-derived, not mark-to-cost.
- Statistics and Replay read the same rows, so they cannot disagree.

## 5. Deferred to v1.1

- Max-exposure (notional) risk check; today only max-positions is enforced.
- Daily loss limit; today only a daily trading on/off switch exists.
- Gamma discovery response cache with an explicit TTL.
- Reconnect metrics as a chart rather than counters.

These are enhancements, not defects: none of them blocks safe operation of
v1.0.0.