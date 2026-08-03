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
- **Exactly one poller exists for the runtime snapshot, process-wide.** It lives in the root provider; every page, panel and card subscribes to that shared cache. No page, route loader or component may start its own runtime polling, and no second interval, `refetchInterval` or `setInterval` against the snapshot is permitted. Page-specific server functions remain only for data the snapshot does not carry (operations document, statistics series, replay reconstruction, manual desk, failure harness), each with a single query key.
- Remove the duplicated snapshot queries in `console-shell.tsx`, `index.tsx` and `operations.tsx`; the shell owns the snapshot and passes it down.
- Extend `getSystemSnapshot` so it already carries everything Diagnostics needs (execution snapshot, boot trace with stage status, resource audit history, connections, timeline) — Diagnostics stops maintaining a second runtime store.

### Snapshot lifecycle (never a permanent failure screen)

The dashboard's connection to the runtime is a first-class lifecycle:

```text
CONNECTING -> WAITING_FOR_RUNTIME -> FIRST_SNAPSHOT -> LIVE
                     ^                                   |
                     +--------- RECOVERING <---- STALE <-+
```

Rules:

- The first successful snapshot is cached immediately and kept.
- A temporary polling failure never discards a valid snapshot. The screen keeps rendering the last valid values and shows a `STALE` badge with last successful update, age and reconnect attempts.
- The dashboard retries on its own and recovers automatically the moment the runtime answers again — no browser refresh, no manual action.
- `Runtime snapshot unavailable` is shown **only** when no snapshot has ever been received **and** the configured retry budget is exhausted. `Reading runtime snapshot…` and `Mission Control is waiting for the first runtime snapshot` are transitional states only, never terminal ones.

### Snapshot versioning

Every snapshot carries `snapshotVersion`, `runtimeVersion`, `schemaVersion`, `environment`, `timestamp` and a monotonic `sequence`. The dashboard rejects any snapshot with a lower `sequence` than the one it already holds, discards the cache outright when `environment` or `runtimeVersion` changes, and never renders a snapshot it has classified as stale-by-version.

### Runtime snapshot contract freeze

The runtime snapshot schema becomes the canonical interface between the engine and every UI surface. Mission Control, Operations Desk, Replay, Manual Trading, Statistics, Diagnostics and Settings consume this contract **only**. No page may bypass the snapshot by reading runtime state directly. Future field additions must be backward compatible: fields are added, never renamed or removed, and consumers tolerate unknown fields.

### Snapshot watchdog

If no snapshot has been received for 30 seconds the dashboard enters `STALE` (not `LOADING`), keeps the last known values on screen, and surfaces last successful update, time since last heartbeat and reconnect attempts.

### Runtime recovery

If the runtime process crashes or is restarted (PM2 restart, environment switch, manual STOP/START), the dashboard walks `LIVE -> STALE -> WAITING_FOR_RUNTIME -> RECOVERING -> LIVE` on its own, restoring the snapshot without a browser refresh.

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
- **Every operator page enforces a 10-second loading timeout.** Any panel still pending after 10 seconds automatically renders `<Subject> unavailable` with Reason, Action and Recovery. No page may remain in an indefinite loading state under any condition.

## 2b. Environment parity — Preview, Local, Production build, VPS

- **Production rendering guarantee:** Preview, Local Dev, Production Build and VPS render from identical runtime data through one contract, one server function and one hook. The production build is the source of truth.
- No component may render additional information only because it is running inside Lovable Preview.
- Playwright verification runs against the production build, not only the dev server.
- No page may depend on preview-only state, mocked data, seeded values or development-only providers. Nothing renders differently because `NODE_ENV` differs.
- A production build must show the identical cards, runtime information, diagnostics and operator state that Lovable Preview shows.
- When data does differ between environments, Diagnostics names exactly which runtime endpoint or snapshot field is absent, with its reason and recovery — the value is never silently blank.
- Running behind PM2 or Nginx must not remove any runtime information. Diagnostics reports the serving topology it observes.

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

### Ownership rule for connection sync

Every runtime component owns and reports its own status. `connection-sync.server.ts` becomes a pure aggregator: it collects what components have reported and nothing else. It may not infer a connection state, re-derive health, or duplicate health logic that lives in the owning module. Repeated per-service logic currently in that file moves into the owning adapters.

## 3b. Runtime health endpoint

Add a public server route `GET /api/runtime/health` returning boot stage, snapshot age, runtime lifecycle, resource audit, connection summary, environment, database, scheduler, engine and version. It is the single machine-readable runtime probe used by the dashboard, PM2, Nginx and VPS diagnostics. It exposes no secrets, no keys and no wallet material.

## 4. Deterministic boot order

Reorder `boot.server.ts` stages to exactly:

```text
Configuration -> Environment -> SQLite -> Runtime Target -> Scheduler -> Wallet
-> Polygon RPC -> Gamma -> Binance -> RTDS -> TWAP Service -> Provider Registry
-> CLOB Market WS -> Market Discovery -> Venue Selector -> Execution Venue
-> Strategy -> Risk -> Runtime Validation -> READY
```

`BootStageTrace` gains a `status` of `WAITING | RUNNING | PASSED | FAILED | SKIPPED | RETRYING`, plus `duration`, `reason`, `recovery` and `retryCount`. Diagnostics renders the full timeline, including stages that were skipped and why.

### Boot failure recovery

When a boot stage fails, Diagnostics exposes the failed stage, the captured stack, the blocking dependency, the recovery path, the retry count and the operator action. Boot never dies silently and never leaves the dashboard with an empty timeline.

## 5. Runtime validation

`runStartupValidation` splits its items into mandatory and optional:

- Mandatory (must pass for READY): Database, Scheduler, Wallet, Polygon RPC, Gamma, Binance, RTDS, TWAP, Provider Registry, Venue, CLOB WS, Execution.
- Optional (DEGRADED, never blocking): Telegram, Chainlink Streams.

The validator itself reports as a runtime card carrying its verdict and blockers.

## 6. Resource audit

Extend `resources.server.ts` to assert exactly one of: Scheduler, Engine, SQLite, database lock, Binance socket, RTDS socket, Gamma poller, TWAP service, Provider registry, Venue, CLOB socket, Telegram — with no duplicate timers, listeners, intervals, pollers or in-flight loops. The audit runs on START, STOP and SWITCH; a failure transitions the runtime to FAILED and the audit is surfaced on Diagnostics with the failing counts.

## 6b. Diagnostics additions

Diagnostics gains a snapshot-health block: snapshot age, snapshot latency, snapshot payload size, last successful snapshot, polling interval, observed polling jitter, boot duration and runtime uptime.

It also gains a **Runtime Events** monitor fed by the existing event bus, filterable by kind: `START, STOP, SWITCH, BOOT, READY, VALIDATION, SNAPSHOT, RESOURCE_AUDIT, CONNECTION_CHANGE, ORDER, POSITION, TWAP, MARKET`.

## 7. Refresh and consistency

- One polling cadence for the runtime snapshot; an environment switch invalidates every runtime query so no card survives the switch.
- The shared typography, spacing, card, badge and colour tokens already in `styles.css` are applied uniformly; no page defines local variants.
- No component unmounts because its data is missing — it renders the explicit empty state instead.
- SSR hydration, CSR hydration, PM2 restart and runtime restart all preserve the same UI tree — zero hydration mismatch warnings. Anything time- or runtime-dependent renders through the shared snapshot, never from a client-only value read during the first render.

## 8. Bug sweep and verification

Sweep and fix hydration warnings, React warnings, console errors, undefined access, duplicate polling, stale snapshots, layout overflow at narrow viewports, and any loading loop.

Verification before this phase is called done. `tsgo` clean, `vitest run` green, production build passes, plus a Playwright pass over all seven pages for each scenario below:

| Scenario | Must hold |
| --- | --- |
| Cold boot | Timeline complete, reaches LIVE |
| Warm restart | Snapshot restored without refresh |
| PM2 restart | Dashboard recovers on its own |
| Browser refresh | Same UI tree, no hydration warning |
| Runtime restart | STALE -> RECOVERING -> LIVE |
| Environment switch | Snapshot cache invalidated, no card survives |
| Network disconnect | STALE badge, last values retained |
| Runtime unavailable | Explicit card only after retry budget |
| Snapshot recovery | Automatic, no manual action |
| Duplicate polling | Exactly one snapshot request in flight |
| Duplicate websocket / timers | Resource audit passes on START, STOP, SWITCH |
| Blank pages / infinite loading | None; 10s timeout always resolves |
| Stale snapshot rendering | Older `sequence` never rendered |
| Preview vs production build vs VPS | Identical runtime state rendered |

## 9. Final acceptance gate

Phase 1 is NOT complete until every operator page — Mission Control, Operations Desk, Replay, Manual Trading, Statistics, Diagnostics and Settings — renders successfully. Each page must:

- render without loading forever
- render without placeholder text
- render without console errors
- render without React warnings
- render without hydration warnings
- render from the shared runtime snapshot
- recover automatically after a runtime restart
- display the same information in Preview, Production Build and VPS

## Technical notes

- New files: `src/lib/use-runtime-snapshot.ts` (single poller, lifecycle, watchdog, version guard), `src/components/space/async-panel.tsx` (pending / timeout / error / empty), `src/routes/api/runtime.health.ts`, `src/components/space/runtime-events.tsx`.
- Edited: `connections.server.ts`, `connection-sync.server.ts`, `boot.server.ts`, `resources.server.ts`, `validation.server.ts`, `system.functions.ts`, `operations.functions.ts`, all seven route files, `console-shell.tsx`, `mission-control.tsx`, `connection-card.tsx`, `runtime-diagnostics.tsx`.
- Untouched: strategy, risk, replay, statistics and execution decision logic.