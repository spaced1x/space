# STONE → SPACE: Architecture Report & Migration Plan

Nothing has been changed, deleted, or refactored. This is analysis only. On approval, the full report is written to `docs/SPACE_MIGRATION_REPORT.md` before any implementation begins.

## 0. The single most important finding

The uploaded archive is **not one system, it is two**.

- **STONE (`src/`)** — "ARC Companion", a TanStack Start / React 19 / Supabase **control plane**. ~200 files. Its constitution (`docs/ARC_PROJECT_CHARTER.md`, ADR-0001) *forbids* trading logic from ever existing in it.
- **P4 / "reze" (`docs/reference/p4/`)** — the **actual trading bot**. Next.js 14 + PM2 + `better-sqlite3` + Polymarket CLOB v2. ~28,000 LOC. Declared read-only reference, excluded from build, lint and tests.

Consequence: STONE contains a large, high-quality, fully-tested **domain library** for trading (`core/market`, `core/decision`, `core/trade`) that is **never wired into a running process**. The only file that assembles those three domains is `src/core/qualification/scenario.ts`, a deterministic test harness on a `FixedClock`. There is no live tick loop, no real venue client (`VenueGateway` has exactly one implementation: `RecordingVenueGateway`), and no real feed decoder (`chainlink-datastreams` is a config label pointing at a generic HTTP-JSON fetcher).

Meanwhile P4 *does* trade, for real, with EIP-712 signing, post-only maker orders, chaos-tested paper mode, settlement, dust compounding and forensic replay — but it is architecturally frozen out of the repository.

**SPACE's value is exactly this: joining the two halves.** STONE's domain model plus P4's proven execution reality, in one Node process.

## 1. Repository overview

| | STONE (`src/`) | P4 (`docs/reference/p4/`) |
|---|---|---|
| Framework | TanStack Start v1, React 19, Vite 8 | Next.js 14 App Router |
| Runtime | Cloudflare Workers (serverless) | Long-lived Node, PM2 fork, 1 instance |
| DB | Supabase Postgres, 20 tables, RLS | SQLite WAL: `trades`, `kv`, `order_log`, `audit_log` |
| Auth | Supabase Auth + `user_roles` + RLS | Dashboard user/pass + optional bearer token |
| Trading | none (charter-forbidden) | full engine, SLO, live + paper executors |
| Tests | 31 files, 512 tests, core-only | 39 files, chaos/integration heavy |
| Deploy | Lovable / Workers | PM2 + Nginx reverse proxy |

## 2. Runtime architecture (STONE)

`src/core/runtime.ts` (104 LOC) is the composition root and wires **only** infrastructure: config, logger, metrics registry, health registry, scheduler, event-envelope factory. It imports nothing from `market/`, `decision/` or `trade/`. Two health checks are registered: configuration and scheduler. The only server-side runtime surface is `/api/public/health/*` and `/api/public/authority/*`.

Layering is enforced *executably* by `tests/unit/architecture.test.ts`, which walks the import graph and fails the build on upward dependency: `shared → contracts → configuration → infrastructure → market → decision → trade → platform`. This is one of STONE's best assets and should survive into SPACE.

## 3. Trading engine architecture

**STONE domain model (~7,650 LOC, unwired):**

- `market/` — Discovery → Feed → TWAP → PTB → signal conditioning → versioned immutable `AuthoritativeMarketState`. TWAP is a correct time-weighted average with degenerate-basket fallback; PTB is validated *only* from official market metadata, never from the order book.
- `decision/` — `decide()` is a **pure function** of (market state, window instance, config) → `BUY_UP | BUY_DOWN | NO_SIGNAL`, using a per-window `ABSOLUTE`/`PERCENT` buffer against PTB. `ExecutionWindowManager` drives a 6-state window FSM, one intent per window forever, plus a `TradeQuota`. Window priority is derived from offset, never configured separately.
- `trade/` — risk engine (7 ordered checks, all always evaluated for a full audit trace), `ExposureLedger` with a fail-fast invariant, an 8-state order FSM, and `standing-order-engine.ts` (523 LOC, explicitly *harvested from P4*): passive maker resting, bounded cancel/replace, retry ladder, partial-fill accumulation, IOC fallback on deadline, exactly-once settlement.

**This is already ~85% of the Frozen Window Engine you described.** Opening TWAP capture, PTB-derived direction, per-window buffer, continuous re-evaluation until expiry, risk gate, trades-per-market quota — all present, pure and unit-tested. What is missing: freezing the trigger *value* at window open (today `decide()` recomputes the comparison from live effective TWAP on each evaluation rather than latching a trigger at capture), a real venue, a real feed, and a process to run in.

**P4 engine (what actually works):** a 1,697-LOC tick loop with `PRIORITY_1` / `PRIORITY_2` / `STOPPING` phases, slot rollover, `settleSlot()`, and a 2,859-LOC independent Standing Limit Order manager on its own clock.

## 4. Execution flow (STONE, end-to-end, exercised only by the harness)

`ingest(sample)` → feed ordering/freshness → TWAP → conditioning → PTB → lifecycle → publish versioned state → `onMarketState()` → per-window quota check → pure `decide()` → `attachIntent()` + quota consume → `TradeCoordinator.submit()` → risk verdict → exposure reserve → `adaptIntent()` → `StandingOrderEngine.open()` → venue submit → idempotent fills → exposure commit → terminal → `ExecutionReport` → `onSettlement` callback. That callback has no implementation; the traced flow ends there.

## 5. Replay system

Two independent replay systems exist.

- **STONE** `core/platform/replay.ts` — pure event-sourced replay over `platform_events`, validating 6 invariants (event ordering, market-state version, FSM transitions, correlation ids, quota progression, execution ids) and emitting a stable digest for determinism comparison. Runs persist to `replay_runs`. UI at `/replay` (131 LOC), raw JSON diff.
- **P4** `trade-replay.ts` (299 LOC) — forensic per-trade evidence bundle from SQLite: trade row, feed audit record (per-side quotes, sources, ages, latencies, WS/REST freshness), full order-log chain, audit lines, sibling trades, and a direction verdict derived strictly from stored evidence. Exposed at `/api/v2/bot/trades/[id]/replay` and `trade-replay-view.tsx`.

SPACE should keep **both**: event-sourced determinism replay for engineering, per-trade forensic replay for operations.

## 6. Database layer

- STONE: 20 Supabase tables. Genuinely good design — `platform_events` and `ledger_records` are append-only *at the grant level* (no UPDATE/DELETE granted), `configuration_versions` is immutable by trigger, `operator_ownership` is a boolean-PK singleton, `authority_replay_guard` uses unique-violation-as-replay-signal, `authority_registry` rejects secret-shaped values by trigger. Idempotency relies on catching Postgres `23505`, which survives a move to plain Postgres unchanged.
- P4: 4 SQLite tables, an async write queue that never blocks the tick loop, additive migrations, and a boot-time orphan sweep that refunds crash-orphaned OPEN trades.

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

| STONE / P4 component | Decision | Reason | SPACE replacement |
|---|---|---|---|
| `core/shared` (ids, Clock) | **KEEP** | Branded ids and an injectable clock enable deterministic replay | As-is; upgrade `digest128` (4×FNV-1a) to SHA-256 since digests gate event idempotency |
| `core/contracts/event-envelope` | **KEEP** | Correlation, causation and idempotency done right | As-is, with a durable Postgres sink |
| `core/contracts/reason-codes` (1,051 LOC) | **REFACTOR** | ~20 domains catalogued, only a handful have producers | Prune to codes with real emitters |
| `core/contracts/versions` | **REMOVE** | All 24 entries pinned to `1.0.0`; compatibility machinery never invoked | Single build version string |
| `core/market/*` (TWAP, PTB, conditioning, lifecycle) | **KEEP** | Correct, pure, tested; exactly SPACE's Opening-TWAP/PTB model | As-is |
| `core/market/feed-provider` | **REFACTOR** | Vendor names with no vendor code behind them | Real Chainlink on-chain reader and CLOB WS client, ported from P4 `feeds/` |
| `core/decision/*` (window FSM, pure `decide`, quota) | **KEEP** | The Frozen Window Engine's skeleton, already pure | Add trigger **latching** at window open; drop the unimplemented `SCHEDULED_TICK` mode |
| `core/decision/execution-context` exposure placeholder | **REMOVE** | Inert duplicate of the real `ExposureLedger` | Trade-domain ledger only |
| `core/trade/*` (risk, exposure, order FSM, coordinator) | **KEEP** | Fail-fast invariants, idempotent fills, exactly-once settlement | As-is |
| `core/trade/standing-order-engine` | **KEEP** | Already the decoupled port of P4's proven SLO | Extend with P4's stuck-RESTING and duplicate-order guards |
| `core/trade/venue-gateway` | **REFACTOR** | Interface is right, implementation is a recording stub | Port P4 `execution/live.ts` (CLOB v2, EIP-712, post-only) and `paper.ts` chaos executor behind the same port |
| `core/platform/replay` + `recovery` | **KEEP** | Pure, digest-verified, PM2-restart dedupe | As-is |
| `core/platform/ledger` | **KEEP** | Deterministic reconstruction from BUSINESS events | As-is |
| `core/platform/audit.ts` | **REMOVE** | Superseded by `audit-record.ts`; two shapes into one table | Single audit writer |
| `core/platform/notifications.ts` | **REFACTOR** | Framework has no channel and is disconnected from the table actually used | One notification service plus P4's Telegram transport |
| `core/platform/authority-*` (handshake, registration, signature, gateway) | **REMOVE** | Exists solely to bridge the companion↔VPS split that SPACE deletes | In-process module calls |
| `core/qualification/{gates,live-gates,activation,mainnet,deployment}` | **REFACTOR** | Four abstractions independently recompute the same evidence | One readiness evaluator |
| `core/qualification/scenario.ts` | **KEEP** | The only place the engine is fully assembled — it is the integration test | Promote to SPACE's integration suite |
| `core/infrastructure/*` (fsm, health, logging, scheduler, metrics, watchdogs, secret-scanner) | **KEEP** | Solid, generic, portable | Rename watchdog subsystem `"supabase"` → `"database"`; wire metrics to a real `/metrics` route |
| `core/configuration/env-validator` vs `environment` | **REFACTOR** | Two sources of truth with conflicting key names | One Zod schema, one `.env.example` |
| Execution-profile DSL parser | **REFACTOR** | Non-trivial parser hidden inside config loading | JSON profiles in Postgres, validated by Zod |
| Supabase (client, RLS, Auth, PostgREST, `config.toml`, 12 migrations) | **REMOVE** | SPACE is local Postgres | `pg`/Drizzle repositories; port the 20-table schema, drop RLS for app-layer authz, replace Supabase Auth with local sessions |
| `src/lib/*.functions.ts` and `*.server.ts` (~4,000 LOC) | **REFACTOR** | Correct read/write surface, but `any`-cast Supabase calls throughout | Typed service layer over the local DB |
| STONE UI shell, primitives, tokens, 18 routes | **KEEP** | Genuinely good operator UI: dark oklch, mono numerics | Keep the design system; merge the 7 telemetry re-slices; split `execution-profiles.tsx` |
| `src/routes/index.tsx` | **REMOVE** | Hardcoded, stale "Session 0" checklist | Login redirect |
| `api/public/authority/*` | **REMOVE** | Cross-process protocol, obsolete in one process | — |
| `api/public/health/*` | **KEEP** | Nginx and PM2 probes need exactly these | As-is |
| P4 `engine.ts` phase loop | **REFACTOR** | Per your direction, not copied | Frozen Window Engine on STONE's window FSM |
| P4 `settlement-*`, `accounting-verifier`, `bankroll`, dust compounding | **KEEP (port)** | Money-correctness logic earned through real production bugs | `core/settlement` and `core/accounting` |
| P4 `reconciler`, `watchdog`, `orphan-cleaner`, `preflight` | **KEEP (port)** | Live-drift detection has no STONE equivalent | SPACE infrastructure layer |
| P4 `trade-replay.ts` and `trade-replay-view.tsx` | **KEEP (port)** | Forensic per-trade evidence, complements event replay | Second tab on the SPACE replay page |
| P4 SQLite `db.ts` and write queue | **REFACTOR** | The queue pattern is right, the engine is not | Same non-blocking queue over local Postgres |
| P4 `http-agent`, `proxy`, `telegram-console`, dual `/v1` `/v2` dashboards | **REMOVE** | Dead weight and duplication | — |
| Both PM2 configs | **REFACTOR** | One is half-fictional, one is Next-specific | One `ecosystem.config.cjs`: one app, fork, 1 instance, graceful dispose |
| P4 nginx conf | **KEEP** | Correct proxy, SSE, WS and quiet health handling | Adapt ports and paths |
| Five `.env` templates | **REMOVE** | Five templates for one system | One `.env.example` |
| `docs/knowledge/**` (P4 behavioural spec) | **KEEP** | The most valuable document set in the archive | Move to `docs/legacy/` as SPACE's behavioural reference |
| ~60 milestone / phase / audit reports in `docs/` | **REMOVE** | Point-in-time status of a project that is ending | Archive outside the repository |

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
- **Deployment.** Losing Supabase means losing Auth *and* RLS simultaneously. Authorization must move into the app layer in the same change or SPACE ships with no access control.
- **Trading.** The live executor has never run inside STONE. The first SPACE milestone able to place a real order must be gated behind paper mode, P4's preflight and a kill switch.
- **Recovery.** STONE's `runtimeState` store silently falls back to in-memory while everything around it persists — state loss on every restart.

## Phase 7 — SPACE compatibility

**Already compatible:** layered core with executable enforcement; pure decision, risk, replay and recovery functions; injectable Clock; append-only event model; window FSM and quota; standing-order engine; health endpoints; operator UI shell and design system; the `docs/knowledge` behavioural spec.

**Needs refactor:** feed providers to real clients; venue gateway to a real CLOB adapter; data layer to local Postgres; configuration to one schema and one template; qualification to one evaluator; UI to fewer, non-duplicated pages; engine loop to a serialised Frozen Window Engine.

**Must be removed:** Supabase in all forms; Cloudflare/Workers assumptions; the entire authority handshake, registration and signature protocol; the two-process PM2 split; the milestone document corpus; the static index page; duplicated env, audit, event and telemetry surfaces.

**Must be added:** a single Node process entrypoint that actually runs the engine; local Postgres schema, migrations and typed repositories; local auth and app-layer authorization; trigger latching at window open (the "frozen" in Frozen Window); 15-minute market support alongside the 5-minute default; ported settlement, accounting, bankroll, reconciler, watchdog, orphan-cleaner, preflight and Telegram alerting; per-trade forensic replay; one PM2 config, one Nginx config, one `.env.example`.

## Deliverables on approval

1. `docs/SPACE_MIGRATION_REPORT.md` — this report in full, plus a per-file classification appendix.
2. `docs/SPACE_ARCHITECTURE.md` — the locked SPACE architecture and module boundaries, stating that the UI never owns trading logic and only issues commands to the in-process engine.

No source file is touched until you approve the implementation plan that follows these two documents.