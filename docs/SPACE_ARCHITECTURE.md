# SPACE — Architecture

Companion to `SPACE_SPECIFICATION.md`. The specification defines _what_ SPACE does; this document defines _how it is structured_. Where the two disagree, the specification wins.

---

## 1. Runtime topology

One VPS. One PM2 app. One Node.js process. One SQLite file. One Nginx server block.

```text
  Internet ──TLS──▶ Nginx ──▶ 127.0.0.1:PORT ──▶ SPACE (single Node process)
                                                    │
                        ┌───────────────────────────┼───────────────────────┐
                        │                           │                       │
                   HTTP / SSE                 Trading Engine            Telegram bot
                   (dashboard)              (single tick loop)        (operator commands)
                        │                           │                       │
                        └────────── Command Bus ────┴───────────────────────┘
                                          │
                                   Repository layer
                                          │
                                   SQLite (WAL) @ DB_PATH
```

There is no second service, no queue broker, no cache server, no external backend. The app port is firewalled; only Nginx reaches it.

---

## 2. Module boundaries

```text
shared → contracts → configuration → infrastructure → market → decision → trade → platform → app
```

| Layer            | Owns                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `shared`         | branded ids, `Clock`, deep-freeze, stable stringify, hashing                                          |
| `contracts`      | event envelope, reason codes, typed command and snapshot shapes                                       |
| `configuration`  | one Zod schema for `.env`, one schema for database-held configuration                                 |
| `infrastructure` | FSM helper, health registry, structured logging, scheduler, metrics, watchdogs, secret scanner        |
| `market`         | discovery, feeds, Opening TWAP, Settlement TWAP, PTB, conditioning, lifecycle                         |
| `decision`       | window FSM, frozen trigger creation, pure `decide()`, quota                                           |
| `trade`          | risk engine, exposure ledger, order FSM, standing-order engine, venue gateway, settlement, accounting |
| `platform`       | event log, ledger, replay, recovery, audit, notifications, backup                                     |
| `app`            | HTTP routes, dashboard, Telegram adapter, command bus, composition root                               |

### 2.1 Implemented foundation (milestone 1)

```text
src/core/shared        clock, ids, errors, json types
src/core/clock         authoritative Clock service (health-registered)
src/core/config        env schema (zod) + single validation point
src/core/logging       structured logger, redaction, rotating file sink
src/core/db            driver contract, sqlite (WAL) driver, migrations, repositories
src/core/health        health registry, component states
src/core/bus           event bus, command bus (serialised queue + verdicts + audit)
src/core/state         authoritative runtime state store
src/core/boot.server   startup sequence · src/core/shutdown.server  shutdown sequence
src/lib/system.functions.ts   the single read/command surface for the dashboard
```

Trading modules (`market`, `decision`, `trade`, `platform`) are not implemented yet; their health checks report `NOT_INITIALIZED`.

### 2.3 Runtime services (milestone 2)

```text
src/core/scheduler   one authoritative heartbeat (100ms), drift-corrected, checkpointed to kv
src/core/feeds       provider-neutral PriceFeed port · binance (WS) · chainlink (RPC pull)
src/core/market      unified immutable MarketState, versioned · Polymarket discovery adapter
src/core/engine      serialized engine loop; owns feed lifecycles and scheduler registrations
```

No module owns a timer. Every recurring job registers with the scheduler, which runs tasks
sequentially on one heartbeat, so the single-writer guarantee holds without a mutex.
Registered tasks: `engine.tick` (1s), `feed.binance.watchdog` (2s), `feed.chainlink.poll` (15s),
`market.discovery` (20s). Health components added: `scheduler`, `market_discovery`, `binance`,
`chainlink`. A missing `POLYGON_RPC_URL` reports `DISABLED`, never `FAILED`.

`MarketState` is the only surface downstream modules read: active market per horizon, PTB,
status, close and settlement times, Binance price and Chainlink price, with a monotonic
`version`. TWAP, windows, risk and execution are still unimplemented.

### 2.2 Foundation refinements (milestone 1, final)

**Health states.** Five states, ranked for the overall roll-up:

| State             | Meaning                                                   | Affects overall |
| ----------------- | --------------------------------------------------------- | --------------- |
| `OK`              | implemented, enabled, healthy                             | yes             |
| `DEGRADED`        | implemented and reachable, but limited                    | yes             |
| `FAILED`          | implemented and broken                                    | yes             |
| `DISABLED`        | implemented and healthy, switched **off** by the operator | no              |
| `NOT_INITIALIZED` | module does not exist in this milestone                   | no              |

`DISABLED` is never a defect. `window_5m` and `window_15m` are health components that follow the runtime window switches: enabling reports `OK`, disabling reports `DISABLED` — never `NOT_INITIALIZED`, which is reserved for unbuilt modules.

**Clock service.** `src/core/clock/clock.service.ts` is the one authoritative runtime clock, registered in the health registry during boot before anything schedules work. It exposes `clock()`, `setClock()` (replay/tests), `uptimeMs()` and `clockDriftMs()`, and reports `source`, `startedAt`, `now`, `uptimeMs`, `driftMs` and `timezone`. Installing a non-system clock reports `DEGRADED`, so replay can never be mistaken for live time.

**Event severity.** Every `EventEnvelope` carries `severity: INFO | SUCCESS | WARNING | ERROR` (default `INFO`). The runtime event log colour-codes it, and Replay and Telegram will filter on it rather than parsing event type strings.

**Database health interface.** `DatabaseDiagnostics` fixes the field set now so later capability additions need no interface change: `engine`, `path`, `journalMode`, `walEnabled`, `schemaVersion`, `migrationVersion`, `appliedMigrations`, `latencyMs`, `sizeBytes`, `openedAt`. `journalMode`, `walEnabled` and `sizeBytes` come from an optional `SqlDriver.stats()`; fields not yet obtainable in a given runtime report `null` rather than being absent.

**Boot → OBSERVE → ARM.** Boot ends in `OBSERVE`, always. `ARMED` is reachable only through an explicit operator `ARM` command: the state store throws unless the transition carries the single sanctioned `ARM_REASON`, which only the command bus uses, and the bus rejects `ARM` from any status other than `OBSERVE`. Any dashboard screenshot showing `ARMED` means the operator pressed Arm in that session.

**Foundation Console is temporary.** `src/routes/index.tsx` is milestone-1 scaffolding, labelled as such in the UI. It is replaced by the approved Mission Control layout in a later milestone. Mission Control stays operational-status-only; all configuration belongs to the Operations Desk.

Imports point left only. `tests/unit/architecture.test.ts` walks the import graph and fails the build on any upward dependency. Two additional architecture tests enforce:

1. nothing outside `db/repositories/**` imports the SQLite driver;
2. nothing under `app/**` imports `market/**`, `decision/**` or `trade/**` internals — only the command bus and snapshot contracts.

---

## 3. The engine

### 3.1 Single serialised loop

All engine work runs on one loop with an explicit mutex. Feed ingestion, window evaluation, quota accounting, order transitions and settlement never interleave. This closes STONE's largest latent risk: `ExecutionWindowManager.tick()` and `.onMarketState()` mutated shared state with no serialisation, safe only because the sole caller was a single-threaded test harness.

### 3.2 Tick responsibilities, in order

1. ingest feed samples; enforce ordering and freshness
2. update Opening TWAP capture state and the live Settlement TWAP
3. resolve PTB from official market metadata
4. publish a new immutable, versioned `MarketState`
5. advance the market lifecycle (discovery, rollover, resolve)
6. open due windows — capture, freeze, persist (write-once)
7. evaluate open windows against their **stored** frozen triggers, in priority order
8. for each trigger hit: quota → risk → exposure → execution
9. advance order state machines; apply fills idempotently
10. settle resolved markets exactly once; write accounting
11. publish the snapshot to subscribers

### 3.3 Frozen trigger storage

```text
window_record
  id · market_id · offset · window_open_time
  opening_twap · ptb · direction · buffer · buffer_mode · frozen_trigger   ← write-once
  outcome · outcome_reason · trigger_time · order_id · settled_at         ← written later
```

The write-once columns are enforced in the repository (a second write raises) and by a database trigger. Replay reads them; it never recomputes them.

---

## 4. Command bus contract

One entry point for every state-changing operator action, from the dashboard or Telegram.

```ts
type Command =
  | { kind: "ENGINE_ARM" }
  | { kind: "ENGINE_OBSERVE" }
  | { kind: "MODE_SET"; mode: "STRATEGY" | "MANUAL" }
  | { kind: "CONFIG_ACTIVATE"; versionId: string }
  | {
      kind: "MANUAL_ORDER";
      direction: "UP" | "DOWN";
      orderType: "LIMIT" | "MARKET";
      size: number;
      limitPrice?: number;
      fallbackMs?: number;
    }
  | { kind: "ORDER_CANCEL"; orderId: string }
  | { kind: "KILL_SWITCH" }
  | { kind: "BACKUP_RUN" };
```

Every command is: Zod-validated at the edge → authenticated (session or allow-listed chat id) → enqueued onto the engine loop → executed → answered with an explicit `Verdict` (`ACCEPTED` / `REJECTED` + reason code) → written to the audit log with actor, source and correlation id. Commands are never executed off-loop, and there is no second write path.

Reads flow the other way as one `EngineSnapshot`, pushed over SSE and also available as a point read. Mission Control, Overview, Manual Trading and Statistics all subscribe to that single snapshot, so surfaces cannot disagree.

---

## 5. Data layer

SQLite (WAL) via `better-sqlite3`. Tables, ported from the best of STONE's Postgres schema and P4's SQLite schema:

| Table                    | Purpose                                              | Mutability                           |
| ------------------------ | ---------------------------------------------------- | ------------------------------------ |
| `markets`                | discovered official markets, lifecycle state         | mutable status                       |
| `windows`                | one row per execution window, with the frozen fields | frozen fields write-once             |
| `orders`                 | order records and idempotency keys                   | mutable state, append-only log below |
| `order_events`           | full order lifecycle chain                           | append-only                          |
| `fills`                  | venue fill evidence                                  | append-only                          |
| `platform_events`        | event-sourced log for replay                         | append-only                          |
| `ledger_records`         | money movements                                      | append-only                          |
| `settlements`            | exactly-once settlement results                      | insert-once                          |
| `configuration_versions` | immutable configuration snapshots                    | insert-only                          |
| `audit_log`              | every command, actor, verdict                        | append-only                          |
| `sessions_runtime`       | per-process session summary                          | append + close                       |
| `kv`                     | engine checkpoint, resume flags                      | mutable                              |

Append-only tables are enforced by triggers that reject UPDATE and DELETE. Idempotency uses unique constraints and treats a unique violation as the replay signal — the same pattern STONE used against Postgres `23505`.

All access is through typed repositories (specification §18). The async write queue drains on a separate microtask chain so a disk stall never blocks a tick.

---

## 6. External adapters

| Adapter            | Role                                                    | Failure posture                                     |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------- |
| Binance feed       | price samples for both TWAPs                            | reconnect with backoff; staleness blocks triggering |
| Polymarket CLOB v2 | market discovery, metadata, PTB, order placement, fills | reconnect; discovery failure degrades to OBSERVE    |
| Wallet / RPC       | balances, allowances, EIP-712 signing                   | failure blocks ARMED                                |
| Telegram           | operator interface and alerts                           | non-fatal; degraded badge                           |

Each adapter sits behind a port defined in its owning layer. The venue port has exactly two implementations: the live CLOB gateway and a paper/chaos gateway. Both satisfy the same contract and the same tests; the engine cannot tell them apart.

---

## 7. Observability

Structured JSON logging with correlation ids on every line (no raw `console.*`). A health registry with one check per dependency, exposed at `/api/public/health` for Nginx and PM2 and rendered in Mission Control. Prometheus-shaped metrics at `/metrics`, bound to localhost. Watchdogs for feed staleness, stuck RESTING orders, reconciler drift and settlement divergence, each with a Telegram alert.

---

## 8. Security posture

Single operator, session cookie, server-side gate in one place (specification §17). Secrets live only in `.env`, are read only inside the process, and are scanned for at write time by the secret scanner so they can never reach the event log, the audit log, an API response or a backup. Nginx terminates TLS; the app port is not publicly reachable.

---

## 9. Documentation policy

Nothing from STONE is deleted. `docs/archive/` holds the STONE charter, all ADRs, the milestone and audit reports, the qualification reports, and the P4 reference material including its knowledge documents. The active `docs/` root holds `SPACE_SPECIFICATION.md`, `SPACE_ARCHITECTURE.md`, `SPACE_MIGRATION_REPORT.md` and operational runbooks.

---

## 10. Milestone 3 — Frozen Window Strategy Engine (implemented)

The strategy engine calculates decisions only. It never places an order: its
sole output is an immutable **Execution Intent** that the Execution Engine will
consume in a later milestone.

### Modules

| Module                                 | Responsibility                                                        |
| -------------------------------------- | --------------------------------------------------------------------- |
| `core/strategy/types.ts`               | strategy vocabulary (pure data)                                        |
| `core/strategy/config.ts`              | Buffer Engine: window list, per-window buffers, trades per market       |
| `core/strategy/twap.ts`                | Settlement TWAP Engine (time-weighted, final 30s / 60s)                 |
| `core/strategy/windows.ts`             | window planning, direction, frozen trigger maths, trigger predicate, quota |
| `core/strategy/prediction.ts`          | Bot Prediction (advisory only, imported by no strategy module)          |
| `core/strategy/engine.ts`              | deterministic Frozen Window engine (no clock, no IO)                    |
| `core/strategy/strategy.server.ts`     | runtime host: tick-driven evaluation, persistence, events, health       |
| `db/repositories/strategy.repository.ts` | the only place strategy SQL exists                                    |

### Settlement TWAP

Time-weighted, not sample-weighted: each observed price is held until the next
observation, so an irregular feed cadence cannot skew the average.

- BTC 5 minute — final **30 seconds** before settlement.
- BTC 15 minute — final **60 seconds** before settlement.

States: `IDLE` (no active market), `WARMING` (below the minimum sample count),
`OK`, `STALE` (last sample older than `maxTwapAgeMs`). Only `OK` may freeze a
trigger or satisfy one.

### Window layout and lifecycle

Windows are laid out relative to settlement and never overlap: the 15s window is
live from T-15s until the 10s window opens at T-10s; the smallest window runs to
settlement. Exactly one window can be `ACTIVE`, which makes quota consumption
race-free on the single serialized loop.

```text
WAITING → OPEN → ACTIVE → TRIGGERED → COMPLETED   (execution intent created)
WAITING → OPEN → ACTIVE → EXPIRED   → NO_TRIGGER
WAITING → QUOTA_EXHAUSTED
WAITING → WINDOW_DISABLED
```

At window open the engine captures Opening TWAP, PTB, direction, buffer and open
time and writes the **frozen trigger** exactly once:

```text
direction = Opening TWAP >= PTB ? UP : DOWN
UP   trigger = Opening TWAP + buffer
DOWN trigger = Opening TWAP - buffer
```

The trigger never changes for the life of that window. `frozen_triggers` is a
write-once table protected by SQL triggers, so even an engine bug cannot rewrite
trading evidence. Every transition is appended to `window_transitions`.

### Trigger engine and quota

The live settlement TWAP is compared to the frozen trigger on every strategy
tick (200ms — the 3s window needs sub-second resolution, still a single
scheduler task). UP fires at `TWAP >= trigger`, DOWN at `TWAP <= trigger`.
Quota is consumed only by windows that produced an intent, in the deterministic
15s → 10s → 7s → 5s → 3s order; remaining windows become `QUOTA_EXHAUSTED`.

### Execution intent

Immutable, persisted to `execution_intents`, with a derived id
(`intent:<conditionId>:<seconds>s`) so replay reproduces it exactly. Fields:
market, direction, window, opening TWAP, settlement TWAP, PTB, buffer, frozen
trigger, trigger time, reason.

### Determinism

The engine takes `(now, unified market state, enabled horizons)` and owns no
timers and no provider access. Same inputs, same events — this is what makes
Replay possible. Configuration is locked per market at plan creation, so a later
Operations Desk edit can never reach a market already in flight.

### Health additions

`settlement_twap` and `strategy` join the registry, reporting `DISABLED` when
the engine is not running, `DEGRADED` for warming/stale TWAP or unpersisted
evidence, and `FAILED` on an evaluation error.

---

## 11. Milestone 4 — Execution Engine (implemented)

Milestone 4 turns strategy decisions into real orders. The path is fixed and no
module may shortcut it:

```text
Strategy -> Execution Intent -> Risk Engine -> Execution Engine
         -> Polymarket CLOB -> Order Monitor -> Order State
```

### 11.1 Modules

| Module | File | Purpose |
| --- | --- | --- |
| Vocabulary | `src/core/execution/types.ts` | Order states, risk codes, records, config |
| Config | `src/core/execution/config.ts` | Defaults (`LIMIT_ONLY`), validation, price clamp |
| Risk Engine | `src/core/execution/risk.ts` | Pure `evaluateRisk(intent, context)` |
| Lifecycle | `src/core/execution/lifecycle.ts` | Legal transitions + fill accounting |
| Venue port | `src/core/execution/venue.ts` | Venue-agnostic interface |
| CLOB adapter | `src/core/execution/polymarket.server.ts` | Official `@polymarket/clob-client` |
| Wallet layer | `src/core/execution/wallet.server.ts` | Sole reader of `WALLET_PRIVATE_KEY` |
| Engine | `src/core/execution/engine.ts` | Pure orchestrator over injected ports |
| Runtime host | `src/core/execution/execution.server.ts` | Wiring, scheduler step, health |
| Storage | `src/core/db/repositories/execution.repository.ts` | The only SQL |

### 11.2 Idempotency guarantees

1. `orders.intent_id` is `UNIQUE` — one order chain per intent, forever.
2. `fills.id` is the venue trade id — a replayed trade feed cannot double count.
3. `order_events` and `risk_decisions` are append-only (SQLite triggers).
4. Every state is persisted **before** the engine advances.
5. Recovery reconciles; it never resubmits. An order without a venue id is
   marked `FAILED`, never retried blindly.

### 11.3 Order modes

`LIMIT_ONLY` (default) submits a limit order, waits `limitTimeoutMs`, cancels,
and retries the **same intent** up to `maxRetries` before `EXPIRED`.
`MARKET_ONLY` submits a market order directly. `LIMIT_THEN_MARKET` cancels the
limit on timeout and submits the market leg on the same order chain.

Retries never create a new intent, never touch the frozen trigger or buffer, and
are re-checked by the Risk Engine before each resubmission.

### 11.4 V1 / V2

Identical code. `SPACE_ENVIRONMENT=V1_TESTNET` targets the staging CLOB on Amoy
(chain 80002); `V2_MAINNET` targets the production CLOB on Polygon (137). Only
`.env` differs — credentials are never editable from the dashboard.

### 11.5 Health

New components: `wallet`, `polymarket`, `risk`, `execution`. All report
`DISABLED` when the engine is not running and `DEGRADED` (never `FAILED`) when
credentials are absent, so an unconfigured VPS still boots into OBSERVE.
