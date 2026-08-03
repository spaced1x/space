# SPACE — Final Operator Terminal Completion

Runtime integration, operator UX and bug fixing only. Strategy, Risk, Execution, Replay, Statistics, Scheduler, Recovery, Backup/Restore and database behaviour stay untouched apart from the per-environment isolation described below.

## 1. Two runtimes, one process (V1 / V2)

Mission Control always shows both runtime panels:

- V1 TESTNET (Paper) — blue identity
- V2 MAINNET (Live) — red identity

Each panel has START and STOP plus live Status, Current Provider, Current Market, Current Position, Current TWAP. Only one runtime may be RUNNING.

How START works:
1. The chosen environment is written to a supervisor-owned target file (`data/runtime-target.json`) that lives outside either database.
2. Graceful shutdown runs: scheduler, engine loop, Binance, RTDS, Chainlink, Gamma, CLOB, Telegram closed, logs flushed, runtime state persisted, SQLite closed, lock released.
3. The process exits non-zero so PM2 restarts it, and boot reads the target file to select the environment.
4. Boot re-opens every subsystem for that environment; the dashboard polls until the new runtime answers and restores itself automatically.

STOP performs the same graceful shutdown and leaves the process in a stopped runtime: every connection card reads STOPPED/OFFLINE with its last known state and reason, never a stale "connected". Starting one runtime implicitly stops the other. No confirmation dialogs, no hot-swapping adapters inside a process.

Per-environment isolation: `space-v1.db` / `space-v2.db` with matching `.lock` files, so runtime state, replay history, statistics, config snapshots, metrics and backups never mix. The existing environment stamp guard stays as the safety net. Replay, Statistics, Operations Desk, Diagnostics and Manual Trading read the active runtime only — they already consume the shared snapshot, so this follows automatically.

Engine status wording becomes RUNNING / STARTING / STOPPING / STOPPED. OBSERVE and the ARM/DISARM operator workflow disappear from the UI and the runtime state model; the emergency stop latch remains and still blocks new orders.

## 2. Mission Control tabs

One route, eight tabs on the same snapshot: Overview, Trading, Orders, Positions, TWAP, Connections, Runtime, Recent Events. No new routes, no duplicated state, nothing removed — today's panels move into the tab that owns them.

## 3. Overview

Runtime banner, both runtime panels, environment, paper/live capital line, trading mode, emergency stop, Current Trading Target, Current Position, Current TWAP, health and readiness, wallet, provider, current strategy (buffer, PTB, direction, confidence) and recent events. Every section renders something real; no blank cards.

## 4. Current Trading Target

Waiting state shows last Gamma refresh, discovery latency, markets scanned, BTC markets discovered, next discovery, discovery interval, Gamma endpoint, last successful response, waiting reason, trading impact and recovery.

Active state shows question, market ID, condition ID, YES/NO tokens, PTB, bid, ask, mid, spread, liquidity, volume, countdown, settlement and probability. Any field the engine has not observed is shown as not yet observed, never invented.

## 5. Current Position

Always rendered. With no position: "No open position" plus the live strategy intent — direction, PTB, settlement TWAP, buffer, confidence, trigger, window, execution state, risk verdict, waiting reason. With positions: market, token, YES/NO, side, entry, average price, current price, quantity, unrealised and realised PnL, execution status, risk decision. Projection of existing execution state only — no new trading logic.

## 6. Current TWAP card

Active provider, standby provider, settlement price, freshness, latency, samples, sequence, window, current TWAP, last update, environment, endpoint, provider state, trading impact, operator action and reason. When no provider is active the card names the exact missing configuration instead of saying "No provider".

## 7. Runtime connections

Full card for SQLite, Scheduler, Wallet, Polygon RPC, Gamma, Market Discovery, Binance, RTDS, Chainlink, Polymarket CLOB, Telegram. Each shows status, latency, reconnects, endpoint, environment, last success, last failure, last error, trading impact, recovery, operator action and its own connection history. RTDS and Chainlink become first-class connection entries alongside the existing TWAP provider entry.

## 8. Runtime banner

Trading-blocked lines gain reason, action and recovery, naming the exact variable (`WALLET_PRIVATE_KEY`, `POLYGON_RPC_URL`, `RTDS_*`, ...) and whether recovery is automatic or manual.

## 9. CLOB card

Authentication state, wallet, signature type, API version, host, environment, rate limits, remaining requests, open orders, open positions, last authenticated, last request, latency, connection status and trading status — all from the live adapter.

## 10-11. Sidebar and typography

Desktop scale: headings 30px, card titles 22px, values 18px, labels 16px, sidebar 17px, tables/buttons/inputs/status badges 16px. Sidebar gets larger type, tighter alignment and less dead whitespace. Responsive behaviour and the current SPACE design language are preserved.

## 12-13. Bug fixing and Diagnostics

Sweep for missing runtime bindings, stale snapshot values, duplicated UI state, cards that do not refresh, placeholder loading text, incorrect environment labels, console/React/hydration warnings, broken or non-responsive layouts, and dead components left over from earlier milestones.

Diagnostics becomes the read-only engineering console: boot timeline, runtime timeline, runtime snapshot, memory, CPU, scheduler, SQLite, reconnect history, per-connection detail for Gamma, Binance, RTDS, Chainlink, CLOB and Telegram, failure history, health, configuration snapshot and recent events.

## Technical notes

- New: `src/core/runtime/target.server.ts` (persisted runtime target), runtime lifecycle commands `START_RUNTIME` / `STOP_RUNTIME` on the existing command bus, per-environment DB path resolution in `env.server.ts` / `lock.server.ts`.
- Changed: `state/store.ts` status enum, `boot.server.ts`, `shutdown.server.ts`, `connections.server.ts` (+ RTDS/Chainlink ids), `connection-sync.server.ts`, `system.functions.ts` snapshot payload, `styles.css` type scale, `workspace-nav.tsx`.
- New components: runtime panels, mission-control tabs, current-position card, TWAP provider card, CLOB card, discovery-waiting card.
- START trades: with ARM removed, a RUNNING runtime is the sanctioned trading state; the internal guard that prevents any non-operator code from enabling trading stays in place, driven by the START command instead of ARM.
- Restart depends on a supervisor (PM2 `ecosystem.config.cjs`) being present; without one the process must be started again by hand, and the UI will say so.
- Verification: `bunx tsgo --noEmit`, `bunx vitest run`, `bun run build`, and a Playwright walkthrough of every tab plus a V1 START/STOP cycle.

## Known blockers

RTDS payload shape and Chainlink stream credentials are still unavailable, so those two cards will report NOT_CONFIGURED with the exact variables required until real credentials exist.