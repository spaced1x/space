# SPACE — Product Specification

Status: **LOCKED**. Version 1.0. This document is the single source of truth for SPACE. Where any other document, comment, ticket or conversation disagrees with this file, this file wins. Changes require an explicit specification revision, not an implementation decision.

> **Simple systems survive. Complex systems fail.**
>
> When a decision is uncertain, choose the option that is simpler, easier to maintain, easier to deploy, easier to recover, easier to understand, and more reliable. Reliability outranks new features, always.

---

## 1. Product vision

SPACE is a single-operator automated trading system for Polymarket's official BTC up/down markets, driven by a Binance-sourced TWAP and the **Frozen Window** strategy.

It is the successor to STONE. STONE contained a high-quality, fully-tested trading _domain library_ that was never wired into a running process, and a proven trading bot (P4) that was architecturally frozen out of the repository. SPACE joins those two halves into **one Node.js application** that a single operator runs on **one VPS**, backed by **one local database**, supervised by **one PM2 process**, behind **one Nginx configuration**, configured by **one `.env.example`**.

SPACE is not a platform, not a product for multiple users, and not a cloud service. It is an operator's instrument. Every architectural decision serves reliability, recoverability and explainability.

**Non-goals:** multi-user accounts, horizontal scale, microservices, cloud dependencies (no Supabase, no Cloudflare), a public API, mobile apps, multi-venue support.

---

## 2. Architecture

One repository. One process. Layered core with executable enforcement.

```text
shared → contracts → configuration → infrastructure → market → decision → trade → platform → app
```

Imports may only point left. An architecture test walks the import graph and fails the build on any upward dependency. This rule is inherited from STONE and is one of its most valuable assets.

```text
                 ┌──────────────────────────────────────────┐
                 │  Dashboard (React, TanStack)             │
                 │  Mission Control · Desk · Manual · Replay│
                 └──────────┬───────────────────▲───────────┘
                   command  │                   │  snapshot / events
                 ┌──────────▼───────────────────┴───────────┐
                 │  Command Bus  (validated · audited)      │
                 └──────────┬───────────────────────────────┘
   Telegram ────────────────┤
                 ┌──────────▼───────────────────────────────┐
                 │  TRADING ENGINE (single serialised loop) │
                 │  timers · markets · windows · triggers   │
                 │  TWAP · PTB · quota · risk · execution   │
                 │  settlement                              │
                 └──────────┬───────────────────────────────┘
                 ┌──────────▼───────────────────────────────┐
                 │  Repository layer  →  SQLite (WAL)       │
                 └──────────────────────────────────────────┘
```

### 2.1 Engine ownership (binding)

The Trading Engine is the **sole owner** of, and the only component permitted to mutate:

- timers and the scheduler tick
- market lifecycle (discovery, arm, active, rollover, resolve)
- execution windows and their state machine
- frozen triggers
- TWAP (opening capture and live settlement TWAP)
- PTB resolution
- trade quota
- risk evaluation
- order execution and the order state machine
- settlement and accounting

The dashboard **never owns trading logic**. It has exactly two rights:

1. **Read** — display state the engine publishes.
2. **Command** — send a named, validated, audited command to the in-process engine and await its verdict.

No page, component, loader, hook or route may compute a price, a direction, a trigger, a position size, a PnL figure or a risk verdict. If a number appears in the UI, the engine produced it. Enforced by an architecture test.

### 2.2 Engine modes

| Axis    | Values                                                                            |
| ------- | --------------------------------------------------------------------------------- |
| Arming  | `OBSERVE` (evaluates and records, places no orders) · `ARMED` (execution enabled) |
| Control | `STRATEGY` (automatic) · `MANUAL` (operator-driven)                               |

The two axes are independent, but `MANUAL` disables automatic strategy execution entirely (section 10).

### 2.3 Database

SQLite in WAL mode via `better-sqlite3`, at a single `DB_PATH`, behind a typed repository layer. SPACE is one process with exactly one writer — the engine — so SQLite's only real limitation (concurrent writers) does not exist here. A local PostgreSQL server would add a second supervised subsystem to solve a problem SPACE does not have.

Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`. Writes go through an async queue that never blocks the engine tick loop. Migrations are forward-only and numbered, applied at boot.

---

## 3. Frozen Window Strategy

This is the heart of SPACE. The lifecycle is normative product behaviour, not an implementation detail.

```text
Window Opens
  ↓ Capture Opening TWAP
  ↓ Compare Opening TWAP with PTB
  ↓ Determine Direction (UP / DOWN)
  ↓ Create Frozen Trigger
       UP   = Opening TWAP + Buffer
       DOWN = Opening TWAP - Buffer
  ↓ Persist permanently for that window:
       Opening TWAP · PTB · Direction · Buffer · Frozen Trigger · Window Open Time
  ↓ Continuously evaluate the LIVE Settlement TWAP until the window expires

  ├── Trigger reached ──▶ Risk Engine ──▶ Execution Engine ──▶ Settlement ──▶ Window Completed
  └── Trigger never reached ─────────────────────────────────▶ Window Completed (NO_TRIGGER)
```

### 3.1 The invariant

**Once a window opens, its Frozen Trigger never changes.** Not on a new TWAP tick, not on a PTB update, not on a configuration edit, not on a feed reconnect, not on a process restart. It is written once, at window open, and every later evaluation and every replay reads that stored value.

Direction is decided once, from Opening TWAP versus PTB, and stored with the trigger. Buffer is read once, at window open, from the active configuration version and stored with the trigger; a later Operations Desk edit cannot alter a window already open.

This is the single most important behavioural difference from STONE, whose execution-window state machine re-evaluated against the moving TWAP and therefore had no frozen trigger at all.

### 3.2 Enforcement

- The window record's frozen fields (`opening_twap`, `ptb`, `direction`, `buffer`, `frozen_trigger`, `window_open_time`) are **write-once** at the repository layer; a second write raises.
- A determinism test asserts that replaying a window's event log reproduces an identical frozen trigger.

### 3.3 Window outcomes

Every window closes with exactly one terminal outcome, persisted with its evidence:

| Outcome           | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `FILLED`          | trigger hit, risk passed, order filled, settled                               |
| `NO_TRIGGER`      | window expired without the live settlement TWAP reaching the frozen trigger   |
| `QUOTA_EXHAUSTED` | trades-per-market budget already consumed by earlier windows                  |
| `RISK_REJECTED`   | trigger hit, risk engine vetoed — the failing check is named                  |
| `LIMIT_TIMEOUT`   | limit order unfilled at the deadline, with fallback disabled or also unfilled |
| `MARKET_DISABLED` | the market was disabled in the Operations Desk                                |
| `WINDOW_DISABLED` | this execution window was disabled in the Operations Desk                     |

---

## 4. TWAP Strategy

SPACE uses **two distinct TWAPs**. They are separately named, separately stored, and never conflated in code, storage, UI or replay.

|                     | Purpose                                                 | When                                   |
| ------------------- | ------------------------------------------------------- | -------------------------------------- |
| **Opening TWAP**    | produces the direction and the frozen trigger           | captured once, at window open          |
| **Settlement TWAP** | the live comparand evaluated against the frozen trigger | continuously, until the window expires |

### 4.1 Settlement TWAP definition

| Market        | Settlement TWAP          |
| ------------- | ------------------------ |
| BTC 5 minute  | final **30-second** TWAP |
| BTC 15 minute | final **60-second** TWAP |

### 4.2 PTB

PTB (the price-to-beat) is read **only** from official market metadata. It is never inferred from the order book. A window cannot open without a validated PTB.

### 4.3 Freshness

A stale settlement TWAP blocks triggering rather than firing on old data. TWAP must be **warm** — its buffers filled to full depth — before any window may open; until then TWAP reports `WARMING` and the engine stays in `OBSERVE`.

### 4.4 Buffer

Every execution window owns its own buffer:

- decimal values allowed
- editable by the operator in the Operations Desk
- a different value per window
- stored with the configuration version, never in `.env`
- **never changes while a market is active** — edits stage and take effect at the next market
- applied at window open and copied into the window record with the frozen trigger

Example set: `15s = 6.5 · 10s = 5.0 · 7s = 3.5 · 5s = 2.0 · 3s = 1.0`.

---

## 5. Active market discovery

SPACE automatically discovers and tracks the **official active BTC market** from Polymarket. There is **no manual market selection** anywhere in the product — no dropdown, no override, no URL parameter.

One resolver owns discovery and publishes a single `activeMarket` in the engine snapshot. The Dashboard, Trading Engine, Replay, Statistics and Manual Trading all read that same value, so every surface is always on the same market.

On rollover the resolver advances to the next official market; the previous market's windows complete and settle on their own record. If discovery fails or is ambiguous, the engine degrades to `OBSERVE` and raises an alert rather than guessing.

---

## 6. Trades per market and execution priority

Windows execute in a fixed, deterministic order: **furthest-from-settlement first** — 15s → 10s → 7s → 5s → 3s. Quota is consumed in that order and only by filled trades.

Worked example — windows 15s, 10s, 7s, 5s, 3s with `Trades Per Market = 3`:

```text
15s  ──▶ fill (1/3)
10s  ──▶ fill (2/3)
7s   ──▶ fill (3/3)
5s   ──▶ Window Completed · QUOTA_EXHAUSTED
3s   ──▶ Window Completed · QUOTA_EXHAUSTED
```

Quota is evaluated by the engine alone, on its single serialised loop, so two windows can never race the last slot. `Max positions` is a separate, additional gate. Disabled windows are skipped without consuming quota. Ordering is never influenced by arrival timing, latency or UI state: given the same configuration and the same triggers, the same windows fill every time.

---

## 7. Order execution modes

| Mode               | Behaviour                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Limit Only**     | Submit a limit order only. Unfilled at the deadline → cancel → `LIMIT_TIMEOUT`.                                 |
| **Market Only**    | Submit a market order only.                                                                                     |
| **Limit → Market** | Submit limit first; if the configured timeout expires unfilled, cancel and automatically submit a market order. |

**Limit is the default mode.** The fallback timeout is configurable in the Operations Desk. Cancel-then-submit is sequenced so a partially filled limit reduces the fallback market size to the remainder — the engine can never end up long twice for one trigger. Mode and timeout are captured in the window record and shown in Replay.

---

## 8. Dashboard

Dark-only oklch token system, IBM Plex Sans with JetBrains Mono for all numerics, inherited from STONE. Every value is rendered from one engine snapshot subscription.

### 8.1 Mission Control (permanent left panel)

The operator's primary status panel, present on every page:

| Group        | Items                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Engine       | Engine status · Observe / Armed · Manual Mode · Strategy Mode · Current Engine Mode · Current Session (id, start time, uptime) |
| Markets      | Active Market · Market Countdown to settlement · Current Execution Window · BTC 5m · BTC 15m                                   |
| Money        | Wallet balance · Today's PnL · Active trades                                                                                   |
| Dependencies | Binance · Polymarket · TWAP · Database · Telegram                                                                              |

Each dependency renders as a health tone (healthy / degraded / unavailable) with last-seen age. Because every value comes from one snapshot subscription, no two panels can disagree.

### 8.2 Pages

`Overview` · `Operations Desk` · `Manual Trading` · `Replay` · `Statistics` · `Health` · `Settings`. STONE's seven telemetry pages that re-sliced one snapshot are merged into Mission Control and Overview.

---

## 9. Operations Desk

The single configuration surface. Everything here is stored in the local database, versioned, audited and applied by the engine — never read from `.env`.

**Per execution window** (15s, 10s, 7s, 5s, 3s, and any future offset):

- enable / disable the window independently
- buffer value and mode (absolute or percent)
- trade amount for that window

**Per market:**

- market enable / disable
- BTC 5m enable · BTC 15m enable (independent)
- trades per market (quota)
- max concurrent positions

**Execution:**

- order type: limit · market
- limit → market fallback (on/off, with deadline)
- retry settings: attempt budget, delay, cancel/replace ceiling

Changes are staged, validated with Zod, diffed against the running configuration, then activated by an explicit operator action. Configuration versions are **immutable**: activation creates a new version, it never edits one. The desk shows `PENDING → ACTIVE` and any drift. Edits never affect a window already open or a market already active.

---

## 10. Manual Trading and Bot Prediction

### 10.1 Manual Trading

- **Mutual exclusion.** Engine control mode is `STRATEGY` or `MANUAL`. Turning Manual Mode ON disables automatic strategy execution: windows stop producing intents, quota is untouched, no frozen triggers fire. Switching is a single audited command; the engine drains in-flight strategy work before the switch completes.
- **Live decision surface.** The dashboard shows, from the engine: live Opening and Settlement TWAP, PTB, the per-window buffer, and the Bot Prediction.
- **Actions.** BUY UP / BUY DOWN, with **Limit** or **Market** order type, explicit size, optional limit→market fallback.
- **Same execution engine.** Manual orders travel the identical path: risk gate → exposure ledger → standing-order engine → venue gateway → settlement. They are tagged `origin: MANUAL` in the ledger, order log and replay, and receive **no** risk exemption.
- **Non-interference.** Manual sessions never consume strategy quota, never mutate window state, and never persist strategy configuration. Returning to Strategy Mode resumes from a clean window slate at the next market boundary.

### 10.2 Bot Prediction

Completely isolated from trading. **Visual only, advisory only.** It derives a would-be direction from the same TWAP calculations the engine uses and displays it. It never creates a trade, never enqueues an intent, never affects strategy mode, and never affects manual mode. Removing the panel would change nothing about execution.

---

## 11. Replay

Two surfaces, one page.

### 11.1 Per-trade forensic replay

For every trade, Replay displays: Opening TWAP (value and capture time) · Frozen Trigger (latched value and the buffer that produced it) · PTB (value and metadata source) · Buffer (value and mode) · Direction and its evidence · Trigger Time · Execution Window and its configuration at that moment · Risk decision (all checks, in order, each with its verdict) · Order lifecycle (submit, ack, reprice, cancel/replace, partial fills, terminal) · Fill evidence (venue fill ids, prices, sizes, latencies, feed freshness) · Settlement result (WIN / LOSS / SCRATCH, payout, PnL, balance after).

### 11.2 Skipped windows

Every completed window is explainable, including those that never traded. `NO_TRIGGER`, `QUOTA_EXHAUSTED`, `RISK_REJECTED`, `LIMIT_TIMEOUT`, `MARKET_DISABLED` and `WINDOW_DISABLED` windows still record Opening TWAP, PTB, direction, buffer and frozen trigger — a no-trade decision is as auditable as a trade.

### 11.3 Determinism replay

The event-sourced replay carried over from STONE: reconstruct projections from the event log, verify the invariants (event ordering, market-state version, FSM transitions, correlation ids, quota progression, execution ids), compare digests, flag divergence.

Replay is read-only. It never recomputes from live data and never re-executes.

---

## 12. Statistics

Computed by the engine from the ledger and order log — never derived in the browser:

- today's trades
- win rate
- PnL (realised, and open mark-to-market)
- largest win · largest loss
- average daily PnL
- best execution window (by win rate and by PnL)
- best buffer
- fill percentage
- average execution latency (submit → ack)
- average trigger-to-fill latency (frozen trigger hit → fill)
- daily summaries
- session summaries (per process run, so a restart is visible)

---

## 13. Startup and shutdown

### 13.1 Startup sequence

```text
Boot → Validate Environment → Open Database → Load Configuration → Market Discovery
     → Connect Binance → Initialize TWAP → Connect Polymarket → Load Wallet
     → Initialize Telegram → Replay Recovery → Health Verification → OBSERVE → ARMED
```

| Stage                | Responsibility                                                                         | Failure behaviour                                               |
| -------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Validate Environment | Zod-parse `.env`; assert every required secret is present and well-formed              | hard exit, non-zero — PM2 must not loop a misconfigured process |
| Open Database        | open SQLite at `DB_PATH`, apply pragmas, run pending migrations, verify schema version | hard exit                                                       |
| Load Configuration   | read the active configuration version; validate windows, buffers, quotas               | hard exit if invalid; no implicit defaults                      |
| Market Discovery     | resolve the official active BTC market                                                 | stay in OBSERVE, alert, retry                                   |
| Connect Binance      | open the price feed, confirm first tick                                                | stay in OBSERVE, retry with backoff                             |
| Initialize TWAP      | warm the buffers to full depth before publishing any value                             | TWAP reports `WARMING`; no window may open                      |
| Connect Polymarket   | authenticate CLOB, load market/token metadata and the PTB source                       | stay in OBSERVE, retry                                          |
| Load Wallet          | derive address, read balances and allowances                                           | stay in OBSERVE                                                 |
| Initialize Telegram  | bind bot, verify chat id, announce boot                                                | non-fatal; degraded                                             |
| Replay Recovery      | reconcile persisted state with the venue (section 14)                                  | must complete before ARMED                                      |
| Health Verification  | assert every dependency healthy and TWAP warm                                          | blocks ARMED                                                    |
| OBSERVE              | engine runs, evaluates, records — places no orders                                     | steady state                                                    |
| ARMED                | execution enabled                                                                      | steady state                                                    |

SPACE never boots straight into `ARMED` after an unclean shutdown. The operator arms it, or auto-arm fires only after Health Verification passes clean.

### 13.2 Shutdown sequence

```text
Stop accepting commands → Complete outstanding writes → Persist engine state
 → Flush logs → Close database → Dispose resources → PM2 Exit
```

On `SIGTERM`/`SIGINT` the engine closes the command bus (dashboard and Telegram commands are refused with a clear reason), stops opening new windows, drains the async write queue to completion, writes a shutdown checkpoint (engine mode, active market, open windows, in-flight orders), flushes logs, checkpoints the WAL and closes SQLite cleanly, disposes sockets and timers, and exits 0.

A shutdown deadline is enforced; if the drain exceeds it, the engine still writes the checkpoint before exiting so recovery is never blind. Resting orders are **not** silently cancelled — they are recorded so recovery can reconcile them.

---

## 14. Recovery

```text
VPS Restart → Engine Restart → Restore State → Restore Orders
 → Prevent Duplicate Orders → Resume Engine
```

- **Restore State** — load the last checkpoint plus persisted windows; rebuild in-memory state from the database, never from a live feed.
- **Restore Orders** — query the venue for open and recently filled orders and reconcile against the local order log. Venue truth wins; divergence is recorded and alerted.
- **Prevent duplicate orders** — every order carries a deterministic idempotency key derived from `(market, window, attempt)`. Resubmitting the same key is a no-op at the gateway, so a restart mid-submit can never double-fill. Orphaned local OPEN rows with no venue counterpart are closed and refunded.
- **Expired windows** — a window whose expiry passed while the process was down is completed with its stored outcome; it is never re-triggered.
- **Resume Engine** — resume in `OBSERVE`, run Health Verification, then arm.

Recovery is **deterministic and idempotent**: running it twice produces the same state as running it once.

---

## 15. Backup and Restore

Objective: **clone repository → restore backup → run SPACE.**

- **Full backup** — one command producing a single timestamped archive containing the hot SQLite snapshot (`VACUUM INTO` — no downtime, no torn WAL), the exported configuration, and a manifest with schema version, app version and checksum.
- **Restore** — one command that verifies manifest and checksum, refuses a schema-version mismatch it cannot migrate, restores the database file and re-imports configuration.
- **Database portability** — a single file; copying it _is_ the migration.
- **Configuration portability** — configuration exports as JSON independently of the database, so settings can move without trade history.
- **VPS migration** — clone, install, drop in `.env`, restore the archive, `pm2 start`.
- Scheduled local backups with retention, plus a documented off-box copy step. **Backups never contain secrets.**

---

## 16. Telegram operator interface

Telegram is a **control surface**, not just an alert channel. It is authenticated by a chat-id allow-list and routes through the same command bus, rate limits and audit trail as the dashboard.

| Command      | Effect                                                            |
| ------------ | ----------------------------------------------------------------- |
| `/status`    | engine mode, market, active window, open orders                   |
| `/pause`     | pause automatic execution (does not kill the process)             |
| `/resume`    | resume automatic execution                                        |
| `/pnl`       | today's PnL and win rate                                          |
| `/balance`   | wallet balance and bankroll                                       |
| `/positions` | open positions and resting orders                                 |
| `/logs`      | recent audit and error lines                                      |
| `/health`    | dependency health, same data as Mission Control                   |
| `/mode`      | show mode; with an argument, switch Observe/Armed/Manual/Strategy |

Write commands are confirmed, rate-limited and audited. Alerts (risk breach, kill switch, reconciler drift, feed staleness, settlement divergence) push to the same chat.

---

## 17. Local authentication

SPACE is a **single-operator application**. No signup, no roles, no permissions matrix, no invitations, no password-reset flow, no user table.

- One operator credential: a username and an Argon2id password hash in `.env`, plus `SESSION_SECRET`.
- Login issues a signed, httpOnly, SameSite=strict session cookie with an idle timeout; `secure` when served over TLS.
- Every route except the login page and the health endpoint requires that session, enforced server-side in one place.
- Rate-limited login attempts, audited logins, and a documented rotation procedure (edit `.env`, restart).
- Nginx terminates TLS and may add an IP allow-list; that is deployment hardening, not application logic.

If a second operator is ever genuinely needed, the answer is a second credential — not a user-management subsystem.

---

## 18. Database layer rule (binding)

> **Every database operation passes through the repository layer.**

- No UI component, route, loader or server function executes SQL.
- No business logic bypasses a repository.
- Repositories expose typed, intention-revealing methods (`recordFrozenTrigger`, `completeWindow`, `appendOrderEvent`) — never a generic `query(sql)` escape hatch.
- The engine is the only writer; read-only surfaces use read methods.
- Schema changes ship as forward-only numbered migrations applied at boot.
- An architecture test fails the build if anything outside the repository directory imports the SQLite driver.

This keeps the SQLite decision reversible: a future PostgreSQL move is a change inside one directory.

---

## 19. Deployment

- **One PM2 app**, fork mode, **1 instance** (in-memory engine state cannot cluster), exponential backoff to 15s, `max_memory_restart`, `kill_timeout` long enough for graceful dispose, SIGINT/SIGTERM trapped.
- **One Nginx configuration**: reverse proxy to `127.0.0.1:<PORT>`, `proxy_buffering off` for SSE, WebSocket upgrade headers, a quiet health-check location, and the app port firewalled from the public interface.
- **One `.env.example`**.
- The **VPS is the production environment**. Lovable is the authoring environment; native modules such as `better-sqlite3` run on the VPS, not in the preview.

### 19.1 Environment rule

> **Only values that cannot be configured through the dashboard belong in `.env.example`. Every operational setting lives inside SPACE.**

These always live in `.env.example` and are **never** editable through the dashboard:

- Wallet Private Key
- Funder Address
- CLOB API Key
- CLOB Secret
- CLOB Passphrase
- RPC Endpoints
- Telegram Token
- Telegram Chat ID
- Session Secret

Plus the minimum runtime basics: `NODE_ENV`, `PORT`, `HOST`, `DB_PATH`, and the operator username and password hash. Nothing else.

Windows, buffers, sizes, quotas, retries, order types, market toggles, risk limits and mode all live in the database and are edited in the Operations Desk. One template, no environment-specific variants. Secrets are never rendered, logged, returned by an API, or included in a backup.

---

## 20. V1 and V2

|             | V1      | V2      |
| ----------- | ------- | ------- |
| Environment | Testnet | Mainnet |
| UI          | same    | same    |
| Engine      | same    | same    |
| Features    | same    | same    |
| Strategy    | same    | same    |
| Credentials | testnet | mainnet |

**Only the environment changes.** There is no V1 code path and no V2 code path, no `if (mainnet)` branch, no parallel module, no separate build. Promotion from V1 to V2 is a credential and endpoint change in `.env` plus a restart. Any change introducing an environment-conditional behavioural branch is rejected in review.

---

## 21. Testing philosophy

> **If a feature cannot be tested, it is not complete.**

| Layer                     | Scope                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                      | TWAP maths, buffer application, direction resolution, trigger construction, quota accounting, risk predicates                                                 |
| Integration               | repositories against a real SQLite file, migrations, configuration versioning, command bus                                                                    |
| Engine                    | full window lifecycle over a simulated clock and synthetic feed: trigger, no-trigger, quota exhaustion, risk rejection, limit timeout, disabled window/market |
| Replay                    | determinism — replaying an event log reproduces identical projections, digests and frozen triggers                                                            |
| Recovery                  | kill the process at each hazardous point; assert idempotent restore and zero duplicate orders                                                                 |
| End-to-end trading        | testnet: discovery → window → trigger → order → fill → settlement → statistics → replay                                                                       |
| VPS deployment validation | clean VPS: clone → install → `.env` → restore backup → `pm2 start` → health green                                                                             |

Determinism is a first-class test target: same inputs, same decisions, every run. Architecture tests (layering, no SQL outside repositories, no UI-owned logic) run in CI as ordinary tests.

---

## 22. Engineering principles

- Every commit leaves the repository buildable.
- Every phase preserves existing working behaviour.
- No unnecessary rewrites.
- No unnecessary abstractions.
- No cloud dependencies.
- No Supabase.
- No Cloudflare runtime assumptions.
- One repository.
- One Node.js application.
- One local database.
- One PM2 deployment.
- One Nginx configuration.
- One `.env.example`.
- The VPS is the production environment.
- Lovable is the authoring environment.
- Simple systems survive. Complex systems fail.
