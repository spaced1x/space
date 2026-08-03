# SPACE — Final Operator Terminal Completion (Revised)

Architecture frozen. Strategy, Risk, Execution, Replay, Statistics, Scheduler, Recovery and Backup/Restore keep their current behaviour; only the runtime lifecycle, per-environment isolation and the operator terminal change.

## 1. Single runtime, two environments

One process boots either V1 TESTNET (Paper, blue) or V2 MAINNET (Live, red). Mission Control always shows both runtime panels; only one may be RUNNING.

Each panel: START, STOP, Runtime Status, Active TWAP Provider, Current Market, Current Position, Runtime Health, Current Database, Last Runtime, Last Shutdown Reason. The inactive runtime stays visible as STOPPED with its last persisted runtime information, read from that environment's own database and target file.

## 2. Unified runtime lifecycle

```text
STOPPED -> STARTING -> VALIDATING -> READY -> RUNNING -> STOPPING -> STOPPED
                    \-> FAILED
```

READY means every mandatory subsystem has started successfully and the runtime is ready to trade. Waiting for a market, waiting for a TWAP sample, or waiting for the next discovery cycle are operational states surfaced by Mission Control and do not prevent the runtime from entering READY. RUNNING means the runtime has entered its normal operating loop and is actively processing live runtime events. A missing market or no current trading opportunity never downgrades the runtime lifecycle by itself.

One enum replaces every visible engine state. OBSERVE is removed from the UI entirely; ARM/DISARM leave the operator workflow. The internal safety latch survives as an implementation detail that the validation gate releases — no operator ever sees or presses it. Mission Control, Diagnostics, connection cards and status badges all read this single lifecycle; no duplicated enums.

## 3. START / STOP

START does not immediately enable trading. It persists the selected runtime target, gracefully shuts down any active runtime (persist state, flush logs, close Scheduler, Binance, RTDS, Chainlink, Gamma, CLOB, Telegram, SQLite, release locks), then exits for supervisor restart and boots the selected runtime. START only starts the runtime lifecycle. Strategy execution may begin only after the runtime reaches RUNNING, all mandatory runtime dependencies remain healthy, and the emergency stop is clear. Runtime startup never bypasses existing safety checks.

Boot order: STARTING -> Database -> Runtime -> Scheduler -> Wallet -> Polygon RPC -> Gamma -> Binance -> TWAP Provider -> CLOB -> Telegram -> Market Discovery -> Runtime Validation -> READY -> RUNNING.

The persisted runtime target is versioned so future upgrades stay compatible:

```text
{ version, environment, updatedAt, requestedBy }
```

STOP runs the reverse sequence. Afterwards every connection reads STOPPED or OFFLINE with the real reason — never a stale CONNECTED.

## 4. Runtime validation gate

One gate, run between VALIDATING and READY, split into two classes.

Mandatory — must pass: SQLite, Runtime Database (and version), Runtime Target, Wallet, Polygon RPC, Chain ID, Gamma, Binance, CLOB, Scheduler, TWAP Provider.

Optional — never block: Telegram, Chainlink (only when enabled), Market Discovery telemetry. Optional services report DEGRADED or DISABLED with their reason and never prevent READY or RUNNING.

A mandatory failure leaves the runtime in FAILED with the exact blocking dependency, missing variable and recovery. No generic errors. This extends the existing pre-ARM validation rather than adding a second gate.

## 5. Per-environment isolation

`space-v1.db` / `space-v2.db` with matching `.lock` files. Replay, Statistics, configuration snapshots, runtime metrics, backups, runtime events, orders, positions and execution history are isolated per environment. The environment stamp validation stays active as the safety net.

## 6. Mission Control tabs

One workspace, tabs: Overview, Trading, Orders, Positions, TWAP, Connections, Runtime, Recent Events. All tabs consume the shared runtime snapshot; no duplicated state and nothing removed — existing panels move into the tab that owns them.

## 7. Runtime banner

Always shows environment, runtime state, trading state, emergency stop, current provider, runtime validation result, blocking dependency, operator action, recovery and paper/live identity. Missing configuration is named exactly (`Missing WALLET_PRIVATE_KEY`, `Missing POLYGON_RPC_URL`, `Missing RTDS_API_KEY`, `Missing POLYMARKET_API_SECRET`, ...) — never a bare "Not Configured".

The environment badge carries four lines so the operator sees everything at a glance:

```text
V1 TESTNET / Paper / RTDS / space-v1.db
V2 MAINNET / Live  / RTDS / space-v2.db
```

## 8. Current Trading Target

Waiting: last Gamma refresh, discovery latency, markets scanned, BTC markets discovered, discovery interval, next discovery, waiting reason, trading impact, recovery.

Live: question, market ID, condition ID, YES token, NO token, PTB, bid, ask, mid, spread, liquidity, volume, countdown, settlement, probability. Unobserved fields say so; nothing is fabricated.

## 9. Current Position

Always rendered. No position: strategy direction, PTB, settlement TWAP, buffer, confidence, trigger, window, risk verdict, waiting reason. Position open: market, token, YES/NO, side, entry, average price, current price, quantity, unrealised PnL, realised PnL, execution status, risk decision. Read-only projection of existing execution state.

## 10. TWAP provider

Card shows active provider, standby provider, environment, endpoint, symbol, current TWAP, settlement price, samples, sequence, freshness, latency, last update, buffer, direction, PTB, confidence, trading impact, operator action, reason, plus last provider switch timestamp and switch reason. Active provider selection persists across restart in the environment's own database. If the previously selected provider is unavailable during boot it remains selected and the runtime reports the provider as FAILED; the runtime itself continues to start provided all mandatory startup requirements are satisfied. Trading remains blocked until the active provider becomes healthy or the operator explicitly selects another provider. Providers are never switched automatically.

## 11. Runtime connections

First-class cards for SQLite, Scheduler, Wallet, Polygon RPC, Gamma, Market Discovery, Binance, RTDS, Chainlink, TWAP Provider, Polymarket CLOB, Telegram. Each shows status, latency, reconnects, endpoint, environment, last success, last failure, last error, trading impact, recovery, operator action and its own connection history. RTDS and Chainlink become registered connection ids alongside the existing TWAP Provider entry.

## 12. CLOB card

Authentication, wallet, signature type, API version, host, environment, API key / secret / passphrase configured flags (presence only, never values), rate limits, remaining requests, open orders, open positions, last authentication, last request, latency, connection state — all from the live adapter.

## 13-14. Diagnostics timelines

Runtime timeline: timestamped restart requested, restart completed, runtime started, wallet connected, RPC connected, Gamma connected, Binance connected, RTDS connected, CLOB authenticated, validation passed, validation failed, market found, trading ready, order submitted, recovered, shutdown.

Market timeline: market discovered, discovery complete, TWAP started, trigger fired, intent created, risk approved, order submitted, filled, settlement, replay available. Both are projections of existing runtime events — no new event sources.

Current Runtime Configuration table: environment, database, database schema version, TWAP provider, provider state, strategy, execution mode, version, build, git commit, started at.

## 15. Sidebar and desktop polish

Headings 30px, card titles 22px, values 18px, labels 16px, sidebar 17px, buttons 16px, inputs 16px, status badges 16px. Improved spacing and alignment, SPACE design language and responsive behaviour preserved.

## 16. Bug sweep

Resource correctness first: memory leaks, unclosed WebSockets, scheduler duplication, duplicate polling, zombie timers, duplicate event listeners and full resource cleanup after STOP.

Then UI: missing runtime bindings, placeholder loading text, empty cards, cards that stop refreshing, incorrect runtime/environment labels, broken V1/V2 display, missing provider / CLOB / RTDS / Chainlink information, stale snapshot values, duplicate runtime state, React and hydration warnings, console errors, dead components, broken layouts, lifecycle inconsistencies. No placeholder UI remains.

## Technical notes

- New: `src/core/runtime/target.server.ts` (persisted runtime target outside both databases), `START_RUNTIME` / `STOP_RUNTIME` on the existing command bus, per-environment DB and lock path resolution in `env.server.ts` / `lock.server.ts`, `RTDS` and `CHAINLINK` connection ids.
- Changed: `state/store.ts` lifecycle enum, `boot.server.ts` staged boot, `shutdown.server.ts` reverse sequence, `startup/validation.server.ts` gate, `connections.server.ts`, `connection-sync.server.ts`, `twap/registry.server.ts` persistence, `system.functions.ts` / `diagnostics.functions.ts` snapshots, `styles.css` type scale, `workspace-nav.tsx`, `console-shell.tsx`.
- New components: runtime lifecycle panels, mission-control tabs, current-position card, TWAP provider card, CLOB runtime card, discovery-waiting card, runtime and market timelines.
- Restart relies on the PM2 supervisor in `ecosystem.config.cjs`; without a supervisor the process must be restarted manually and the UI says exactly that.

## Verification

`bunx tsgo --noEmit`, `bunx vitest run`, `bun run build` (production), plus a Playwright and runtime walkthrough covering: cold boot, warm restart, V1 START, V1 STOP, V2 START, V2 STOP, ten restart cycles, every Mission Control tab, environment isolation, RTDS, Chainlink standby, CLOB authentication, the validation gate, provider persistence, connection timeline and market timeline. Pass conditions: no duplicate timers, no duplicate WebSocket connections, no increasing memory across the restart cycles, no console errors, all tests green.

## Final deliverable

A written implementation report listing every file changed, every migration added, every runtime component added, every new environment variable, every new command bus command, every remaining limitation and every known blocker, ending with an explicit confirmation that no placeholder code, TODOs, mocked values or unfinished runtime paths remain.

## Known blockers

V2 MAINNET START, real CLOB authentication, RTDS and Chainlink connections cannot reach CONNECTED without live credentials; until those exist those checks report their exact missing variables and V2 stops at the validation gate. This will be reported rather than faked.