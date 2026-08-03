# Phase 1 — Runtime Foundation, UI Parity & Complete Runtime Wiring

Architecture stays frozen. No strategy, risk, replay, statistics or trading-logic changes. This phase only makes the runtime observable, deterministic and identical across preview, local dev, production build and VPS.

## What is wrong today (verified in the code)

- `src/routes/operations.tsx` renders `loading configuration…` for **every** non-success state. A failed `getOperations` call never reaches an error branch, so the Operations Desk can stay on that text indefinitely. The same success-or-nothing shape appears on `stats`, `settings`, `diagnostics` and `manual`.
- The connection registry (`src/core/runtime/connections.server.ts`) tracks only 10 connections: sqlite, scheduler, wallet, polygon_rpc, gamma, market_discovery, binance, twap_provider, clob, telegram. RTDS, Chainlink Streams, TWAP service, provider registry, CLOB market websocket, venue selector, paper venue, live venue, database lock, runtime validator and configuration are not registered, so they cannot appear as runtime cards.
- Polling is duplicated. `system-snapshot` is shared by `ConsoleShell`, `index` and `operations`, but `diagnostics`, `statistics`, `system-information`, `manual-desk` and `failure-harness` each poll separately on their own intervals, and several of those server functions re-run `boot()` and re-collect health.
- Boot in `src/core/boot.server.ts` does not follow the specified order (validation runs before scheduler and RPC verification; venue and strategy never appear as stages), and stage traces carry no status, reason or recovery.
- The resource audit checks scheduler, engine, feeds, TWAP, CLOB socket, database, lock, Telegram and the event bus — it does not check the Gamma poller, provider registry or venue.

## 1. One runtime snapshot, one API surface

- Add `src/lib/use-runtime-snapshot.ts`: a single hook wrapping `getSystemSnapshot` with one query key, one interval, and shared `status`/`error` values.
- Every operator page (Mission Control, Operations, Replay, Manual, Statistics, Diagnostics, Settings) consumes that hook for runtime state. Page-specific server functions remain only for data the snapshot does not carry (operations document, statistics series, replay reconstruction, manual desk, failure harness), each with a single query key and no duplicate polling.
- Remove the duplicated snapshot queries in `console-shell.tsx`, `index.tsx` and `operations.tsx`; the shell owns the snapshot and passes it down.
- Extend `getSystemSnapshot` so it already carries everything Diagnostics needs (execution snapshot, boot trace with stage status, resource audit history, connections, timeline) — Diagnostics stops maintaining a second runtime store.

## 2. Never a blank page, never an infinite spinner

Introduce one `AsyncPanel` wrapper used by every page section:

```text
pending  -> explicit "Reading <subject> from the runtime" state
error    -> EmptyState: Reason / Recovery / Action / Trading impact
empty    -> EmptyState: "No data observed yet"
success  -> content
```

- `EmptyState` (already in `src/components/space/empty-state.tsx`) becomes the single failure/empty renderer; its fields map exactly onto Reason, Recovery, Action and Trading impact.
- Operations Desk gets four explicit outcomes: live configuration, loading, runtime error, configuration unavailable.
- Server functions return typed failure objects where the page must stay renderable, and the query error path always produces a visible card.

## 3. Complete runtime wiring

Extend `CONNECTION_IDS` and labels to cover every service in the brief:

```text
configuration, environment, sqlite, database_lock, runtime_target, scheduler,
wallet, polygon_rpc, gamma, market_discovery, binance, rtds, chainlink_streams,
twap_service, twap_provider_registry, twap_provider, clob_market_ws,
clob_trading, venue_selector, paper_venue, live_venue, telegram,
runtime_validator
```

Each owning module reports into the registry at boot, on state change and on every scheduled sync (`connection-sync.server.ts`). Nothing is invented: an unreported connection stays `NOT_STARTED` with "No data observed yet".

Every card exposes Status, Latency, Health, Environment, Endpoint, Reconnects, Last success, Last failure, Current state, Reason, Operator action, Recovery and Trading impact — rendered by one shared `ConnectionCard`, so Mission Control, Operations Desk and Diagnostics show an identical card.

The connection state vocabulary aligns to `CONNECTED, WAITING, RECONNECTING, STALE, FAILED, DISABLED` (plus the existing `NOT_STARTED` for never-observed), each carrying heartbeat, latency, last message, retry count, reason and recovery.

## 4. Deterministic boot order

Reorder `boot.server.ts` stages to exactly:

```text
Configuration -> Environment -> SQLite -> Runtime Target -> Scheduler -> Wallet
-> Polygon RPC -> Gamma -> Binance -> RTDS -> TWAP Service -> Provider Registry
-> CLOB Market WS -> Market Discovery -> Venue Selector -> Execution Venue
-> Strategy -> Risk -> Runtime Validation -> READY
```

`BootStageTrace` gains `status`, `reason` and `recovery` alongside the existing start/finish/duration. Diagnostics renders the full timeline, including skipped stages and why they were skipped.

## 5. Runtime validation

`runStartupValidation` splits its items into mandatory and optional:

- Mandatory (must pass for READY): Database, Scheduler, Wallet, Polygon RPC, Gamma, Binance, RTDS, TWAP, Provider Registry, Venue, CLOB WS, Execution.
- Optional (DEGRADED, never blocking): Telegram, Chainlink Streams.

The validator itself reports as a runtime card carrying its verdict and blockers.

## 6. Resource audit

Extend `resources.server.ts` to assert exactly one of: Scheduler, Engine, SQLite, database lock, Binance socket, RTDS socket, Gamma poller, TWAP service, Provider registry, Venue, CLOB socket, Telegram — with no duplicate timers, listeners, intervals, pollers or in-flight loops. The audit runs on START, STOP and SWITCH; a failure transitions the runtime to FAILED and the audit is surfaced on Diagnostics with the failing counts.

## 7. Refresh and consistency

- One polling cadence for the runtime snapshot; an environment switch invalidates every runtime query so no card survives the switch.
- The shared typography, spacing, card, badge and colour tokens already in `styles.css` are applied uniformly; no page defines local variants.
- No component unmounts because its data is missing — it renders the explicit empty state instead.

## 8. Bug sweep and verification

Sweep and fix hydration warnings, React warnings, console errors, undefined access, duplicate polling, stale snapshots, layout overflow at narrow viewports, and any loading loop.

Verification before this phase is called done:

- `tsgo` clean, `vitest run` green, production build passes.
- Playwright pass over all seven pages: no blank page, no infinite loading, no placeholder value, every runtime card populated or explicitly "No data observed yet", zero console errors, zero React/hydration warnings.
- Boot timeline complete on Diagnostics; resource audit passes on START, STOP and SWITCH.

## Technical notes

- New files: `src/lib/use-runtime-snapshot.ts`, `src/components/space/async-panel.tsx`.
- Edited: `connections.server.ts`, `connection-sync.server.ts`, `boot.server.ts`, `resources.server.ts`, `validation.server.ts`, `system.functions.ts`, `operations.functions.ts`, all seven route files, `console-shell.tsx`, `mission-control.tsx`, `connection-card.tsx`, `runtime-diagnostics.tsx`.
- Untouched: strategy, risk, replay, statistics and execution decision logic.