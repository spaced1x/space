# Official Polymarket Conformance + Paper/Live Execution Split

Bring every external connection in line with the current official Polymarket developer documentation, and make V1 a true paper runtime that shares one identical pipeline with V2. No strategy, risk, scheduler, replay or statistics logic changes.

## What the official docs say (verified this session)

| Surface | Official value |
| --- | --- |
| Gamma API | `https://gamma-api.polymarket.com` — `/markets` limited to 300 req / 10s |
| CLOB REST | `https://clob.polymarket.com` — **no testnet/staging host is documented** |
| CLOB auth | L1 EIP-712 wallet signature → `POST /auth/api-key` or `GET /auth/derive-api-key`; L2 = HMAC-SHA256 with `POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE` |
| CLOB market WS | `wss://ws-subscriptions-clob.polymarket.com/ws/market`, subscribe `{"assets_ids":[…],"type":"market"}`, send text frame `PING` every 10s (server replies `PONG`) |
| RTDS | `wss://ws-live-data.polymarket.com` — public, no credentials, text frame `PING` every 5s |
| RTDS subscribe | `{"action":"subscribe","subscriptions":[{"topic":…,"type":"update","filters":…}]}` |
| RTDS topics | `crypto_prices` (Binance, filters `btcusdt`), `crypto_prices_chainlink`, `crypto_prices_twap_thirty`, `crypto_prices_twap_sixty` |
| RTDS TWAP payload | `{symbol, value, full_accuracy_value (E18 string), timestamp, window_s}` — `payload.timestamp` is the Chainlink observation time; no snapshot or replay after disconnect, resubscribe required |
| Chainlink Data Streams | `https://api.dataengine.chain.link` / `wss://ws.dataengine.chain.link`, feed ID + API key/secret, report schema V2 |
| CLOB trading limits | Per-signer token buckets for order vs cancel; batch is all-or-nothing; warning header `Poly-RateLimit-Warning: true` |

Two facts contradict the current code: `clob-staging.polymarket.com` is not an official endpoint, and RTDS requires no API key, secret or auth type.

## 1. Environment split — one pipeline, two executors

Market discovery, TWAP, strategy, risk, sizing, order-intent generation, scheduler and runtime lifecycle stay identical across V1 and V2. Both consume the same live production data. The only branch is the venue adapter.

```text
Gamma / RTDS / Binance -> Discovery -> TWAP Service -> Strategy -> Risk -> Order Intent
                                                                              |
                                                     +------------------------+
                                                     |                        |
                                              Paper Executor (V1)   Live CLOB Executor (V2)
                                                     |                        |
                                                     +-----------+------------+
                                                                 |
                                                  Replay / Statistics / Dashboard
```

- New `src/core/execution/paper.server.ts` implementing the existing `VenueAdapter` interface unchanged, writing ordinary order and fill rows so replay, positions, PnL and statistics behave exactly as in V2.
- Paper execution simulates the official CLOB matching behaviour rather than assuming a fill. The simulation uses the live best bid, best ask, spread and available book liquidity against the order size, and models partial fills, slippage, maker versus taker execution, cancellation, expiration and order rejection.
- The paper executor emits the same lifecycle events as the live executor, in the same order, so Replay, Statistics, Diagnostics and Positions are identical between environments.
- `src/core/execution/venue.ts` gains an environment-driven selector: `V1_TESTNET` → paper adapter, `V2_MAINNET` → `polymarketAdapter`. Nothing else in the codebase chooses an adapter.
- V1 never sends an authenticated order and does not require L2 credentials to run.
- `describe()` reports `kind: "paper"` vs `kind: "clob"` so Mission Control shows the execution mode without inventing state.
- No separate paper strategy exists. Any divergence in signals, TWAP, risk, sizing or market selection between V1 and V2 is a bug.

## 2. Endpoint conformance

- Remove `clob-staging.polymarket.com`. `POLYMARKET_CLOB_URL` defaults to `https://clob.polymarket.com` for both environments; V1 uses it for read-only book data only.
- Add a documented CLOB market WebSocket client (`src/core/market/clob-ws.server.ts`) for the discovered BTC token IDs: official subscribe frame, `PING` every 10s, resubscribe on reconnect, exponential backoff. It feeds best bid/ask into existing market state, consumed by the paper executor and the UI.
- Gamma discovery stays on `https://gamma-api.polymarket.com` with the limiter aligned to the documented `/markets` budget.

### CLOB WebSocket runtime requirements

- Automatic reconnect with exponential backoff plus jitter, bounded by a configurable retry budget.
- Resubscribe to every active asset ID after each reconnect (the stream has no replay).
- Stale-feed detection: no book or price update within a configurable timeout marks the feed STALE.
- Heartbeat watchdog on the documented `PING`/`PONG` frames; a missed `PONG` window forces a reconnect.
- Sequence validation whenever the event carries a sequence or hash; gaps are counted and exposed.
- State machine: `CONNECTED → STALE → RECONNECTING → CONNECTED`. When the retry budget is exhausted the feed reports `FAILED` with the exact reason and live execution is blocked.

### Binance feed requirements

- Official Binance WebSocket endpoint only, from configuration.
- Heartbeat monitoring, exponential backoff reconnect, automatic resubscribe to the configured symbol stream.
- Stale BTC price detection, last update timestamp and sequence, measured latency.
- Runtime state: `CONNECTED | STALE | RECONNECTING | FAILED`, surfaced in Mission Control and Diagnostics.
- Prices are never fabricated, interpolated or carried forward past the staleness threshold.

### Gamma runtime requirements

- Requests respect the documented rate limits through the shared limiter.
- Retry transient failures only (network, 5xx, 429); other 4xx responses fail fast with the reason.
- Circuit breaker after repeated consecutive failures, with recovery polling at a reduced cadence until a success closes it.
- The last successful discovery is cached and retained: a temporary Gamma failure degrades discovery health but never clears the current market.

## 3. TWAP providers — three, operator-selected

`TwapProviderId` becomes `rtds_twap_30 | rtds_twap_60 | chainlink_streams`.

| Provider | Transport | Default |
| --- | --- | --- |
| RTDS Chainlink TWAP 30s | `wss://ws-live-data.polymarket.com`, topic `crypto_prices_twap_thirty` | enabled, active |
| RTDS Chainlink TWAP 60s | same socket, topic `crypto_prices_twap_sixty` | enabled, standby |
| Chainlink Data Streams | `wss://ws.dataengine.chain.link` + feed ID and API credentials | disabled until credentials exist |

- The two RTDS providers are one adapter parameterised by topic and window; the socket sends the documented `PING` every 5s, resubscribes after every reconnect, and reports a `topic not found` response as `WAITING` with a clear reason (RTDS TWAP activates Aug 4, 2026) instead of a failure loop.
- Price is parsed from `full_accuracy_value` (E18 → decimal); `payload.timestamp` is the observation time and the outer `timestamp` feeds the latency metric. The auth-type guessing in `rtds.provider.server.ts` is deleted — RTDS is public.
- Registry gains per-provider enable/disable and ACTIVE vs STANDBY. Promotion is operator-initiated only: the operator may manually promote any enabled provider, and the registry validates freshness, latency, valid samples and a matching symbol before the promotion takes effect. If validation fails the current provider stays active and the attempt is reported. The runtime never switches providers on its own.
- Active provider and enable flags are persisted per environment (V1 and V2 keys separate, already isolated by `space-v1.db` / `space-v2.db`).
- Strategy, risk, execution, replay and statistics keep consuming the TWAP Service only. If the active provider is unhealthy the service reports it and trading is blocked; a price is never fabricated.

## 4. Operations Desk and Mission Control

Extend the existing `TwapProviderCard` and Operations Desk — no new navigation, no redesign. A "TWAP Providers" section lists all three with: enable toggle, ACTIVE/STANDBY, state (CONNECTED / WAITING / NOT_CONFIGURED / FAILED / DISABLED), endpoint, topic, symbol, environment, freshness, latency, last update, samples, sequence, errors, last error, trading impact and recovery action. Diagnostics shows the same three plus the CLOB market socket. Mission Control marks the active provider per runtime.

## 5. Rate limits from the docs

`DEFAULT_RATE_LIMITS` replaced with documented values: Gamma `/markets` 300 per 10s, CLOB general per the published table, and separate order and cancel token buckets for CLOB writes with burst equal to capacity. The adapter surfaces `Poly-RateLimit-Warning: true` as a DEGRADED signal before live enforcement begins.

## 5b. Runtime startup validation

Boot validates every subsystem in this fixed order, with no step skipped and each one reported in Diagnostics:

```text
Boot -> Configuration -> Database -> Wallet -> RPC -> Gamma -> Binance -> RTDS
     -> TWAP Provider -> Market Discovery -> Venue -> Execution -> READY
```

A mandatory subsystem that fails holds the runtime out of READY with the exact reason; optional subsystems report FAILED without blocking boot, per the frozen lifecycle rules.

## 5c. Security

Secrets never appear in logs, diagnostics payloads, Mission Control, the browser bundle or the console. Every surface reports only whether a credential is configured, never a value, prefix or length that could reconstruct it.

## 5d. Resource cleanup

Before another runtime boots, shutdown must guarantee: every WebSocket closed, HTTP clients closed, all timers cleared, polling stopped, scheduler stopped, database closed with the WAL flushed, file handles released and event listeners removed. The existing runtime resource audit is extended to cover the CLOB market socket, the shared RTDS socket and the Chainlink Data Streams socket, and a non-zero count after teardown transitions the runtime to FAILED.

## 6. Configuration contract

`.env.example` and `env.schema.ts` updated:

```
POLYMARKET_CLOB_URL=https://clob.polymarket.com
POLYMARKET_CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_CLOB_WS_PING_MS=10000
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com

RTDS_WS_URL=wss://ws-live-data.polymarket.com
RTDS_PING_MS=5000
RTDS_SYMBOL=btc/usd
RTDS_TWAP_30_ENABLED=true
RTDS_TWAP_30_TOPIC=crypto_prices_twap_thirty
RTDS_TWAP_60_ENABLED=true
RTDS_TWAP_60_TOPIC=crypto_prices_twap_sixty

CHAINLINK_STREAMS_ENABLED=false
CHAINLINK_STREAMS_WS_URL=wss://ws.dataengine.chain.link
CHAINLINK_STREAMS_HTTP_URL=https://api.dataengine.chain.link
CHAINLINK_STREAMS_FEED_ID=
CHAINLINK_STREAMS_API_KEY=
CHAINLINK_STREAMS_API_SECRET=
```

Removed: `RTDS_API_KEY`, `RTDS_API_SECRET`, `RTDS_AUTH_TYPE`, `RTDS_CHANNEL`, and the staging CLOB default. Every endpoint, topic, symbol, heartbeat interval and credential is configuration, so a venue endpoint change is an `.env` edit and a restart.

## 7. Verification

- Typecheck clean; existing 52 tests pass.
- New unit tests: RTDS TWAP frame construction and E18 payload decoding, paper executor fill simulation, adapter selection by environment.
- Live check in the terminal: V1 boots without CLOB credentials, discovers the same market as V2, the RTDS 30s provider reports its real state, and an order intent lands in the paper executor with a recorded fill, position and PnL.
- Confirm no code path references `clob-staging`, `RTDS_AUTH_TYPE` or any undocumented URL.

### VPS deployment validation

After deployment, verify: PM2 restart, cold boot, warm restart, VPS reboot recovery, runtime switching, WebSocket reconnect, SQLite recovery, lock recovery, network interruption, internet disconnect, RTDS reconnect, Binance reconnect, Gamma retry, CLOB reconnect, memory stability, CPU stability, and no descriptor, WebSocket or timer leaks.

### Final acceptance criteria — PASS ONLY IF

- V1 executes complete paper trades
- V2 executes identical live trades
- Same Strategy, Risk, TWAP, Market Discovery, Scheduler, Replay and Statistics
- Only the venue adapter differs
- RTDS, Binance, Gamma and CLOB each survive reconnect
- Runtime switching works repeatedly
- No memory leak, WebSocket leak or timer leak
- No duplicate scheduler and no duplicate engine
- Production build succeeds
- VPS deployment succeeds
- Mission Control fully operational after deployment

## Technical notes

Files touched: `src/core/config/env.schema.ts`, `.env.example`, `src/core/twap/*` (provider contract, RTDS adapter rewrite, new Chainlink Data Streams adapter, registry), `src/core/execution/venue.ts`, `polymarket.server.ts`, `rate-limit.server.ts`, new `paper.server.ts`, new `src/core/market/clob-ws.server.ts`, plus the TWAP and diagnostics UI components and `src/lib/system.functions.ts` for status plumbing. Docs under `docs/` and the README endpoint tables are updated to match.