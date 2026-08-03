# Mission Control Completion & Live Runtime Integration

Architecture stays frozen. No strategy, risk, execution, replay or statistics behaviour changes. One new runtime capability (TWAP provider abstraction with a real RTDS adapter), everything else is presentation and wiring of data that already exists.

## 1. TWAP provider abstraction (only new runtime code)

Today the settlement TWAP is computed in-process from Binance trade samples; there is no provider concept and no RTDS code anywhere in the repository. This milestone introduces the provider layer:

- `src/core/twap/provider.ts` — provider contract: `id`, `label`, `describe()` (endpoint, environment, symbol), `start()/stop()`, `latest()` returning `{ price, atMs, latencyMs }`, and a state of `CONNECTED | WAITING | NOT_CONFIGURED | DISABLED | FAILED` with a real reason string.
- `src/core/twap/rtds.provider.server.ts` — real RTDS adapter against the Polymarket real-time data service (`wss://ws-live-data.polymarket.com`, crypto price channel for the configured symbol). Handles subscribe, heartbeat, reconnect with backoff, freshness age, latency, reconnect count and last error. Endpoint + symbol come from env (`RTDS_WS_URL`, `RTDS_SYMBOL`), added to `env.schema.ts` and `.env.example` with defaults.
- `src/core/twap/chainlink.provider.server.ts` — thin wrapper over the existing Chainlink feed reader, exposed as the second provider. Reports `NOT_CONFIGURED` with the exact missing variable (`POLYGON_RPC_URL` / `CHAINLINK_BTC_USD_FEED`) when credentials are absent.
- `src/core/twap/registry.server.ts` — holds both providers, resolves the active one, persists the active provider id in the existing KV repository (`twap.active_provider`), defaulting to `rtds` for both V1 and V2. No UI switching in this milestone; the registry exposes `setActiveProvider()` for the next one.

The engine loop feeds the settlement TWAP engine from the **active provider** instead of Binance. Binance remains a runtime feed (price display, market context) and is unchanged otherwise. The TWAP maths in `twap.ts` is untouched — only the sample source changes. If the active provider is not `CONNECTED`, the TWAP reports its existing `WARMING`/`STALE`/`IDLE` states and the provider reason is surfaced verbatim; no fallback to Binance samples and no synthetic values.

`connection-sync.server.ts` reports `twap_provider` from the registry: active provider, environment, endpoint, last update, latency, freshness age, reason, action, trading impact.

## 2. Runtime readiness banner

New `src/components/space/runtime-banner.tsx`, first element on Mission Control. State is derived, in priority order, purely from the existing snapshot (engine status, environment, connection records):

`BLOCKED` → `WAITING_FOR_CONFIGURATION` → `WAITING_FOR_RPC` → `WAITING_FOR_CLOB` → `WAITING_FOR_TWAP` → `WAITING_FOR_MARKET` → `READY`, then coloured as `PAPER_TRADING` (V1) or `LIVE_TRADING` (V2) when ready.

Each state renders reason, trading impact and expected recovery, all taken from the offending connection record's own `reason`/`action`/`recovery` fields. The words "Not Configured" never appear alone — a missing dependency always names the exact variable or credential and the operator action.

## 3. Environment presentation

A single `EnvironmentBadge` component (blue `V1 TESTNET · PAPER · SIMULATION`, red `V2 MAINNET · LIVE · REAL MONEY`) rendered in the app header (`console-shell.tsx`), sidebar (`mission-control.tsx`), Mission Control banner, Diagnostics header and the runtime snapshot block. Environment stays read-only. Adds `--env-live` red tokens to `styles.css` alongside the existing warn tone.

## 4. Mission Control layout (operator-first)

`src/routes/index.tsx` reordered to: runtime banner → readiness/environment summary row → Current Trading Target → Current TWAP → Current Position → runtime connection grid → recent events. Health summary, boot trace, WAL mode, schema version, opened-at and the raw event stream move to (or stay only on) Diagnostics.

**Current Trading Target** (`trading-target-card.tsx`) expands to: question, market id, condition id, PTB, YES/NO token ids, bid, ask, mid, spread, liquidity, volume, status and a live countdown to close/settlement. With no market: last Gamma refresh, next discovery attempt, discovery interval, markets scanned and the expected next BTC market slot — all from `DiscoveryStats` and the scheduler task record.

**Current Position** (new `current-position-card.tsx`): live open positions from the execution store (market, token, side, size, average price, unrealised PnL, order status) and, alongside them, the current strategy intent for the active window (window id, intended direction, PTB, settlement TWAP, buffer, confidence, trigger state, submitted vs waiting). With no position it states "No open position" and still shows the intent. Read-only projection of the existing snapshot; no new trading logic.

**TWAP Provider card**: active provider, environment, endpoint, last update, latency, freshness, samples, window length, reason, action, trading impact — plus the inactive provider listed with its real state.

**CLOB card** (`connection-card.tsx` gains a typed detail renderer): connection state, authentication, API version, environment, host, wallet, signature type (EOA/Proxy/Safe), rate-limit usage, open orders, open positions, last authenticated, last request, latency. Missing credentials render the required action.

**Binance card**: WebSocket state, current BTC price, last heartbeat, stream latency, reconnect count, last update, symbol, stream URL.

All ten dependencies keep a visible card: sqlite, scheduler, wallet, polygon_rpc, gamma, market_discovery, binance, twap_provider, clob, telegram.

## 5. Desktop polish

Card gap 12px → 20px, panel padding up, consistent label/value grid alignment, larger numeric values (20px mono), larger status badges, and larger buttons/inputs/selects across the operator surfaces. Existing SPACE design language and tokens retained.

## 6. Verification

Fresh boot with Playwright against the running dev server: screenshot Mission Control and Diagnostics, assert no blank/placeholder cells, all ten connection cards present, banner state matches engine state, RTDS and Chainlink states rendered from real adapter output, no console errors. Then `bunx vitest run` and the production build.

## Deliverables

A list of every changed file, plus the remaining runtime gaps that must be closed before V1/V2 environment switching and UI-driven TWAP provider selection can be implemented.

## Technical notes

- New files: `src/core/twap/provider.ts`, `rtds.provider.server.ts`, `chainlink.provider.server.ts`, `registry.server.ts`; `src/components/space/runtime-banner.tsx`, `environment-badge.tsx`, `current-position-card.tsx`, `twap-provider-card.tsx`.
- Edited: `env.schema.ts`, `.env.example`, `loop.server.ts` (TWAP sample source), `connection-sync.server.ts`, `connections.server.ts` (richer details), `system.functions.ts` (position + intent + provider projection), `index.tsx`, `diagnostics.tsx`, `console-shell.tsx`, `mission-control.tsx`, `trading-target-card.tsx`, `connection-card.tsx`, `styles.css`.
- Unit tests added for provider state mapping and banner-state derivation; existing suites must stay green.
