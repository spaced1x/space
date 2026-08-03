# SPACE — Runtime Connection Manager & Live Operator Terminal

Make the terminal expose the running engine. No architecture changes, no new trading behaviour, no changes to strategy, risk or execution logic. Replay and Statistics are untouched.

## 1. Runtime Connection Manager (new)

New module `src/core/runtime/connections.server.ts`. One in-memory registry that owns a record per connection:

```text
sqlite · scheduler · wallet · polygon_rpc · gamma ·
binance · clob · twap_provider · telegram
```

Each record carries: `state`, `reason`, `endpoint`, `environment`, `latencyMs`, `reconnects`, `lastSuccessAt`, `lastAttemptAt`, `lastError`.

Connection states: `NOT_STARTED | CONNECTING | CONNECTED | DEGRADED | DISCONNECTED | FAILED | NOT_CONFIGURED`. A connection never has an absent state — the registry seeds all nine as `NOT_STARTED` at module load.

The frozen `HealthState` enum stays as-is. The manager projects each connection state onto the existing health states (`CONNECTED→OK`, `CONNECTING/DEGRADED/DISCONNECTED→DEGRADED`, `FAILED→FAILED`, `NOT_CONFIGURED→DISABLED`, `NOT_STARTED→NOT_INITIALIZED`) and registers those projections in the existing Health Registry, so nothing downstream changes shape.

Existing adapters (database, scheduler, wallet, RPC verify, Gamma discovery, Binance feed, Polymarket CLOB, settlement/TWAP, Telegram) report into the registry from the places they already track stats — no duplicate polling is added.

## 2. Deterministic boot sequence

`src/core/boot.server.ts` keeps its existing timed `stage()` instrumentation and is reordered/extended to the required order:

```text
database → scheduler → runtime → wallet → rpc → gamma → binance →
twap provider → clob → telegram → market discovery → strategy →
mission control → READY
```

Each stage marks its connection `CONNECTING` then `CONNECTED`/`FAILED`/`NOT_CONFIGURED`. A non-critical stage failure never aborts boot; it records the state and reason and boot still ends in OBSERVE. The full stage trace (already captured by `getBootTrace`) is surfaced on Diagnostics.

Also fixes the current lockfile boot error (`ENOENT: ./data/space.db.lock`) by creating the lock directory before writing.

## 3. Live snapshot surface

`src/lib/system.functions.ts` — `getSystemSnapshot` gains `connections` (all nine records) and `boot` (stage trace). One snapshot, polled every 2s, remains the only read surface, so no two panels can disagree.

## 4. Mission Control becomes live

`src/routes/index.tsx`, `src/components/space/mission-control.tsx`, plus new `src/components/space/connection-card.tsx` and `src/components/space/market-card.tsx`.

Cards, always rendered, never blank: Environment, Execution Engine, Engine State, Database, Scheduler, Wallet, RPC, Gamma, Binance, TWAP Provider, CLOB, Telegram, Current Market, Current Position, Current TWAP, Health.

Every connection card shows status, latency, reconnect count, last successful update, last error, endpoint and environment.

Market card shows question, condition id, market id, settlement time, liquidity, volume, status and a live countdown. Liquidity/volume come from the Gamma payload — discovery already fetches it; the two fields are carried through `DiscoveredMarket` (read-only metadata, no selection logic change).

Binance card: status, BTC price, heartbeat, latency, reconnects, last update. CLOB card: auth, wallet, environment, host, open orders, open positions, last request, connection state. Wallet card: address, chain id, RPC, connection, balance where already available.

## 5. Meaningful empty states

Remove every generic "connecting…/loading…/computing…" across `index.tsx`, `diagnostics.tsx`, `manual.tsx`, `operations.tsx`, `settings.tsx`. Each surface renders the concrete reason instead: "Waiting for Binance websocket…", "Gamma connected, no active BTC market found…", "Wallet not configured…", "Telegram not configured…".

## 6. Diagnostics as authoritative runtime page

`src/routes/diagnostics.tsx` gains a boot-sequence table (stage, duration, result) and a subsystem table listing every connection with state, reason, endpoint, last update and mapped health — alongside the existing event log and failure harness.

## 7. Typography

`src/styles.css` plus the shell/nav components: raise the desktop type scale one step (sidebar, nav, card titles, labels, tables, buttons, status text) while keeping the current light violet instrument design language and mono numerics.

## Files expected to change

- New: `src/core/runtime/connections.server.ts`, `src/components/space/connection-card.tsx`, `src/components/space/market-card.tsx`
- Edited: `boot.server.ts`, `db/lock.server.ts`, `db/database.server.ts`, `scheduler.server.ts`, `market/discovery.server.ts`, `market/types.ts`, `feeds/binance.server.ts`, `execution/wallet.server.ts`, `execution/polymarket.server.ts`, `settlement/settlement.server.ts`, `telegram/telegram.service.ts`, `engine/loop.server.ts`, `lib/system.functions.ts`, `lib/diagnostics.functions.ts`, `routes/index.tsx`, `routes/diagnostics.tsx`, `components/space/*`, `src/styles.css`

## Verification

`bunx tsgo --noEmit`, `bunx vitest run`, `bun run build`, plus a Playwright pass over Mission Control and Diagnostics confirming no generic placeholders and every subsystem showing a state.
