# SPACE — Runtime Connection Manager & Live Operator Terminal (Rev 2)

Make the terminal expose the running engine. No architecture changes, no new trading behaviour, no changes to strategy, risk or execution logic. Replay and Statistics untouched. No environment *switching* in this milestone — display only.

**Absolute rule: no fabricated runtime values.** Every number on screen comes from live runtime state. If a source is not connected, the field shows what SPACE is waiting for ("Waiting for Gamma…"), never a placeholder number, sample value, or last-known value presented as current.

## 1. Environment visibility (V1 / V2)

Mission Control always shows the active runtime environment, read from `SPACE_ENVIRONMENT` via the runtime snapshot (never a hardcoded label):

- `V1_TESTNET` → **V1 TESTNET (Paper)**
- `V2_MAINNET` → **V2 MAINNET (Live)**

Read-only. The badge lives in the app shell, so it is visible on **every** page, not just Mission Control. The same value is echoed on every connection card so an operator can never mistake which venue a subsystem is talking to.

### Environment Conformance (the environment drives everything)

The active environment is the single source of truth. Every runtime component resolves its configuration through one resolver; no module reads endpoint config directly. Covered: Gamma endpoint, Polymarket CLOB endpoint, Polygon RPC, wallet, TWAP provider, Replay namespace, Statistics namespace, Diagnostics labels, Telegram notifications.

No subsystem may silently use configuration from another environment. Each connection record carries the environment it actually resolved. If any resolved environment differs from `SPACE_ENVIRONMENT`, the existing Environment Conformance Gate fails and Mission Control shows a conformance error instead of a green card — making "V1 UI → mainnet CLOB" structurally impossible rather than merely unlikely.

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

`getSystemSnapshot` gains `environment`, `connections` (all ten), `boot` (stage trace), `timeline` (connection lifecycle events), `envResolution` (per-subsystem resolved environment), and a `runtime` block: `uptime`, `bootTime`, `buildVersion`, `gitCommit`, `schemaVersion`. Polled every 2s. One snapshot, so no two panels disagree. The runtime block appears in Diagnostics and the shell footer for VPS debugging.

## 5. Mission Control cards (always rendered, never blank)

**Summary row (top of the page, one glance):**

```text
SPACE  Environment V1 TESTNET | Engine PAPER | TWAP RTDS | Market CONNECTED
       Strategy READY | Risk READY | Execution READY | Health 98% | Trading WAITING FOR MARKET
```

Every cell derives from live runtime state; a cell with no data reads WAITING, never a number.

Cards below it: Environment (V1/V2) · Trading Mode (Strategy / Manual) · Engine (Paper / Live) · Engine State · Database · Scheduler · Wallet · RPC · Gamma · Market Discovery · Binance · TWAP Provider · CLOB · Telegram · Current Trading Target · Current Position · Current TWAP · Health.

Trading Mode, Engine and Environment are shown as three distinct facts, never merged.

**Current Trading Target** — question, market ID, condition ID, settlement time, remaining countdown, liquidity, volume, YES token, NO token, current probability, best bid, best ask, mid price, current spread, minimum order size, market status, resolution source. Gamma fields are carried through as read-only metadata on `DiscoveredMarket` (no selection-logic change); book-derived fields (bid/ask/mid/spread) come from the existing CLOB book read and show "Waiting for book" until present.

**Binance** — status, BTC price, heartbeat, latency, reconnects, last update.

**CLOB** — API version, environment, authenticated, API key loaded, signature type, wallet verified, environment match, last auth time, wallet, open orders, open positions, rate-limit usage (from the existing `rate-limit.server.ts` counters), last response, latency, connection state.

**Wallet** — address, signer type (EOA / Proxy / Safe, from `POLYMARKET_SIGNATURE_TYPE`), chain ID, RPC, connection, balance where already available.

Every connection card also shows latency, reconnect count, last successful update, last error, endpoint, environment.

## 6. Empty states

One rule everywhere: every empty state states **Status**, **Reason**, **Action**, **Trading Impact**, **Expected Recovery**.

```text
Binance       Disconnected
Reason        Network timeout
Action        None — monitor
Trading       Blocked
Recovery      Automatic reconnect (backoff, next attempt 4s)

Wallet        Not Configured
Reason        WALLET_PRIVATE_KEY is unset
Action        Configure WALLET_PRIVATE_KEY in .env and restart
Trading       Blocked
Recovery      Manual — operator action required
```

Applied across `index.tsx`, `diagnostics.tsx`, `manual.tsx`, `operations.tsx`, `settings.tsx`. Every generic "connecting…/loading…/computing…" is removed.

## 7. Diagnostics as authoritative runtime page

Three tables added alongside the event log and failure harness:

1. **Boot sequence** — stage, started, duration, result, next stage.
2. **Subsystems** — state, reason, endpoint, environment, last update, mapped health.
3. **Connection history** — subsystem, connected count, disconnected count, reconnects, last failure, recovery time.
4. **Live Connection Timeline** — append-only timestamped stream of connection lifecycle events, newest last, kept for the current process and written to the existing event log:

```text
12:01:21  Binance Connected
12:01:22  Gamma Connected
12:01:23  Market Found  BTC 3PM ET
12:01:24  TWAP Connected
12:01:25  CLOB Authenticated
12:01:26  Strategy Ready
12:01:27  SPACE READY
```

5. **Environment Resolution** — proves conformance by showing what each subsystem actually resolved:

```text
SPACE_ENVIRONMENT  V1_TESTNET
  RPC         https://…amoy…     V1  OK
  Gamma       https://gamma…     V1  OK
  CLOB        https://clob…      V1  OK
  TWAP        RTDS               V1  OK
  Wallet      0x…  (Proxy)       V1  OK
  Replay      namespace v1       V1  OK
  Statistics  namespace v1       V1  OK
```

Any row whose environment differs from the header renders as a conformance failure.

## 8. Typography (desktop, exact)

Section headings 28px · Card titles 22px · Values 16–18px · Labels 15px · Sidebar 16px · Buttons 15px · Status text 15px · Inputs 16px · Selects/dropdowns 16px · Dialog/modal body 16px with 20px titles · Table rows 15px with taller row height · Tooltips 14px. Applied via base type tokens in `src/styles.css` and the shell/nav/card/form components; existing light-violet instrument design language and mono numerics preserved. Mobile scales down proportionally.

## Files expected to change

- New: `src/core/runtime/connections.server.ts`, `src/components/space/connection-card.tsx`, `src/components/space/trading-target-card.tsx`, `src/components/space/empty-state.tsx`
- Edited: `boot.server.ts`, `db/lock.server.ts`, `db/database.server.ts`, `scheduler.server.ts`, `market/discovery.server.ts`, `market/types.ts`, `feeds/binance.server.ts`, `execution/wallet.server.ts`, `execution/polymarket.server.ts`, `execution/rate-limit.server.ts`, `settlement/settlement.server.ts`, `telegram/telegram.service.ts`, `engine/loop.server.ts`, `lib/system.functions.ts`, `lib/diagnostics.functions.ts`, `routes/index.tsx`, `routes/diagnostics.tsx`, `routes/manual.tsx`, `routes/operations.tsx`, `routes/settings.tsx`, `components/space/*`, `src/styles.css`

## Verification

```text
Fresh boot
  → Mission Control fully populated (summary row + every card)
  → current BTC market visible
  → every one of the ten connections reports a real state
  → environment visible on every page and conformant across subsystems
  → Diagnostics populated (boot, subsystems, history, timeline, env resolution)
  → no placeholder text, no fake values
  → no console errors
  → no runtime errors
  → production build
  → tests
```

Driven with a Playwright pass over Mission Control and Diagnostics plus `bunx tsgo --noEmit`, `bunx vitest run`, `bun run build`. Every changed file reported at the end.
