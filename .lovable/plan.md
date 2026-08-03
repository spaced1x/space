# SPACE — Runtime Connection Manager & Live Operator Terminal (Rev 2)

Make the terminal expose the running engine. No architecture changes, no new trading behaviour, no changes to strategy, risk or execution logic. Replay and Statistics untouched. No environment *switching* in this milestone — display only.

**Absolute rule: no fabricated runtime values.** Every number on screen comes from live runtime state. If a source is not connected, the field shows what SPACE is waiting for ("Waiting for Gamma…"), never a placeholder number, sample value, or last-known value presented as current.

## 1. Environment visibility (V1 / V2)

Mission Control always shows the active runtime environment, read from `SPACE_ENVIRONMENT` via the runtime snapshot (never a hardcoded label):

- `V1_TESTNET` → **V1 TESTNET (Paper)**
- `V2_MAINNET` → **V2 MAINNET (Live)**

Read-only. The same value is echoed on every connection card so an operator can never mistake which venue a subsystem is talking to.

## 2. Runtime Connection Manager (new)

New module `src/core/runtime/connections.server.ts`. One in-memory registry, one record per connection:

```text
sqlite · scheduler · wallet · polygon_rpc · gamma · market_discovery ·
binance · twap_provider · clob · telegram
```

`market_discovery` is separate from `gamma` on purpose: Gamma can be CONNECTED while discovery is WAITING with reason "no active BTC market".

Each record: `state`, `reason`, `endpoint`, `environment`, `latencyMs`, `reconnects`, `lastSuccessAt`, `lastAttemptAt`, `lastError`, plus history counters (`connectedCount`, `disconnectedCount`, `lastFailureAt`, `lastRecoveryMs`).

States: `NOT_STARTED | CONNECTING | CONNECTED | WAITING | DEGRADED | DISCONNECTED | FAILED | NOT_CONFIGURED`. All ten connections are seeded at module load, so no subsystem is ever stateless.

The frozen `HealthState` enum is unchanged. The manager projects connection states onto it (`CONNECTED→OK`, `CONNECTING/WAITING/DEGRADED/DISCONNECTED→DEGRADED`, `FAILED→FAILED`, `NOT_CONFIGURED→DISABLED`, `NOT_STARTED→NOT_INITIALIZED`) and registers those projections with the existing Health Registry. Adapters report from where they already track stats; no duplicate polling.

## 3. Deterministic boot sequence

`boot.server.ts` keeps its timed `stage()` trace and is reordered to:

```text
database → scheduler → runtime → wallet → rpc → gamma → binance →
twap → clob → telegram → market discovery → strategy →
dashboard snapshot → READY
```

Boot never depends on UI: the final stage builds the first dashboard snapshot; the UI only reads it. Each stage sets `CONNECTING` then a terminal state. A non-critical failure records state + reason and boot still ends in OBSERVE. Also fixes the current lockfile error (`ENOENT: ./data/space.db.lock`) by creating the lock directory before writing.

## 4. Snapshot surface

`getSystemSnapshot` gains `environment`, `connections` (all ten), and `boot` (stage trace). Polled every 2s. One snapshot, so no two panels disagree.

## 5. Mission Control cards (always rendered, never blank)

Environment (V1/V2) · Trading Mode (Strategy / Manual) · Engine (Paper / Live) · Engine State · Database · Scheduler · Wallet · RPC · Gamma · Market Discovery · Binance · TWAP Provider · CLOB · Telegram · Current Trading Target · Current Position · Current TWAP · Health.

Trading Mode, Engine and Environment are shown as three distinct facts, never merged.

**Current Trading Target** — question, market ID, condition ID, settlement time, remaining countdown, liquidity, volume, YES token, NO token. Liquidity/volume carried through from the Gamma payload into `DiscoveredMarket` as read-only metadata (no selection-logic change).

**Binance** — status, BTC price, heartbeat, latency, reconnects, last update.

**CLOB** — API version, environment, authentication, wallet, open orders, open positions, rate-limit usage (from the existing `rate-limit.server.ts` counters), last response, latency, connection state.

**Wallet** — address, signer type (EOA / Proxy / Safe, from `POLYMARKET_SIGNATURE_TYPE`), chain ID, RPC, connection, balance where already available.

Every connection card also shows latency, reconnect count, last successful update, last error, endpoint, environment.

## 6. Empty states

Every empty state answers four things: **what SPACE is waiting for**, **why**, **what the operator should do**, **whether trading is blocked**. Example:

```text
Wallet        Not Configured
Waiting for   a signing key
Why           WALLET_PRIVATE_KEY is unset
Trading       Blocked
Action        Configure WALLET_PRIVATE_KEY in .env and restart
```

Applied across `index.tsx`, `diagnostics.tsx`, `manual.tsx`, `operations.tsx`, `settings.tsx`. Every generic "connecting…/loading…/computing…" is removed.

## 7. Diagnostics as authoritative runtime page

Three tables added alongside the event log and failure harness:

1. **Boot sequence** — stage, started, duration, result, next stage.
2. **Subsystems** — state, reason, endpoint, environment, last update, mapped health.
3. **Connection history** — subsystem, connected count, disconnected count, reconnects, last failure, recovery time.

## 8. Typography (desktop, exact)

Section headings 28px · Card titles 22px · Values 16–18px · Labels 15px · Sidebar 16px · Buttons 15px · Status text 15px. Applied via base type tokens in `src/styles.css` and the shell/nav/card components; existing light-violet instrument design language and mono numerics preserved. Mobile scales down proportionally.

## Files expected to change

- New: `src/core/runtime/connections.server.ts`, `src/components/space/connection-card.tsx`, `src/components/space/trading-target-card.tsx`, `src/components/space/empty-state.tsx`
- Edited: `boot.server.ts`, `db/lock.server.ts`, `db/database.server.ts`, `scheduler.server.ts`, `market/discovery.server.ts`, `market/types.ts`, `feeds/binance.server.ts`, `execution/wallet.server.ts`, `execution/polymarket.server.ts`, `execution/rate-limit.server.ts`, `settlement/settlement.server.ts`, `telegram/telegram.service.ts`, `engine/loop.server.ts`, `lib/system.functions.ts`, `lib/diagnostics.functions.ts`, `routes/index.tsx`, `routes/diagnostics.tsx`, `routes/manual.tsx`, `routes/operations.tsx`, `routes/settings.tsx`, `components/space/*`, `src/styles.css`

## Verification

```text
Fresh boot → every connection reaches a valid state → Mission Control populated →
Diagnostics populated → no placeholder text → no console errors →
no runtime errors → production build → tests
```

Driven with a Playwright pass over Mission Control and Diagnostics plus `bunx tsgo --noEmit`, `bunx vitest run`, `bun run build`. Every changed file reported at the end.
