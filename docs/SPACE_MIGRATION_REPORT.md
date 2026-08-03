# STONE → SPACE — Architecture Report and Migration Matrix

Analysis of the STONE repository and the decisions carried into SPACE. Companion to `SPACE_SPECIFICATION.md` (what SPACE is) and `SPACE_ARCHITECTURE.md` (how it is built). Nothing in STONE was deleted to produce this report; legacy material is preserved under `docs/archive/`.

---

## 0. The single most important finding

The STONE archive is **not one system, it is two**.

- **STONE (`src/`)** — "ARC Companion", a TanStack Start / React 19 / Supabase **control plane**, ~200 files. Its charter (`ARC_PROJECT_CHARTER.md`, ADR-0001) _forbids_ trading logic from ever existing in it.
- **P4 / "reze" (`docs/reference/p4/`)** — the **actual trading bot**: Next.js 14 + PM2 + `better-sqlite3` + Polymarket CLOB v2, ~28,000 LOC, declared read-only reference and excluded from build, lint and tests.

Consequence: STONE contains a large, high-quality, fully-tested **domain library** for trading (`core/market`, `core/decision`, `core/trade`) that is **never wired into a running process**. The only file that assembles all three domains is `core/qualification/scenario.ts`, a deterministic harness on a `FixedClock`. There is no live tick loop, no real venue client (`VenueGateway` has one implementation: `RecordingVenueGateway`) and no real feed decoder.

Meanwhile P4 _does_ trade, with EIP-712 signing, post-only maker orders, chaos-tested paper mode, settlement, dust compounding and forensic replay — but is architecturally frozen out of the repository.

**SPACE's value is joining the two halves:** STONE's domain model plus P4's proven execution reality, in one Node process.

---

## 1. Repository overview

|           | STONE (`src/`)                      | P4 (`docs/reference/p4/`)                            |
| --------- | ----------------------------------- | ---------------------------------------------------- |
| Framework | TanStack Start v1, React 19, Vite 8 | Next.js 14 App Router                                |
| Runtime   | Cloudflare Workers (serverless)     | Long-lived Node, PM2 fork, 1 instance                |
| Database  | Supabase Postgres, 20 tables, RLS   | SQLite WAL: `trades`, `kv`, `order_log`, `audit_log` |
| Auth      | Supabase Auth + `user_roles` + RLS  | Dashboard user/pass + optional bearer token          |
| Trading   | none (charter-forbidden)            | full engine, SLO, live + paper executors             |
| Tests     | 31 files, 512 tests, core only      | 39 files, chaos/integration heavy                    |
| Deploy    | Lovable / Workers                   | PM2 + Nginx reverse proxy                            |

## 2. Runtime architecture (STONE)

`core/runtime.ts` (104 LOC) is the composition root and wires **only** infrastructure: config, logger, metrics registry, health registry, scheduler, event-envelope factory. It imports nothing from `market/`, `decision/` or `trade/`. Two health checks are registered. The only server-side runtime surface is `/api/public/health/*` and `/api/public/authority/*`.

Layering is enforced _executably_ by `tests/unit/architecture.test.ts`. This is one of STONE's best assets and survives into SPACE.

## 3. Trading engine architecture

**STONE domain model (~7,650 LOC, unwired):**

- `market/` — Discovery → Feed → TWAP → PTB → conditioning → versioned immutable `AuthoritativeMarketState`. TWAP is a correct time-weighted average with degenerate-basket fallback; PTB is validated only from official market metadata, never from the order book.
- `decision/` — `decide()` is a pure function of (market state, window instance, config) → `BUY_UP | BUY_DOWN | NO_SIGNAL`, using a per-window `ABSOLUTE`/`PERCENT` buffer against PTB. `ExecutionWindowManager` drives a six-state window FSM, one intent per window forever, plus a `TradeQuota`. Window priority derives from offset.
- `trade/` — risk engine (seven ordered checks, all always evaluated for a full audit trace), `ExposureLedger` with a fail-fast invariant, an eight-state order FSM, and `standing-order-engine.ts` (523 LOC, harvested from P4): passive maker resting, bounded cancel/replace, retry ladder, partial-fill accumulation, IOC fallback on deadline, exactly-once settlement.

This is roughly **85% of the Frozen Window Engine**. Missing: latching the trigger _value_ at window open (today `decide()` recomputes against live effective TWAP on every evaluation), a real venue, a real feed, and a process to run in.

**P4 engine:** a 1,697-LOC tick loop with `PRIORITY_1` / `PRIORITY_2` / `STOPPING` phases, slot rollover, `settleSlot()`, and a 2,859-LOC independent Standing Limit Order manager on its own clock. SPACE replaces the phase loop with the Frozen Window lifecycle and keeps the money-correctness code.

## 4. Execution flow (STONE, exercised only by the harness)

`ingest(sample)` → feed ordering/freshness → TWAP → conditioning → PTB → lifecycle → publish versioned state → `onMarketState()` → quota check → pure `decide()` → `attachIntent()` + quota consume → `TradeCoordinator.submit()` → risk verdict → exposure reserve → `adaptIntent()` → `StandingOrderEngine.open()` → venue submit → idempotent fills → exposure commit → terminal → `ExecutionReport` → `onSettlement`. That callback has no implementation; the traced flow ends there.

## 5. Replay system

Two independent systems exist, and SPACE keeps both:

- **STONE** `core/platform/replay.ts` — pure event-sourced replay over `platform_events`, validating six invariants and emitting a stable digest for determinism comparison.
- **P4** `trade-replay.ts` (299 LOC) — forensic per-trade evidence from SQLite: trade row, feed audit record (per-side quotes, sources, ages, latencies, WS/REST freshness), full order-log chain, audit lines, sibling trades, and a direction verdict derived strictly from stored evidence.

## 6. Database layer

- STONE: 20 Supabase tables, genuinely good design — `platform_events` and `ledger_records` append-only at the grant level, `configuration_versions` immutable by trigger, `operator_ownership` a boolean-PK singleton, `authority_replay_guard` using unique-violation-as-replay-signal, `authority_registry` rejecting secret-shaped values by trigger.
- P4: four SQLite tables, an async write queue that never blocks the tick loop, additive migrations, and a boot-time orphan sweep that refunds crash-orphaned OPEN trades.

### Decision: SPACE uses SQLite in WAL mode

SPACE is not locked to PostgreSQL just because STONE used Supabase.

| Objective                | SQLite (WAL)                                                 | PostgreSQL (local)                                    |
| ------------------------ | ------------------------------------------------------------ | ----------------------------------------------------- |
| One local database       | a single file                                                | a server, a daemon, a role, a socket                  |
| No cloud dependency      | yes                                                          | yes                                                   |
| VPS deployment           | nothing to install; the app _is_ the database                | install, tune, secure, upgrade across majors          |
| Backup                   | `VACUUM INTO` — one atomic file, hot, no downtime            | `pg_dump`, restore ordering, ownership fixes          |
| Migration to another VPS | copy one file                                                | dump, match major version, restore, re-grant          |
| Reliability              | WAL + `synchronous=NORMAL` is crash-safe; fewer moving parts | robust, but a second supervised process that can fail |
| Concurrency              | one writer, unlimited readers                                | full MVCC, many writers                               |

SPACE is a single process with exactly one writer — the engine. Trade volume is bounded by the market clock. SQLite's only real limitation does not exist in this design; PostgreSQL would add an entire subsystem to solve a problem SPACE does not have. P4 already proved the pattern in production.

**Decision: SQLite (WAL) via `better-sqlite3`, one `DB_PATH`, behind a typed repository layer** — which keeps a future PostgreSQL swap contained to one directory.

## 7. Configuration system

Two competing environment systems coexist in STONE: a declarative catalog (`env-validator.ts`) and a Zod loader (`environment.ts`). They overlap and disagree on key names (`EXECUTION_PROFILE_ID` vs `ARC_EXECUTION_PROFILE_ID`) and on what is required. Three `.env` templates exist in STONE, two more in P4. Execution profiles add a hand-rolled DSL (`15s@0.002|size=2|retry=1|timeout=10000`). SPACE collapses all of this to one Zod schema, one `.env.example`, and structured profiles in the database.

## 8–13. Deployment, PM2, build, environment

- STONE `ecosystem.config.cjs`: two apps — `arc-companion` and `arc-engine` pointing at `dist/engine/index.js`, **a path that does not exist in the repository**.
- P4 `ecosystem.config.js`: one app, fork mode, 1 instance, exponential backoff to 15s, `max_memory_restart 512M`, `kill_timeout 8000` with SIGINT trapped for graceful dispose, automatic re-ignition from KV `engine:running`.
- P4 `deploy/nginx-edge5.conf`: proxy to `127.0.0.1:3000`, `proxy_buffering off` for SSE, WS upgrade headers, quiet health-check location, `ufw deny 3000`.

SPACE ships one PM2 app and one Nginx config, modelled on P4's.

## 14. UI/UX structure

18 authenticated routes behind a single `_authenticated` gate (auth only; roles are defined in the database and checked in no route). Shared `OperatorShell` plus a small primitives set. Dark-only oklch tokens, IBM Plex Sans with JetBrains Mono for numerics. `/` is a hardcoded static "Session 0" checklist. `execution-profiles.tsx` is 1,291 LOC. Seven routes re-slice the same `getOperationsSnapshot` payload. Zero UI test coverage.

## 15. Dependencies

STONE is lean: React 19, TanStack Router/Start/Query, Tailwind v4, nine Radix primitives, `@supabase/supabase-js`, `zod`, `sonner`, `lucide-react`. P4 adds `@polymarket/clob-client-v2`, `ethers` v6, `better-sqlite3`.

---

## Classification and migration matrix

| STONE / P4 component                                                      | Decision        | Reason                                                           | SPACE replacement                                                                                                |
| ------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `core/shared` (ids, Clock)                                                | **KEEP**        | Branded ids and an injectable clock enable deterministic replay  | As-is; upgrade `digest128` (4×FNV-1a) to SHA-256 since digests gate event idempotency                            |
| `core/contracts/event-envelope`                                           | **KEEP**        | Correlation, causation and idempotency done right                | As-is, with a durable local sink                                                                                 |
| `core/contracts/reason-codes` (1,051 LOC)                                 | **REFACTOR**    | ~20 domains catalogued, few have producers                       | Prune to codes with real emitters; add the window-outcome codes                                                  |
| `core/contracts/versions`                                                 | **REMOVE**      | All 24 entries pinned to `1.0.0`; machinery never invoked        | Single build version string                                                                                      |
| `core/market/*` (TWAP, PTB, conditioning, lifecycle)                      | **KEEP**        | Correct, pure, tested; exactly SPACE's Opening-TWAP/PTB model    | As-is, plus an explicit Settlement TWAP (30s / 60s)                                                              |
| `core/market/feed-provider`                                               | **REFACTOR**    | Vendor names with no vendor code behind them                     | Real Binance client and CLOB WS client, ported from P4 `feeds/`                                                  |
| `core/decision/*` (window FSM, pure `decide`, quota)                      | **KEEP**        | The Frozen Window Engine's skeleton, already pure                | Add **trigger latching** at window open; drop the unimplemented `SCHEDULED_TICK` mode                            |
| `core/decision/execution-context` exposure placeholder                    | **REMOVE**      | Inert duplicate of the real `ExposureLedger`                     | Trade-domain ledger only                                                                                         |
| `core/trade/*` (risk, exposure, order FSM, coordinator)                   | **KEEP**        | Fail-fast invariants, idempotent fills, exactly-once settlement  | As-is                                                                                                            |
| `core/trade/standing-order-engine`                                        | **KEEP**        | Already the decoupled port of P4's proven SLO                    | Extend with P4's stuck-RESTING and duplicate-order guards                                                        |
| `core/trade/venue-gateway`                                                | **REFACTOR**    | Interface is right, implementation is a recording stub           | Port P4 `execution/live.ts` (CLOB v2, EIP-712, post-only) and `paper.ts` chaos executor behind the same port     |
| `core/platform/replay` + `recovery`                                       | **KEEP**        | Pure, digest-verified, PM2-restart dedupe                        | As-is                                                                                                            |
| `core/platform/ledger`                                                    | **KEEP**        | Deterministic reconstruction from BUSINESS events                | As-is                                                                                                            |
| `core/platform/audit.ts`                                                  | **REMOVE**      | Superseded by `audit-record.ts`; two shapes into one table       | Single audit writer                                                                                              |
| `core/platform/notifications.ts`                                          | **REFACTOR**    | Framework has no channel and is disconnected from the table used | One notification service plus P4's Telegram transport                                                            |
| `core/platform/authority-*`                                               | **REMOVE**      | Exists solely to bridge the companion↔VPS split SPACE deletes    | In-process module calls                                                                                          |
| `core/qualification/{gates,live-gates,activation,mainnet,deployment}`     | **REFACTOR**    | Four abstractions independently recompute the same evidence      | One readiness evaluator                                                                                          |
| `core/qualification/scenario.ts`                                          | **KEEP**        | The only place the engine is fully assembled                     | Promote to SPACE's integration suite                                                                             |
| `core/infrastructure/*`                                                   | **KEEP**        | Solid, generic, portable                                         | Rename watchdog subsystem `"supabase"` → `"database"`; wire metrics to a real `/metrics` route                   |
| `env-validator` vs `environment`                                          | **REFACTOR**    | Two sources of truth with conflicting key names                  | One Zod schema, one `.env.example`                                                                               |
| Execution-profile DSL parser                                              | **REFACTOR**    | Non-trivial parser hidden inside config loading                  | Structured profiles in the local DB, Zod-validated, edited in the Operations Desk                                |
| Supabase (client, RLS, Auth, PostgREST, 12 migrations)                    | **REMOVE**      | SPACE has no cloud dependency                                    | Local SQLite (WAL) behind repositories; app-layer authz; local session auth                                      |
| `src/lib/*.functions.ts` / `*.server.ts` (~4,000 LOC)                     | **REFACTOR**    | Correct surface, but `any`-cast Supabase calls throughout        | Typed service layer over the local DB                                                                            |
| STONE UI shell, primitives, tokens, 18 routes                             | **KEEP**        | Genuinely good operator UI                                       | Keep the design system; merge the seven telemetry re-slices into Mission Control; split `execution-profiles.tsx` |
| `src/routes/index.tsx`                                                    | **REMOVE**      | Hardcoded, stale "Session 0" checklist                           | Login redirect                                                                                                   |
| `api/public/authority/*`                                                  | **REMOVE**      | Cross-process protocol, obsolete in one process                  | —                                                                                                                |
| `api/public/health/*`                                                     | **KEEP**        | Nginx and PM2 probes need exactly these                          | As-is                                                                                                            |
| P4 `engine.ts` phase loop                                                 | **REFACTOR**    | Superseded by the Frozen Window lifecycle                        | Frozen Window Engine on STONE's window FSM                                                                       |
| P4 `settlement-*`, `accounting-verifier`, `bankroll`, dust compounding    | **KEEP (port)** | Money-correctness logic earned through real production bugs      | `core/settlement`, `core/accounting`                                                                             |
| P4 `reconciler`, `watchdog`, `orphan-cleaner`, `preflight`                | **KEEP (port)** | Live-drift detection has no STONE equivalent                     | SPACE infrastructure layer                                                                                       |
| P4 `trade-replay.ts` evidence model and view                              | **KEEP (port)** | Already captures the fields SPACE's replay must show             | Extended with frozen trigger, buffer and window outcome                                                          |
| P4 `http-agent`, `proxy`, `telegram-console`, dual `/v1` `/v2` dashboards | **REMOVE**      | Dead weight and duplication                                      | —                                                                                                                |
| Both PM2 configs                                                          | **REFACTOR**    | One is half-fictional, one is Next-specific                      | One `ecosystem.config.cjs`: one app, fork, 1 instance, graceful dispose                                          |
| P4 nginx conf                                                             | **KEEP**        | Correct proxy, SSE, WS and quiet health handling                 | Adapt ports and paths                                                                                            |
| Five `.env` templates                                                     | **REMOVE**      | Five templates for one system                                    | One small `.env.example`                                                                                         |
| `docs/knowledge/**` (P4 behavioural spec)                                 | **KEEP**        | The most valuable document set in the archive                    | `docs/archive/knowledge/`, SPACE's behavioural reference                                                         |
| ~60 milestone / phase / audit reports                                     | **ARCHIVE**     | Historical value, no operational value                           | `docs/archive/`, never deleted                                                                                   |
| P4 `db.ts` SQLite engine + write queue                                    | **KEEP (port)** | Proven crash-safe pattern; matches the DB decision               | Repository layer over `better-sqlite3`                                                                           |

---

## Technical debt inventory

1. Core trading domains built but never wired into a running process.
2. No real venue client and no real feed decoder anywhere in STONE.
3. `freezeDeep` and `stableStringify` each copy-pasted three times instead of living in `shared/`.
4. Two competing env systems with conflicting key names; five `.env` templates.
5. Two audit systems writing different shapes into one `audit_log`, plus a third path where SQL functions write audit rows directly.
6. Four independent "evidence to operator narrative" recomputations.
7. Two overlapping event logs (`event_log` vs `platform_events`) and two engine mirrors.
8. `NotificationEngine` has no delivery channel and is disconnected from the table actually used.
9. `MetricsRegistry` is a complete Prometheus exporter that nothing scrapes.
10. Pervasive `type AnyClient = any` casts defeat the generated database types.
11. `operations.functions.ts` is a 509-LOC god-file spanning health, config, notifications and audit.
12. `execution-profiles.tsx` at 1,291 LOC; seven routes re-slicing one snapshot.
13. Roles defined in schema, enforced nowhere in the UI.
14. `reason-codes.ts` is 1,051 LOC of largely producer-less codes; `versions.ts` is a no-op registry.
15. Dead config branch `triggerMode: SCHEDULED_TICK`; dead `POLICY` risk check.
16. Zero UI or component test coverage; test files duplicated by milestone name versus topic name.
17. The `arc-engine` PM2 entry points at a script that does not exist.
18. The structured-logging rule is violated by raw `console.error` in the integration files.
19. Two separate lists of "required tables" with no shared source.
20. ~60 overlapping status reports in `docs/`, and `docs/reference/p4/` duplicates its own knowledge docs.

---

## Risk analysis

- **Concurrency.** `ExecutionWindowManager.tick()` and `.onMarketState()` mutate shared window and quota state with no mutex — safe only under the single-threaded harness. SPACE serialises the engine loop explicitly.
- **Idempotency.** Event dedupe keys are FNV-1a-derived, not cryptographic; a collision would silently drop a legitimate event. SPACE uses SHA-256.
- **Order fidelity.** `Order.forceState()` hand-encodes replay paths that must stay manually in sync with the FSM table.
- **Money.** `ExposureLedger.commit()` recomputes notional from fill price against a reservation seeded from intent size; per-record clamping hides rather than reconciles price-move divergence.
- **Single point of failure.** One PM2 instance by necessity. Restart safety rests entirely on recovery-from-events plus P4's auto-resume and orphan sweep — both ported, not reinvented.
- **Deployment.** Losing Supabase means losing Auth _and_ RLS simultaneously; authorization must move into the app layer in the same change.
- **Trading.** The live executor has never run inside STONE. The first SPACE milestone able to place a real order is gated behind paper mode, preflight and a kill switch.
- **Recovery.** STONE's `runtimeState` store silently falls back to in-memory while everything around it persists — state loss on every restart.

---

## SPACE compatibility

**Already compatible:** layered core with executable enforcement; pure decision, risk, replay and recovery functions; injectable `Clock`; append-only event model; window FSM and quota; standing-order engine; health endpoints; the operator design system.

**Needs refactor:** feed providers to real clients; venue gateway to a real CLOB adapter; data layer to local SQLite behind typed repositories; configuration to one schema and one template; qualification to one evaluator; UI to fewer, non-duplicated pages; engine loop to a serialised Frozen Window Engine.

**Must be removed:** Supabase in all its forms; the authority handshake subsystem; the version registry; duplicate audit and notification paths; the placeholder index route; P4's proxy, http-agent and dual dashboards; four of the five `.env` templates.

**Must be added:** a single Node entrypoint that actually runs the engine; local SQLite schema, migrations and typed repositories; local auth; **trigger latching at window open**; 15-minute market support; Manual Trading; Mission Control; the Operations Desk; Statistics; Backup and Restore; the Telegram operator interface; ported settlement, accounting, bankroll, reconciler, watchdog, orphan-cleaner and preflight; per-trade forensic replay; one PM2 config, one Nginx config, one `.env.example`.

---

## Consistency review — contradictions found and resolved

1. **Two TWAPs, one name.** Resolved: Opening TWAP and Settlement TWAP separately named, stored and displayed (spec §4).
2. **Buffer edits vs the frozen trigger.** Resolved: buffer is copied into the window at open; edits stage and apply at the next market (spec §4.4).
3. **STONE's window FSM contradicts freezing.** Resolved: classified REFACTOR — trigger latching is added, not inherited (spec §3).
4. **Quota ordering was undefined.** Resolved: fixed furthest-first priority, engine-serialised, quota consumed only by fills (spec §6).
5. **Manual mode vs quota and windows.** Resolved: manual orders never consume strategy quota nor mutate window state (spec §10.1).
6. **Limit → Market double-fill risk.** Resolved: cancel-then-submit with remainder sizing and one idempotency key per attempt (spec §7, §14).
7. **Bot Prediction adjacency to execution.** Resolved: read-only, non-input, removable without behavioural change (spec §10.2).
8. **Mission Control could diverge from engine truth.** Resolved: one snapshot subscription is the only source (spec §8.1, §2.1).
9. **`.env` vs Operations Desk boundary was fuzzy.** Resolved: closed secret list (spec §19.1); everything else in the database.
10. **Auto-arm after crash.** Resolved: ARMED only after Health Verification (spec §13.1).
11. **Backups and secrets.** Resolved: backups contain database and configuration only (spec §15).
12. **Telegram as a second command path.** Resolved: same command bus, audit trail and rate limits (spec §16).
13. **Market discovery failure was unspecified.** Resolved: degrade to OBSERVE and alert; never guess (spec §5).
14. **V1/V2 drift.** Resolved: no environment-conditional behaviour; credentials only (spec §20).

No unresolved contradictions remain.
