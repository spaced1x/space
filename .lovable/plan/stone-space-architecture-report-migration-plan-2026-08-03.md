# STONE → SPACE: Architecture Report & Migration Plan

Revision 2 — incorporates the approved revisions. Nothing has been changed, deleted, or refactored. This is documentation planning only.

On approval, three documents are written and **no source file is touched**:

1. `docs/SPACE_SPECIFICATION.md` — the authoritative product specification and single source of truth.
2. `docs/SPACE_ARCHITECTURE.md` — module boundaries, ownership rules, runtime topology.
3. `docs/SPACE_MIGRATION_REPORT.md` — the STONE analysis and migration matrix below, with a per-file appendix.

Legacy STONE material is **moved to `docs/archive/`, never deleted**.

### Governing philosophy

> **Simple systems survive. Complex systems fail.**

When a decision is uncertain, choose the option that is simpler, easier to maintain, easier to deploy, easier to recover, easier to understand, and more reliable. Reliability outranks new features, always.

## 0. The single most important finding

The uploaded archive is **not one system, it is two**.

- **STONE (`src/`)** — "ARC Companion", a TanStack Start / React 19 / Supabase **control plane**. ~200 files. Its constitution (`docs/ARC_PROJECT_CHARTER.md`, ADR-0001) _forbids_ trading logic from ever existing in it.
- **P4 / "reze" (`docs/reference/p4/`)** — the **actual trading bot**. Next.js 14 + PM2 + `better-sqlite3` + Polymarket CLOB v2. ~28,000 LOC. Declared read-only reference, excluded from build, lint and tests.

Consequence: STONE contains a large, high-quality, fully-tested **domain library** for trading (`core/market`, `core/decision`, `core/trade`) that is **never wired into a running process**. The only file that assembles those three domains is `src/core/qualification/scenario.ts`, a deterministic test harness on a `FixedClock`. There is no live tick loop, no real venue client (`VenueGateway` has exactly one implementation: `RecordingVenueGateway`), and no real feed decoder (`chainlink-datastreams` is a config label pointing at a generic HTTP-JSON fetcher).

Meanwhile P4 _does_ trade, for real, with EIP-712 signing, post-only maker orders, chaos-tested paper mode, settlement, dust compounding and forensic replay — but it is architecturally frozen out of the repository.

**SPACE's value is exactly this: joining the two halves.** STONE's domain model plus P4's proven execution reality, in one Node process.

## 1. Repository overview

|           | STONE (`src/`)                      | P4 (`docs/reference/p4/`)                            |
| --------- | ----------------------------------- | ---------------------------------------------------- |
| Framework | TanStack Start v1, React 19, Vite 8 | Next.js 14 App Router                                |
| Runtime   | Cloudflare Workers (serverless)     | Long-lived Node, PM2 fork, 1 instance                |
| DB        | Supabase Postgres, 20 tables, RLS   | SQLite WAL: `trades`, `kv`, `order_log`, `audit_log` |
| Auth      | Supabase Auth + `user_roles` + RLS  | Dashboard user/pass + optional bearer token          |
| Trading   | none (charter-forbidden)            | full engine, SLO, live + paper executors             |
| Tests     | 31 files, 512 tests, core-only      | 39 files, chaos/integration heavy                    |
| Deploy    | Lovable / Workers                   | PM2 + Nginx reverse proxy                            |

## 2. Runtime architecture (STONE)

`src/core/runtime.ts` (104 LOC) is the composition root and wires **only** infrastructure: config, logger, metrics registry, health registry, scheduler, event-envelope factory. It imports nothing from `market/`, `decision/` or `trade/`. Two health checks are registered: configuration and scheduler. The only server-side runtime surface is `/api/public/health/*` and `/api/public/authority/*`.

Layering is enforced _executably_ by `tests/unit/architecture.test.ts`, which walks the import graph and fails the build on upward dependency: `shared → contracts → configuration → infrastructure → market → decision → trade → platform`. This is one of STONE's best assets and should survive into SPACE.

## 3. Trading engine architecture

**STONE domain model (~7,650 LOC, unwired):**

- `market/` — Discovery → Feed → TWAP → PTB → signal conditioning → versioned immutable `AuthoritativeMarketState`. TWAP is a correct time-weighted average with degenerate-basket fallback; PTB is validated _only_ from official market metadata, never from the order book.
- `decision/` — `decide()` is a **pure function** of (market state, window instance, config) → `BUY_UP | BUY_DOWN | NO_SIGNAL`, using a per-window `ABSOLUTE`/`PERCENT` buffer against PTB. `ExecutionWindowManager` drives a 6-state window FSM, one intent per window forever, plus a `TradeQuota`. Window priority is derived from offset, never configured separately.
- `trade/` — risk engine (7 ordered checks, all always evaluated for a full audit trace), `ExposureLedger` with a fail-fast invariant, an 8-state order FSM, and `standing-order-engine.ts` (523 LOC, explicitly _harvested from P4_): passive maker resting, bounded cancel/replace, retry ladder, partial-fill accumulation, IOC fallback on deadline, exactly-once settlement.

**This is already ~85% of the Frozen Window Engine you described.** Opening TWAP capture, PTB-derived direction, per-window buffer, continuous re-evaluation until expiry, risk gate, trades-per-market quota — all present, pure and unit-tested. What is missing: freezing the trigger _value_ at window open (today `decide()` recomputes the comparison from live effective TWAP on each evaluation rather than latching a trigger at capture), a real venue, a real feed, and a process to run in.

**P4 engine (what actually works):** a 1,697-LOC tick loop with `PRIORITY_1` / `PRIORITY_2` / `STOPPING` phases, slot rollover, `settleSlot()`, and a 2,859-LOC independent Standing Limit Order manager on its own clock.

## 4. Execution flow (STONE, end-to-end, exercised only by the harness)

`ingest(sample)` → feed ordering/freshness → TWAP → conditioning → PTB → lifecycle → publish versioned state → `onMarketState()` → per-window quota check → pure `decide()` → `attachIntent()` + quota consume → `TradeCoordinator.submit()` → risk verdict → exposure reserve → `adaptIntent()` → `StandingOrderEngine.open()` → venue submit → idempotent fills → exposure commit → terminal → `ExecutionReport` → `onSettlement` callback. That callback has no implementation; the traced flow ends there.

## 5. Replay system

Two independent replay systems exist.

- **STONE** `core/platform/replay.ts` — pure event-sourced replay over `platform_events`, validating 6 invariants (event ordering, market-state version, FSM transitions, correlation ids, quota progression, execution ids) and emitting a stable digest for determinism comparison. Runs persist to `replay_runs`. UI at `/replay` (131 LOC), raw JSON diff.
- **P4** `trade-replay.ts` (299 LOC) — forensic per-trade evidence bundle from SQLite: trade row, feed audit record (per-side quotes, sources, ages, latencies, WS/REST freshness), full order-log chain, audit lines, sibling trades, and a direction verdict derived strictly from stored evidence. Exposed at `/api/v2/bot/trades/[id]/replay` and `trade-replay-view.tsx`.

SPACE should keep **both**: event-sourced determinism replay for engineering, per-trade forensic replay for operations.

## 6. Database layer

- STONE: 20 Supabase tables. Genuinely good design — `platform_events` and `ledger_records` are append-only _at the grant level_ (no UPDATE/DELETE granted), `configuration_versions` is immutable by trigger, `operator_ownership` is a boolean-PK singleton, `authority_replay_guard` uses unique-violation-as-replay-signal, `authority_registry` rejects secret-shaped values by trigger. Idempotency relies on catching Postgres `23505`, which survives a move to plain Postgres unchanged.
- P4: 4 SQLite tables, an async write queue that never blocks the tick loop, additive migrations, and a boot-time orphan sweep that refunds crash-orphaned OPEN trades.

### Decision: SPACE uses SQLite in WAL mode

SPACE is not locked to PostgreSQL just because STONE used Supabase. Re-evaluating against the stated objectives:

| Objective                | SQLite (WAL)                                                         | PostgreSQL (local)                                                       |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| One local database       | A single file                                                        | A server, a daemon, a role, a socket                                     |
| No cloud dependency      | Yes                                                                  | Yes                                                                      |
| VPS deployment           | Nothing to install; the app _is_ the database                        | Install, tune, secure, upgrade across major versions                     |
| Backup                   | `VACUUM INTO backup.db` — one atomic file, hot, no downtime          | `pg_dump`, restore ordering, role/ownership fixes                        |
| Migration to another VPS | Copy one file                                                        | Dump, install matching major version, restore, re-grant                  |
| Reliability              | WAL + `synchronous=NORMAL` is crash-safe; fewer moving parts to fail | Robust, but adds a second supervised process that can fail independently |
| Concurrency              | One writer at a time; unlimited concurrent readers                   | Full MVCC, many writers                                                  |

SPACE is **a single Node process with exactly one writer** — the engine. There is no second service, no horizontal scale, no multi-tenant access. Trade volume is bounded by the market clock (a handful of orders per 5-minute slot, ~288 slots/day). SQLite's only real limitation, concurrent writers, does not exist in this design. PostgreSQL would add an entire supervised subsystem to solve a problem SPACE does not have — the exact complexity the philosophy above rejects.

P4 already proved this in production: `better-sqlite3`, WAL, `synchronous=NORMAL`, `busy_timeout=5000`, with an async write queue that never blocks the tick loop. That is a working, audited pattern to carry forward rather than re-derive.

**Recommendation: SQLite (WAL) via `better-sqlite3`, at a single `DB_PATH`, behind a typed repository layer.** The repository boundary keeps a future PostgreSQL swap a contained change, but SPACE ships on SQLite and no code outside the repository layer knows which engine is underneath. Note that `better-sqlite3` is a native module — it runs on the VPS, not in the Lovable preview, which is consistent with "Lovable is the authoring environment, the VPS is production."

## 7. Configuration system

Two competing environment systems coexist in STONE: a declarative catalog (`core/configuration/env-validator.ts`, used by the startup validator) and a Zod loader (`core/configuration/environment.ts`, used by `bootstrapConfig`). They overlap and disagree on key names (`EXECUTION_PROFILE_ID` vs `ARC_EXECUTION_PROFILE_ID`) and on what is required. Three `.env` templates exist in STONE, two more in P4. Execution profiles add a hand-rolled DSL (`15s@0.002|size=2|retry=1|timeout=10000`).

## 8-13. Deployment, PM2, build, environment

- STONE `ecosystem.config.cjs`: two apps — `arc-companion` (built Vite server) and `arc-engine` pointing at `dist/engine/index.js`, **a path that does not exist in this repository**. Engine pinned to 1 instance, `ENGINE_MODE=OBSERVE`.
- P4 `ecosystem.config.js`: one app, fork mode, 1 instance (in-memory state cannot cluster), exponential backoff to 15s, `max_memory_restart 512M`, `kill_timeout 8000` with SIGINT trapped for graceful dispose, automatic re-ignition from KV `engine:running`.
- P4 `deploy/nginx-edge5.conf`: proxy to 127.0.0.1:3000, `proxy_buffering off` for SSE, WS upgrade headers, quiet health-check location, `ufw deny 3000`.
- Build: STONE `vite build` → `.output/server/index.mjs`; P4 `next build` → `next start`.

## 14. UI/UX structure

18 authenticated routes behind a single `_authenticated` gate (auth-only; **roles are defined in the DB and checked in no route**). Shared `OperatorShell` plus a small primitives set (`Panel`, `Metric`, `StatusPill`, `SeverityBadge`, `Timeline`). Dark-only oklch token system, IBM Plex Sans with JetBrains Mono for all numerics. `/` is a hardcoded static "Session 0" checklist. `execution-profiles.tsx` is 1,291 LOC, nearly triple the next largest page. Seven routes (`markets`, `windows`, `signal-tank`, `trade-monitor`, `dashboard`, `health`, `qualification`) all re-slice the same `getOperationsSnapshot` payload through the same `RuntimeTelemetry` component. Zero UI test coverage.

## 15. Dependencies

STONE is lean: React 19, TanStack Router/Start/Query, Tailwind v4, 9 Radix primitives, `@supabase/supabase-js`, `zod`, `sonner`, `lucide-react`. No unused heavyweight dependencies. P4 adds `@polymarket/clob-client-v2`, `ethers` v6, `better-sqlite3`.

---

## Phases 3 and 4 — Classification and migration matrix

| STONE / P4 component                                                                          | Decision        | Reason                                                                    | SPACE replacement                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/shared` (ids, Clock)                                                                    | **KEEP**        | Branded ids and an injectable clock enable deterministic replay           | As-is; upgrade `digest128` (4×FNV-1a) to SHA-256 since digests gate event idempotency                                                                     |
| `core/contracts/event-envelope`                                                               | **KEEP**        | Correlation, causation and idempotency done right                         | As-is, with a durable Postgres sink                                                                                                                       |
| `core/contracts/reason-codes` (1,051 LOC)                                                     | **REFACTOR**    | ~20 domains catalogued, only a handful have producers                     | Prune to codes with real emitters                                                                                                                         |
| `core/contracts/versions`                                                                     | **REMOVE**      | All 24 entries pinned to `1.0.0`; compatibility machinery never invoked   | Single build version string                                                                                                                               |
| `core/market/*` (TWAP, PTB, conditioning, lifecycle)                                          | **KEEP**        | Correct, pure, tested; exactly SPACE's Opening-TWAP/PTB model             | As-is                                                                                                                                                     |
| `core/market/feed-provider`                                                                   | **REFACTOR**    | Vendor names with no vendor code behind them                              | Real Chainlink on-chain reader and CLOB WS client, ported from P4 `feeds/`                                                                                |
| `core/decision/*` (window FSM, pure `decide`, quota)                                          | **KEEP**        | The Frozen Window Engine's skeleton, already pure                         | Add trigger **latching** at window open; drop the unimplemented `SCHEDULED_TICK` mode                                                                     |
| `core/decision/execution-context` exposure placeholder                                        | **REMOVE**      | Inert duplicate of the real `ExposureLedger`                              | Trade-domain ledger only                                                                                                                                  |
| `core/trade/*` (risk, exposure, order FSM, coordinator)                                       | **KEEP**        | Fail-fast invariants, idempotent fills, exactly-once settlement           | As-is                                                                                                                                                     |
| `core/trade/standing-order-engine`                                                            | **KEEP**        | Already the decoupled port of P4's proven SLO                             | Extend with P4's stuck-RESTING and duplicate-order guards                                                                                                 |
| `core/trade/venue-gateway`                                                                    | **REFACTOR**    | Interface is right, implementation is a recording stub                    | Port P4 `execution/live.ts` (CLOB v2, EIP-712, post-only) and `paper.ts` chaos executor behind the same port                                              |
| `core/platform/replay` + `recovery`                                                           | **KEEP**        | Pure, digest-verified, PM2-restart dedupe                                 | As-is                                                                                                                                                     |
| `core/platform/ledger`                                                                        | **KEEP**        | Deterministic reconstruction from BUSINESS events                         | As-is                                                                                                                                                     |
| `core/platform/audit.ts`                                                                      | **REMOVE**      | Superseded by `audit-record.ts`; two shapes into one table                | Single audit writer                                                                                                                                       |
| `core/platform/notifications.ts`                                                              | **REFACTOR**    | Framework has no channel and is disconnected from the table actually used | One notification service plus P4's Telegram transport                                                                                                     |
| `core/platform/authority-*` (handshake, registration, signature, gateway)                     | **REMOVE**      | Exists solely to bridge the companion↔VPS split that SPACE deletes        | In-process module calls                                                                                                                                   |
| `core/qualification/{gates,live-gates,activation,mainnet,deployment}`                         | **REFACTOR**    | Four abstractions independently recompute the same evidence               | One readiness evaluator                                                                                                                                   |
| `core/qualification/scenario.ts`                                                              | **KEEP**        | The only place the engine is fully assembled — it is the integration test | Promote to SPACE's integration suite                                                                                                                      |
| `core/infrastructure/*` (fsm, health, logging, scheduler, metrics, watchdogs, secret-scanner) | **KEEP**        | Solid, generic, portable                                                  | Rename watchdog subsystem `"supabase"` → `"database"`; wire metrics to a real `/metrics` route                                                            |
| `core/configuration/env-validator` vs `environment`                                           | **REFACTOR**    | Two sources of truth with conflicting key names                           | One Zod schema, one `.env.example`                                                                                                                        |
| Execution-profile DSL parser                                                                  | **REFACTOR**    | Non-trivial parser hidden inside config loading                           | Structured profiles stored in the local DB, validated by Zod, edited in the Operations Desk                                                               |
| Supabase (client, RLS, Auth, PostgREST, `config.toml`, 12 migrations)                         | **REMOVE**      | SPACE has no cloud dependency                                             | Local SQLite (WAL) behind typed repositories; port the useful table designs, replace RLS with app-layer authz, replace Supabase Auth with a local session |
| `src/lib/*.functions.ts` and `*.server.ts` (~4,000 LOC)                                       | **REFACTOR**    | Correct read/write surface, but `any`-cast Supabase calls throughout      | Typed service layer over the local DB                                                                                                                     |
| STONE UI shell, primitives, tokens, 18 routes                                                 | **KEEP**        | Genuinely good operator UI: dark oklch, mono numerics                     | Keep the design system; merge the 7 telemetry re-slices; split `execution-profiles.tsx`                                                                   |
| `src/routes/index.tsx`                                                                        | **REMOVE**      | Hardcoded, stale "Session 0" checklist                                    | Login redirect                                                                                                                                            |
| `api/public/authority/*`                                                                      | **REMOVE**      | Cross-process protocol, obsolete in one process                           | —                                                                                                                                                         |
| `api/public/health/*`                                                                         | **KEEP**        | Nginx and PM2 probes need exactly these                                   | As-is                                                                                                                                                     |
| P4 `engine.ts` phase loop                                                                     | **REFACTOR**    | Per your direction, not copied                                            | Frozen Window Engine on STONE's window FSM                                                                                                                |
| P4 `settlement-*`, `accounting-verifier`, `bankroll`, dust compounding                        | **KEEP (port)** | Money-correctness logic earned through real production bugs               | `core/settlement` and `core/accounting`                                                                                                                   |
| P4 `reconciler`, `watchdog`, `orphan-cleaner`, `preflight`                                    | **KEEP (port)** | Live-drift detection has no STONE equivalent                              | SPACE infrastructure layer                                                                                                                                |
| P4 `trade-replay.ts` and `trade-replay-view.tsx`                                              | **KEEP (port)** | Forensic per-trade evidence, complements event replay                     | Second tab on the SPACE replay page                                                                                                                       |
| P4 `trade-replay.ts` evidence model                                                           | **KEEP (port)** | Already captures the exact fields SPACE's replay must show                | Extended with frozen trigger and buffer                                                                                                                   |
| P4 `http-agent`, `proxy`, `telegram-console`, dual `/v1` `/v2` dashboards                     | **REMOVE**      | Dead weight and duplication                                               | —                                                                                                                                                         |
| Both PM2 configs                                                                              | **REFACTOR**    | One is half-fictional, one is Next-specific                               | One `ecosystem.config.cjs`: one app, fork, 1 instance, graceful dispose                                                                                   |
| P4 nginx conf                                                                                 | **KEEP**        | Correct proxy, SSE, WS and quiet health handling                          | Adapt ports and paths                                                                                                                                     |
| Five `.env` templates                                                                         | **REMOVE**      | Five templates for one system                                             | One small `.env.example` (secrets and boot-time-only values)                                                                                              |
| `docs/knowledge/**` (P4 behavioural spec)                                                     | **KEEP**        | The most valuable document set in the archive                             | Moved to `docs/archive/knowledge/` as SPACE's behavioural reference                                                                                       |
| ~60 milestone / phase / audit reports in `docs/`                                              | **ARCHIVE**     | Historical value, no operational value                                    | Moved to `docs/archive/`, never deleted                                                                                                                   |
| P4 `db.ts` SQLite engine + write queue                                                        | **KEEP (port)** | Proven crash-safe pattern; matches the SPACE DB decision                  | `core/persistence` repository layer over `better-sqlite3`                                                                                                 |

## Phase 5 — Technical debt

1. Core trading domains built but never wired into a running process.
2. No real venue client anywhere in STONE, and no real feed decoder.
3. `freezeDeep` copy-pasted three times and `stableStringify` copy-pasted three times instead of living in `shared/`.
4. Two competing env systems with conflicting key names; five `.env` templates.
5. Two audit systems writing different shapes into one `audit_log`, plus a third path where SQL functions write audit rows directly.
6. Four independent "evidence to operator narrative" recomputations (`operator-incident`, `live-gates`, `activation`, `deployment`).
7. Two overlapping event logs (`event_log` vs `platform_events`) and two engine mirrors (`engine_snapshots` vs `engine_runtime_identity`).
8. `NotificationEngine` has no delivery channel and is disconnected from the `notifications` table actually used.
9. `MetricsRegistry` is a complete Prometheus exporter that nothing scrapes.
10. Pervasive `type AnyClient = any` casts defeat the generated Supabase types across the whole data layer.
11. `operations.functions.ts` is a 509-LOC god-file spanning health, config, notifications and audit.
12. `execution-profiles.tsx` at 1,291 LOC; seven routes re-slicing one snapshot.
13. Roles (`admin`, `operator`, `viewer`, `owner`) defined in schema, enforced nowhere in the UI.
14. `reason-codes.ts` is 1,051 LOC of largely producer-less codes; `versions.ts` is a no-op registry.
15. Dead config branch `triggerMode: SCHEDULED_TICK`; dead `POLICY` risk check.
16. Zero UI or component test coverage; test files duplicated by milestone name versus topic name.
17. The `arc-engine` PM2 entry points at a script that does not exist in the repository.
18. The structured-logging rule is violated by raw `console.error` in the Supabase integration files.
19. Two separate lists of "required tables" (SQL `arc_schema_report()` and TS `cutover.ts`) with no shared source.
20. `docs/` holds ~60 overlapping status reports, and `docs/reference/p4/` duplicates its own knowledge docs.

## Phase 6 — Risk analysis

- **Concurrency.** `ExecutionWindowManager.tick()` and `.onMarketState()` mutate shared window and quota state with no mutex. Safe today only because the sole caller is a single-threaded test harness. Under a real async runtime this is a live double-evaluation risk. SPACE must serialise the engine loop explicitly.
- **Idempotency.** Event dedupe keys are FNV-1a-derived, not cryptographic; a digest collision would silently drop a legitimate event.
- **Order fidelity.** `Order.forceState()` hand-encodes replay paths that must stay manually in sync with the FSM table, with nothing enforcing it.
- **Money.** `ExposureLedger.commit()` recomputes notional from fill price against a reservation seeded from intent size; per-record clamping hides rather than reconciles price-move divergence.
- **Single point of failure.** One PM2 instance by necessity (in-memory engine state). Restart safety rests entirely on recovery-from-events plus P4's KV auto-resume and orphan sweep — both must be ported, not reinvented.
- **Deployment.** Losing Supabase means losing Auth _and_ RLS simultaneously. Authorization must move into the app layer in the same change or SPACE ships with no access control.
- **Trading.** The live executor has never run inside STONE. The first SPACE milestone able to place a real order must be gated behind paper mode, P4's preflight and a kill switch.
- **Recovery.** STONE's `runtimeState` store silently falls back to in-memory while everything around it persists — state loss on every restart.

## Phase 7 — SPACE compatibility

**Already compatible:** layered core with executable enforcement; pure decision, risk, replay and recovery functions; injectable Clock; append-only event model; window FSM and quota; standing-order engine; health endpoints; operator UI shell and design system; the `docs/knowledge` behavioural spec.

**Needs refactor:** feed providers to real clients; venue gateway to a real CLOB adapter; data layer to local SQLite behind typed repositories; configuration to one schema and one template; qualification to one evaluator; UI to fewer, non-duplicated pages; engine loop to a serialised Frozen Window Engine.

**Must be removed:** Supabase in all forms; Cloudflare/Workers assumptions; the entire authority handshake, registration and signature protocol; the two-process PM2 split; the milestone document corpus; the static index page; duplicated env, audit, event and telemetry surfaces.

**Must be added:** a single Node process entrypoint that actually runs the engine; local SQLite schema, migrations and typed repositories; local auth and app-layer authorization; trigger latching at window open (the "frozen" in Frozen Window); 15-minute market support alongside the 5-minute default; Manual Trading mode; the Mission Control panel; the Operations Desk; Statistics; Backup and Restore; the Telegram operator interface; ported settlement, accounting, bankroll, reconciler, watchdog, orphan-cleaner and preflight; per-trade forensic replay; one PM2 config, one Nginx config, one `.env.example`.

---

# Part II — SPACE specification content to be documented

Everything below is the content that will be written into `docs/SPACE_SPECIFICATION.md` and `docs/SPACE_ARCHITECTURE.md`. It is presented here for approval before those files are created.

## A. Engine ownership (binding)

The **Trading Engine is the sole owner** of, and the only component permitted to mutate:

- timers and the scheduler tick
- market lifecycle (discovery, arm, active, rollover, resolve)
- execution windows and their FSM
- frozen triggers
- TWAP (opening capture and live settlement TWAP)
- PTB resolution
- trade quota
- risk evaluation
- order execution and the order FSM
- settlement and accounting

The dashboard **never owns trading logic**. It has exactly two rights:

1. **Read** — display state the engine publishes.
2. **Command** — send a named, validated, audited command to the in-process engine and await its verdict.

No page, component, loader, hook, or route may compute a price, a direction, a trigger, a position size, a PnL figure, or a risk verdict. If a number appears in the UI, the engine produced it. This is enforceable the same way STONE enforces layering today: an executable architecture test that fails the build if UI modules import engine internals rather than the command/query surface.

```text
  Dashboard ──command──▶ Engine Command Bus ──▶ Engine (sole owner of state)
  Dashboard ◀──state──── Engine Snapshot / Event Stream
```

## B. Manual Trading mode

A first-class mode, completely isolated from the automatic strategy.

- **Mutual exclusion.** Engine mode is one of `STRATEGY` or `MANUAL` (each still subject to `OBSERVE` / `ARMED`). Turning Manual Mode ON **disables automatic strategy execution**: windows stop producing intents, quota is untouched, no frozen triggers fire. Switching modes is a single audited engine command; the engine drains and closes any in-flight strategy session before the switch completes.
- **Live decision surface.** While in Manual Mode the dashboard shows, from the engine: live TWAP (opening and current settlement), PTB, the per-window buffer, and the **bot prediction** — the direction the strategy _would_ take right now, clearly labelled as advisory and never acted upon automatically.
- **Manual actions.** BUY UP / BUY DOWN, with **Limit** or **Market** order type, explicit size, and an optional limit-to-market fallback.
- **Same execution engine.** Manual orders travel the identical path: risk gate → exposure ledger → standing-order engine → venue gateway → settlement. Manual orders are tagged `origin: MANUAL` in the ledger, order log and replay, but receive no special treatment and no risk exemption.
- **Non-interference.** Manual sessions never consume strategy quota, never mutate window state, and never persist strategy configuration. Returning to Strategy Mode resumes from a clean window slate at the next market boundary.

## C. Operations Desk

The single configuration surface. Everything here is stored in the local database, versioned, audited, and applied by the engine — never read from `.env`.

**Per execution window** (15s, 10s, 7s, 5s, 3s, and any future offset):

- enable / disable the window independently
- buffer value and mode (absolute or percent)
- trade amount for that window

**Per market:**

- market enable / disable
- BTC 5m enable (default market)
- BTC 15m enable (optional, independent)
- trades per market (quota)
- max concurrent positions

**Execution settings:**

- order type: limit, market
- limit → market fallback (on/off, with deadline)
- retry settings: attempt budget, delay, cancel/replace ceiling

Changes are staged, validated by Zod, diffed against the running configuration, then activated by an explicit operator action. The engine confirms activation; the desk shows `PENDING → ACTIVE` and any drift. STONE's immutable configuration-version model carries over — it is one of the best things in the codebase.

## D. Mission Control (permanent left panel)

A permanent operator panel on every page, rendered from one engine snapshot subscription, showing:

| Group          | Items                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Engine         | Engine status · Observe / Armed · Manual Mode · Strategy Mode                                                          |
| Engine (cont.) | Current Engine Mode · Current Session (id, start time, uptime)                                                         |
| Markets        | Active Market (auto-discovered id/slug) · Market Countdown to settlement · Current Execution Window · BTC 5m · BTC 15m |
| Money          | Wallet balance · Today's PnL · Active trades                                                                           |
| Dependencies   | Binance status · Polymarket status · TWAP status · Database status · Telegram status                                   |

Each dependency renders as a health tone (healthy / degraded / unavailable) with last-seen age. It replaces STONE's `StatusBar` and absorbs the seven duplicated telemetry pages into one always-visible surface. This is the operator's primary status panel: every value comes from one engine snapshot subscription, so no two panels can disagree.

## E. Statistics

A dedicated section computed by the engine from the ledger and order log — never derived in the browser:

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

## F. Replay — every trade explained

Two surfaces, one page.

**Per-trade forensic replay** must display, for every trade:

- Opening TWAP (value and capture time)
- Frozen Trigger (the latched value, and the buffer that produced it)
- PTB (value and metadata source)
- Buffer (value and mode)
- Direction (UP / DOWN) and the evidence that produced it
- Trigger Time (when the live settlement TWAP crossed the frozen trigger)
- Execution Window (which offset, and its configuration at that moment)
- Risk decision (all checks, in order, with the verdict for each)
- Order lifecycle (submit, ack, reprice, cancel/replace, partial fills, terminal)
- Fill evidence (venue fill ids, prices, sizes, latencies, feed freshness at the time)
- Settlement result (WIN / LOSS / SCRATCH, payout, PnL, balance after)

Everything is read from stored evidence. Replay never recomputes from live data and never re-executes.

**Every completed window is explainable, including windows that never traded.** A window closes with exactly one terminal outcome code, persisted with its evidence:

| Outcome           | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `FILLED`          | trigger hit, risk passed, order filled, settled                               |
| `NO_TRIGGER`      | window expired without the live settlement TWAP reaching the frozen trigger   |
| `QUOTA_EXHAUSTED` | trades-per-market budget already consumed by earlier windows                  |
| `RISK_REJECTED`   | trigger hit, risk engine vetoed — with the failing check named                |
| `LIMIT_TIMEOUT`   | limit order not filled before deadline and fallback disabled or also unfilled |
| `MARKET_DISABLED` | the market was disabled in the Operations Desk                                |
| `WINDOW_DISABLED` | this execution window was disabled in the Operations Desk                     |

Skipped windows still record Opening TWAP, PTB, direction, buffer and frozen trigger, so a no-trade decision is as auditable as a trade.

**Event-sourced determinism replay** stays as STONE built it: reconstruct projections from the event log, verify the six invariants, compare digests, flag divergence.

## G. Backup and Restore

Objective: **clone repository → restore backup → run SPACE.**

- **Full backup** — one command producing a single timestamped archive containing: the hot SQLite snapshot (`VACUUM INTO`, no downtime, no torn WAL), the exported configuration (windows, profiles, risk limits, market toggles), and a manifest with schema version, app version and checksum.
- **Restore** — one command that verifies the manifest and checksum, refuses a schema-version mismatch it cannot migrate, restores the database file and re-imports configuration.
- **Database portability** — a single file; copying it _is_ the migration.
- **Configuration portability** — configuration is exportable as JSON independently of the database, so settings can move between environments without moving trade history.
- **VPS migration** — clone the repository, install, drop in `.env`, restore the archive, `pm2 start`. The engine resumes from persisted state using the ported auto-resume and orphan-sweep logic.
- Scheduled local backups with retention, plus a documented off-box copy step. Backups never contain secrets.

## H. Telegram as an operator interface

Telegram is a **control surface**, not just an alert channel. It is authenticated by chat id allow-list and routes through the same command bus and the same audit trail as the dashboard.

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

Write commands are confirmed, rate-limited and audited. Alerts (risk breach, kill switch, reconciler drift, feed staleness, settlement divergence) continue to push to the same chat.

## I. Environment rule

> **Only values that cannot be configured through the dashboard belong in `.env.example`. Every operational setting lives inside SPACE.**

These values **always** live in `.env.example` and are **never** editable through the dashboard:

- Wallet Private Key
- Funder Address
- CLOB API Key
- CLOB Secret
- CLOB Passphrase
- RPC Endpoints
- Telegram Token
- Telegram Chat ID
- Session Secret

Plus the minimum runtime basics: `NODE_ENV`, `PORT`, `HOST`, `DB_PATH`, and the operator password hash. Nothing else. Windows, buffers, sizes, quotas, retries, order types, market toggles, risk limits and mode all live in the database and are edited in the Operations Desk. One template, no environment-specific variants. Secrets are never rendered, logged, returned by an API, or included in a backup.

## J. Documentation policy

Nothing is deleted. `docs/archive/` receives the STONE charter, all ADRs, the ~60 milestone and audit reports, the qualification reports, and `docs/reference/p4/` including its knowledge docs. The active `docs/` root holds only the three SPACE documents plus operational runbooks.

## K. Implementation principles (binding)

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

## M. Frozen Window lifecycle (the core of SPACE)

This is product specification, not an implementation detail. The lifecycle is normative.

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

**The invariant:** once a window opens, its Frozen Trigger never changes. Not on a new TWAP tick, not on a PTB update, not on a configuration edit, not on a reconnect, not on a process restart. It is written once, at window open, and every later evaluation and every replay reads that stored value. This is the single most important behavioural difference from STONE, whose execution-window FSM re-evaluated against the moving TWAP and therefore had no frozen trigger at all.

Direction is decided once, from Opening TWAP vs PTB, and is stored with the trigger. Buffer is read once, at window open, from the active configuration version and stored with the trigger — a later Operations Desk edit cannot alter a window already open.

Enforcement: the window record's frozen fields are write-once at the repository layer, and a determinism test asserts that replaying a window's event log reproduces the identical trigger.

## N. Settlement TWAP

| Market        | Settlement TWAP      |
| ------------- | -------------------- |
| BTC 5 minute  | final 30-second TWAP |
| BTC 15 minute | final 60-second TWAP |

The engine continuously evaluates the live settlement TWAP against each open window's frozen trigger until that window expires. Opening TWAP (the capture that produces the trigger) and Settlement TWAP (the live comparand) are distinct, separately named values and are never conflated in code, storage, UI or replay. Feed staleness invalidates evaluation: a stale settlement TWAP blocks triggering rather than firing on old data.

## O. Active market discovery

SPACE automatically discovers and tracks the **official active BTC market** from Polymarket. There is no manual market selection anywhere in the product — no dropdown, no override, no URL parameter.

One resolver owns discovery and publishes a single `activeMarket` in the engine snapshot. The Dashboard, Trading Engine, Replay, Statistics and Manual Trading all read that same value, so every surface is always on the same market. On rollover the resolver advances to the next official market; the previous market's windows complete and settle on their own record. If discovery fails or is ambiguous, the engine degrades to OBSERVE and raises an alert rather than guessing.

## P. V1 and V2 — one implementation, two environments

|             | V1      | V2      |
| ----------- | ------- | ------- |
| Environment | Testnet | Mainnet |
| UI          | same    | same    |
| Engine      | same    | same    |
| Features    | same    | same    |
| Strategy    | same    | same    |
| Credentials | testnet | mainnet |

**Only the environment changes.** There is no V1 code path and no V2 code path, no `if (mainnet)` branch, no parallel module, no separate build. Promotion from V1 to V2 is a credential and endpoint change in `.env` plus a restart. Any pull request that introduces an environment-conditional behavioural branch is rejected by review.

## Q. Buffer specification

Every execution window owns its own buffer.

- decimal values allowed
- user editable in the Operations Desk
- a different value per window
- stored with the configuration version, not in `.env`
- **never changes while a market is active** — edits stage and take effect at the next market
- applied at window open, and copied into the window record with the frozen trigger

Example set: `15s = 6.5 · 10s = 5.0 · 7s = 3.5 · 5s = 2.0 · 3s = 1.0`.

## R. Trades per market — deterministic execution priority

Windows execute in a fixed, deterministic order: **furthest-from-settlement first**, i.e. 15s → 10s → 7s → 5s → 3s. Quota is consumed in that order and only by filled trades.

Worked example — configured windows 15s, 10s, 7s, 5s, 3s with `Trades Per Market = 3`:

```text
15s  ──▶ fill (1/3)
10s  ──▶ fill (2/3)
7s   ──▶ fill (3/3)
5s   ──▶ Window Completed · QUOTA_EXHAUSTED
3s   ──▶ Window Completed · QUOTA_EXHAUSTED
```

Quota is evaluated by the engine alone, on its single serialised loop, so two windows can never race the last slot. `Max positions` is a separate, additional gate. Disabled windows are skipped without consuming quota. The ordering is never influenced by arrival timing, latency or UI state — given the same configuration and the same triggers, the same windows fill every time.

## S. Order execution modes

| Mode               | Behaviour                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Limit Only**     | Submit a limit order only. Unfilled at the deadline → cancel → `LIMIT_TIMEOUT`.                                 |
| **Market Only**    | Submit a market order only.                                                                                     |
| **Limit → Market** | Submit limit first; if the configured timeout expires unfilled, cancel and automatically submit a market order. |

**Limit is the default mode.** The fallback timeout is configurable per the Operations Desk. Cancel-then-submit is sequenced so a partially filled limit reduces the fallback market size to the remainder — the engine can never end up long twice for one trigger. Mode and timeout are captured in the window record and shown in Replay.

## T. Bot Prediction (advisory only)

The Bot Prediction panel is completely isolated from trading. It is **visual only** and **advisory only**: it derives a would-be direction from the same TWAP calculations the engine uses, and displays it. It never creates a trade, never enqueues an intent, never affects strategy mode, and never affects manual mode. It is a read of engine state, not an input to it. Removing the panel would change nothing about execution.

## U. Startup sequence

```text
Boot → Validate Environment → Open Database → Load Configuration → Market Discovery
     → Connect Binance → Initialize TWAP → Connect Polymarket → Load Wallet
     → Initialize Telegram → Replay Recovery → Health Verification → OBSERVE → ARMED
```

| Stage                | Responsibility                                                                             | Failure behaviour                                               |
| -------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Validate Environment | Zod-parse `.env`; assert every required secret is present and well-formed                  | hard exit, non-zero — PM2 must not loop a misconfigured process |
| Open Database        | open SQLite at `DB_PATH`, apply WAL/pragmas, run pending migrations, verify schema version | hard exit                                                       |
| Load Configuration   | read the active configuration version into memory; validate windows, buffers, quotas       | hard exit if invalid; no implicit defaults                      |
| Market Discovery     | resolve the official active BTC market                                                     | stay in OBSERVE, alert, retry                                   |
| Connect Binance      | open the price feed, confirm first tick                                                    | stay in OBSERVE, retry with backoff                             |
| Initialize TWAP      | warm the TWAP buffers to full depth before any value is published                          | TWAP reports `WARMING`; no window may open                      |
| Connect Polymarket   | authenticate CLOB, load market/token metadata and PTB source                               | stay in OBSERVE, retry                                          |
| Load Wallet          | derive address, read balances and allowances                                               | stay in OBSERVE                                                 |
| Initialize Telegram  | bind bot, verify chat id, announce boot                                                    | non-fatal; degraded                                             |
| Replay Recovery      | reconcile persisted state with the venue (section W)                                       | must complete before ARMED                                      |
| Health Verification  | assert every dependency healthy and TWAP warm                                              | blocks ARMED                                                    |
| OBSERVE              | engine runs, evaluates, records — **places no orders**                                     | steady state                                                    |
| ARMED                | execution enabled, by explicit operator action or configured auto-arm                      | steady state                                                    |

SPACE never boots straight into ARMED after an unclean shutdown; the operator arms it, or auto-arm fires only after Health Verification passes clean.

## V. Shutdown sequence

```text
Stop accepting commands → Complete outstanding writes → Persist engine state
 → Flush logs → Close database → Dispose resources → PM2 Exit
```

On `SIGTERM`/`SIGINT` the engine closes the command bus (dashboard and Telegram commands are refused with a clear reason), stops opening new windows, drains the async write queue to completion, writes a shutdown checkpoint containing engine mode, active market, open windows and in-flight orders, flushes logs, closes SQLite cleanly (WAL checkpointed), disposes sockets and timers, and exits 0. A shutdown deadline is enforced; if the drain exceeds it, the engine still writes the checkpoint before exiting so recovery is never blind. Resting orders are **not** silently cancelled — they are recorded so recovery can reconcile them.

## W. Recovery

```text
VPS Restart → Engine Restart → Restore State → Restore Orders
 → Prevent Duplicate Orders → Resume Engine
```

- **Restore State** — load the last checkpoint plus persisted windows; rebuild in-memory state from the database, never from a live feed.
- **Restore Orders** — query the venue for open and recently filled orders and reconcile them against the local order log. Venue truth wins; local divergence is recorded and alerted.
- **Prevent duplicate orders** — every order carries a deterministic idempotency key derived from `(market, window, attempt)`. Resubmitting the same key is a no-op at the gateway, so a restart mid-submit can never double-fill. Orphaned local OPEN rows with no venue counterpart are closed and refunded, as P4 already does at boot.
- **Expired windows** — a window whose expiry passed while the process was down is completed with its stored outcome; it is never re-triggered.
- **Resume Engine** — resume in OBSERVE, run Health Verification, then arm.

Recovery is **deterministic and idempotent**: running it twice produces the same state as running it once, and it is covered by a dedicated recovery test suite that kills the process at each hazardous point.

## X. Local authentication

SPACE is a **single-operator application**. It is not a multi-user platform: no signup, no roles, no permissions matrix, no invitations, no password reset flow, no user table.

- One operator credential: a username and an Argon2id password hash in `.env`, plus `SESSION_SECRET`.
- Login issues a signed, httpOnly, SameSite=strict session cookie with an idle timeout; `secure` on when served over TLS.
- Every route except the login page and the health endpoint requires that session, enforced server-side in one place.
- Rate-limited login attempts, audited logins, and a documented rotation procedure (edit `.env`, restart).
- Nginx terminates TLS and may add an IP allow-list; that is deployment hardening, not application logic.

If a second operator is ever genuinely needed, the answer is a second credential — not a user-management subsystem.

## Y. Database layer rule (binding)

> **Every database operation passes through the repository layer.**

- No UI component, route, loader, or server function executes SQL.
- No business logic bypasses a repository.
- Repositories expose typed, intention-revealing methods (`recordFrozenTrigger`, `completeWindow`, `appendOrderEvent`) — never a generic `query(sql)` escape hatch.
- The engine is the only writer; read-only surfaces use read methods.
- Schema changes ship as forward-only numbered migrations applied at boot.
- An executable architecture test fails the build if anything outside `src/db/repositories/**` imports the SQLite driver.

This is what keeps the SQLite decision reversible: a future PostgreSQL move is a change inside one directory.

## Z. Testing philosophy

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

Determinism is a first-class test target: same inputs, same decisions, every run. The architecture tests (layering, no-SQL-outside-repositories, no UI-owns-logic) run in CI as ordinary tests.

## AA. Consistency review — contradictions found and resolved

A full re-read of the architecture surfaced these, all now resolved in the text above:

1. **Two TWAPs, one name.** Opening TWAP and Settlement TWAP were both "TWAP". Resolved: separate names, separate fields, separate storage, distinct Mission Control indicators (section N).
2. **Buffer edit vs frozen trigger.** The Operations Desk allows live buffer edits while section M forbids a trigger changing. Resolved: buffer is copied into the window at open; edits stage and apply at the next market (section Q).
3. **STONE's window FSM contradicts freezing.** STONE re-evaluates against a moving TWAP. Resolved: explicitly classified REFACTOR — trigger latching is added, not inherited (section M).
4. **Quota ordering was undefined.** Resolved: fixed furthest-first priority, engine-serialised, quota consumed only by fills (section R).
5. **Manual mode vs quota and windows.** Resolved: manual orders never consume strategy quota and never mutate window state (section B), and manual mode disables strategy entirely.
6. **Limit → Market double-fill risk.** Resolved: cancel-then-submit with remainder sizing and one idempotency key per attempt (sections S, W).
7. **Bot Prediction adjacency to execution.** Resolved: declared read-only, non-input, removable without behavioural change (section T).
8. **Mission Control values could diverge from engine truth.** Resolved: one snapshot subscription is the only source (section D); the UI computes nothing (section A).
9. **`.env` vs Operations Desk boundary was fuzzy.** Resolved: the closed secret list in section I; everything else in the database.
10. **Auto-arm after crash.** Resolved: ARMED only after Health Verification, never straight out of an unclean shutdown (section U).
11. **Backups and secrets.** Resolved: backups contain database and configuration only, never `.env` (sections G, I).
12. **Telegram as a second command path.** Resolved: Telegram routes through the same command bus, audit trail and rate limits as the dashboard (section H).
13. **Market discovery failure was unspecified.** Resolved: degrade to OBSERVE and alert; never guess a market (section O).
14. **V1/V2 drift.** Resolved: no environment-conditional behaviour; credentials only (section P).

No unresolved contradictions remain. The architecture is internally consistent and, in my assessment, stable enough to remain unchanged throughout implementation.

## L. `docs/SPACE_SPECIFICATION.md` — table of contents

1. Product vision
2. Architecture (single process, module boundaries, engine ownership)
3. Frozen Window Strategy — full lifecycle and the immutable trigger
4. TWAP Strategy — opening capture, settlement TWAP (30s / 60s), PTB, buffer
5. Active market discovery
6. Buffers, trades per market, execution priority
7. Order execution modes
8. Dashboard (Mission Control, pages, design system)
9. Operations Desk
10. Manual Trading and Bot Prediction
11. Replay — trades and skipped windows
12. Statistics
13. Startup and shutdown sequences
14. Recovery
15. Backup and Restore
16. Telegram operator interface
17. Local authentication
18. Database layer and repository rule
19. Deployment (PM2, Nginx, `.env.example`)
20. V1 — Testnet · V2 — Mainnet
21. Testing philosophy
22. Engineering principles

## Deliverables on approval

1. `docs/SPACE_SPECIFICATION.md` — authoritative product specification, per the table of contents above.
2. `docs/SPACE_ARCHITECTURE.md` — module boundaries, engine ownership, runtime topology, database decision, command bus contract.
3. `docs/SPACE_MIGRATION_REPORT.md` — Part I of this plan in full, plus a per-file classification appendix.
4. `docs/archive/` — legacy STONE and P4 material moved, not deleted.

No source file is touched. Implementation begins only after these documents are reviewed and approved.
