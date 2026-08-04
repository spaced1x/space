# Phase 2 — Trading Runtime Completion & Live Operator Visibility

Scope is locked to the four-phase roadmap: this is Phase 2 only. No new features, no
architecture changes, no strategy/risk algorithm changes except to fix defects found here.

## Invariants carried forward (unchanged)

Runtime is the only source of truth; the dashboard is a read-only projection of one
runtime snapshot. One engine loop, one scheduler, one active venue adapter, one active
TWAP provider. No mocked values, no placeholder runtime state, no Preview-only behaviour.

## Step 1 — Official connection conformance report (no code changes)

Produce `docs/SPACE_CONNECTION_CONFORMANCE.md`: one row per connection — Gamma REST,
Gamma discovery, Binance WS, RTDS WS, RTDS TWAP 30, RTDS TWAP 60, Chainlink Streams,
CLOB REST, CLOB market WS, CLOB trading, Polygon RPC, wallet, Telegram — with the
documented endpoint, subscription/auth format, heartbeat, reconnect and retry policy,
timeout, stale threshold, rate limits and shutdown/cleanup, next to what the code does
today, and a PASS / DISCREPANCY verdict. Sources: current official Polymarket, Binance,
Chainlink and Telegram docs fetched during this phase. Discrepancies are listed first
and fixed only after the report exists.

## Step 2 — RTDS root cause (highest priority)

The socket connects but no sample reaches the TWAP service. Instrument and walk the
chain end to end, stopping at the first failing stage:

```text
RTDS frame -> ingest/parse -> topic dispatch -> provider accept ->
TWAP service sample -> strategy TWAP -> snapshot -> dashboard
```

Checks: subscription acknowledgement frame, exact topic names
(`crypto_prices_twap_thirty` / `crypto_prices_twap_sixty`), the `filters` encoding for
the symbol, real payload field names vs. the `full_accuracy_value` / `value` /
`timestamp` / `window_s` parser, E18 decode, envelope shape, PING cadence, and whether
resubscribe after reconnect actually reaches the server. Capture raw frames from a live
connection to settle each question with evidence rather than inference.

Outcome is one of: a parser/subscription defect that gets fixed, or a documented
`WAITING` reason surfaced on the TWAP card if Polymarket is not serving the topic. No
workarounds, no synthetic samples, no silent fallback.

## Step 2.5 — End-to-end trading pipeline verification

Instrument and verify the complete pipeline with live runtime data, in both environments:

```text
Gamma Discovery -> Market Selection -> RTDS / TWAP Provider -> TWAP Service ->
Strategy -> Risk -> Order Intent -> Venue Selector ->
Paper Venue (V1) or Live CLOB Venue (V2) ->
Position Manager -> Replay -> Statistics -> Runtime Snapshot -> Dashboard
```

Every stage reports: current state, input, output, latency, last successful execution,
last failure, waiting reason and recovery. Every stage is visible in Diagnostics. No
stage may silently stop processing — if a stage blocks, the operator sees where and why
immediately.

## Step 3 — Runtime data flow audit

For every Mission Control and Diagnostics card, record `runtime source -> snapshot field
-> component -> displayed value` in `docs/SPACE_RUNTIME_DATA_FLOW.md`. Any value that
does not trace back to a snapshot field is a defect: either route it through the snapshot
or delete it.

## Step 4 — Trading engine visibility

Extend the snapshot and the existing cards (no new pages, no redesign) so the operator
sees, live:

- Strategy: active strategy, current window, PTB, confidence, direction, settlement TWAP, trigger, waiting reason.
- Risk: verdict, blocked reason, sizing, limits, exposure, emergency stop, validation result.
- Discovery: markets scanned, BTC markets found, current market, next discovery, latency, last refresh, failures.
- Execution: selected venue, paper/live, venue state, intent, submission, ack, fills, cancels, retries.
- Scheduler: active jobs, next execution, drift, missed executions, recovery.

Also expose the four lifecycles explicitly, each as a single runtime-owned state value:

- Order: created, submitted, acknowledged, partially filled, fully filled, cancelled, expired, rejected, settlement complete.
- Position: waiting, opening, opened, partially closed, closed, settled.
- TWAP: provider selected, warming, collecting samples, active, stale, recovering.
- Venue: disconnected, connecting, authenticated, ready, degraded, reconnecting.

## Step 5 — Snapshot completion and single poller

Every operator page renders exclusively from `useRuntimeSnapshot`. The remaining
independent `useQuery` pollers on operations, settings, manual, diagnostics and the
production panel are folded into the snapshot; only replay reconstruction and historical
statistics keep their own APIs. Snapshot version is bumped and the frozen contract in
`system.functions.ts` updated in one place.

## Step 6 — Preview vs. deployed parity

Diagnose why the deployed build shows less runtime information than Preview — expected
candidates are SSR/prerender running without a booted runtime, and snapshot fields lost
in the production bundle — and fix the root cause. No Preview-only branches. Mission
Control, Operations, Diagnostics, Runtime, Trading, Positions and Connections must render
identically in Preview, Preview URL, local production build and VPS.

Parity is proven on the data, not the pixels: capture the runtime snapshot JSON from all
four environments and diff the field sets directly. Every difference is reported before
any implementation work begins.

## Step 7 — Runtime health model

Every dependency reports exactly one of CONNECTED / WAITING / RECONNECTING / STALE /
FAILED / DISABLED, together with latency, heartbeat, reconnect count, last message, last
success, last failure, the operator action, the recovery path and the trading impact.
Health strings are produced by the runtime, never composed in React.

Every transition (CONNECTED -> WAITING -> RECONNECTING -> FAILED -> RECOVERED) is
timestamped, persisted to SQLite and shown in Diagnostics. Health history survives a
process restart.

## Step 8 — Bug sweep

Missing cards, missing V2 information, stale values, duplicated runtime state or polling,
values that never refresh, broken loading states, hydration mismatches, console warnings,
undefined fields, layout inconsistencies, parity gaps.

## Step 8.5 — Runtime recovery testing

Fault-inject each dependency and confirm the runtime recovers without operator
intervention: RTDS disconnect, Binance disconnect, Gamma timeout, RPC timeout, wallet
unavailable, CLOB disconnect, Telegram unavailable. For each: reconnect, state recovery,
scheduler recovery, snapshot recovery and a Diagnostics update. A runtime restart is only
acceptable where recovery is genuinely impossible, and that case must be documented.

## Step 9 — Verification gate

Phase 2 passes only when: RTDS publishes real samples or reports the documented WAITING
reason; every connection is verified against official docs; every Mission Control value
comes from the snapshot; V1 and V2 show identical operator information; the four
environments render identically (Playwright against `bun run build && bun run start`);
no duplicated polling, state, sockets, schedulers, timers or listeners; TypeScript clean;
59+ tests passing; production build passes; zero React, hydration and console warnings.

Additionally verified: a complete paper trade from discovery through settlement; the full
live execution path exercised without placing a real order when credentials are absent;
V1 and V2 produce identical strategy decisions with only the execution adapter differing;
and the runtime snapshot survives browser refresh, dashboard reconnect, PM2 restart and
V1 <-> V2 switching.

## Final deliverables

- Updated runtime architecture diagram
- Trading pipeline diagram
- Runtime connection diagram
- Complete list of fixed bugs
- Remaining known limitations
- Production readiness report

## Technical notes

- Files most affected: `src/core/twap/rtds-socket.server.ts`, `rtds.provider.server.ts`, `service.server.ts`, `src/core/runtime/connections.server.ts`, `src/lib/system.functions.ts`, `src/lib/use-runtime-snapshot.ts`, the `src/components/space/*` cards, and the operator routes.
- Snapshot shape changes are additive; `SNAPSHOT_VERSION` and `EXPECTED_SNAPSHOT_VERSION` move together.
- Already observed and to be confirmed in Step 2: `RTDS_WS_URL` in `.env.example` ships blank while the schema defaults to `wss://ws-live-data.polymarket.com`, so a deployed `.env` can start the provider in a "missing configuration" state.
