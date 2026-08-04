# Pre-Phase 2 Runtime Architecture Review

Answers below come from reading the current code, not assumptions. Each answer names the files that prove it.

## 1. Is every runtime screen reading directly from the runtime snapshot?

No. Only Mission Control (`src/routes/index.tsx`) and Operations Desk (`src/routes/operations.tsx`) use the shared `useRuntimeSnapshot` hook. Every other screen keeps its own fetch and its own React Query cache:

| Screen / component | Own server call | Own poll |
| --- | --- | --- |
| stats.tsx | getStatistics | 10s |
| settings.tsx | getSystemInformation | 30s |
| replay.tsx | getReplayMarkets / getReplayMarket | 30s |
| manual.tsx | getManualDesk | 2s |
| diagnostics.tsx | getFailureHarness / getDiagnostics | 10s / 3s |
| runtime-diagnostics.tsx | getSystemSnapshot (second copy) | 5s |
| production-panel.tsx | 5 separate calls | 5s / 5s / 30s / 5s / 30s |

`runtime-diagnostics.tsx` is the worst case: it re-fetches the same frozen snapshot under a different query key, so two caches of one source of truth can disagree on screen at the same moment.

## 2. Is any Lovable backend becoming a second source of truth?

No. There is no Supabase, no Lovable Cloud, no external backend. All `createServerFn` handlers execute inside the same Node process as the trading runtime and read the runtime's own in-process state and its SQLite file. Nothing to remove.

The real risk is different: the web layer is not a second *store*, but it has become a second *owner* (see 8).

## 3. Does every screen behave identically across Preview, Preview URL, Local Production, VPS?

Unverified, and one structural reason it can differ: relative-time strings are computed in the browser from `Date.now()` (`connection-card.tsx`, `connection-history.tsx`, `twap-provider-card.tsx`, `trading-target-card.tsx`). Server render and client render produce different text, so SSR output and hydrated output disagree in every environment. Nothing else is environment-conditional — no `import.meta.env` branching anywhere in `src`. Full four-way verification has not been run and is scheduled below.

## 4. Is polling duplicated?

Yes — 11 independent pollers as listed in section 1, plus the snapshot hook. Ownership decision: **`useRuntimeSnapshot` is the only poller for runtime state.** Non-runtime reads that are genuinely different data (replay reconstruction, statistics aggregation, manual order book) may keep their own query, but must not re-read anything already present in the snapshot.

## 5. Is every runtime value coming from the trading runtime?

Yes, with these exceptions — all of them clock arithmetic, none of them fabricated telemetry:

1. `connection-card.tsx` — "x ago" from browser clock
2. `connection-history.tsx` — same
3. `twap-provider-card.tsx` — same
4. `trading-target-card.tsx` — countdown to window open from browser clock
5. `index.tsx` — event timestamps via `toLocaleTimeString()`
6. `components/ui/sidebar.tsx` — `Math.random()` width in an unused shadcn skeleton

No numeric metric, latency, price, or status is generated in React.

## 6. Does the runtime snapshot survive?

| Event | Survives | Missing |
| --- | --- | --- |
| Browser refresh | Yes | — |
| Browser reconnect | Yes | — |
| PM2 restart | No | `snapshotSequence` resets to 0; event bus ring buffer, connection timeline (300 entries) and resource-audit history are module-level arrays, all lost |
| V1 to V2 switch | No | same in-memory buffers cleared |
| VPS reboot | No | same, plus uptime baseline |

What is missing: connection state changes, resource audits and the event bus are never written to SQLite, so operator history is amnesiac across every restart. The database itself (orders, settlements, metrics, snapshots) does survive.

## 7. Runtime information visible only in Lovable Preview?

None found in code — there is no preview-only branch. Confirmation still requires the production-build run in the verification step.

## 8. Does any page call boot()?

Yes, and this is the most important finding. `boot()` is called from **24 sites** across every dashboard server function: `system.functions.ts` (11), `diagnostics.functions.ts` (3), `manual.functions.ts` (2), `replay.functions.ts` (2), `operations.functions.ts` (2), `stats.functions.ts`, `settings.functions.ts`, and both API health routes. Opening a browser tab is currently what starts the trading runtime. That inverts ownership: the runtime must boot itself at process start and the dashboard must only ever read.

## 9. Can the dashboard drive a remote runtime on a VPS?

No. Three hard assumptions block it:

- Every read goes through `createServerFn` RPC, which executes in the process serving the page — the dashboard cannot address a different host.
- Telemetry is read from module-level memory in that same process (`connections.server.ts` registry, `state/store.ts`, `bus/events.ts`).
- The database is opened from a local file path, and `peek.server.ts` reads the other environment's file off the same disk.

The only host-addressable surface today is `/api/runtime/health`. Making the dashboard remote-capable means the runtime exposes its snapshot over HTTP and the dashboard fetches it from a configured base URL.

## 10. Dependency diagram

```text
  Trading Runtime (single Node process, PM2)
    engine loop / scheduler / feeds / venue / TWAP
              |  writes
              v
    in-process state ......... SQLite (space-v1.db | space-v2.db)
    runtime store                orders, settlements, metrics,
    connection registry          snapshots, releases
    event bus, audits
              |
              |  read-only assembly
              v
    getSystemSnapshot  <-- THE single source of truth (SNAPSHOT_VERSION 1)
              |
              |  RPC (same process today)
              v
    useRuntimeSnapshot (one poller, 5s, CONNECTING/LIVE/STALE/RECOVERING)
              |
              v
    React panels (pure presentation)
```

Confirmed: `getSystemSnapshot` is the single source of truth for runtime state. It is currently bypassed by 10 side-channel fetches and one duplicate snapshot fetch, which is what Phase 2 prep must close.

## Corrective work before Phase 2

### 1. Runtime startup contract — the runtime is fully independent of the dashboard

PM2 starts SPACE. SPACE boots itself. The runtime reaches READY on its own and begins operating. The dashboard may connect at any time afterwards, or never.

- Opening a browser must NOT start the runtime.
- Closing every browser tab must NOT stop the runtime.
- Refreshing the browser must NOT restart the runtime.
- If no dashboard ever opens, the runtime keeps trading.

`boot()` moves to the process entry point and is invoked exactly once there. All 24 in-handler `boot()` calls are removed. A read that arrives before READY returns the current lifecycle state (including `NOT_BOOTED`) — it never triggers a boot.

### Dashboard isolation

The dashboard is a read-only operator terminal. Dashboard failures must never affect the runtime.

- If the browser disconnects, the runtime continues operating normally.
- If React crashes, the runtime continues operating normally.
- If the dashboard cannot reach the runtime, the runtime continues operating normally.
- If `/api/runtime/snapshot` temporarily fails, the runtime continues operating normally.
- If every browser tab is closed, the runtime continues operating normally.

The trading engine, scheduler, feeds, TWAP service, venue, replay and statistics never depend on the dashboard. The dashboard never owns any runtime state.

### 2. The snapshot API is the only runtime API

Two endpoints, and nothing else, may be read by any page:

- `GET /api/runtime/snapshot` — the frozen snapshot
- `GET /api/runtime/health` — machine-readable health

Enforced rules:

- No page may import a runtime module.
- No page may import or read runtime in-process state.
- No page may call `boot()`.
- No page may touch SQLite.
- Every runtime value on every screen is derived from those two responses.

Existing per-page server functions that read runtime state are deleted or reduced to non-runtime data (replay reconstruction, statistics aggregation, manual desk book). Commands remain a separate write path through the command bus. An import guard (lint rule / import-boundary check) keeps pages from reaching into `src/core` again.

### 3. Snapshot versioning and ordering

Every snapshot carries: `snapshotVersion`, `runtimeVersion`, `buildVersion`, `environment`, `generatedAt`, `sequence`.

- A snapshot with an unknown or older `snapshotVersion` is rejected, not rendered.
- A snapshot whose `sequence` is lower than the one already held is discarded.
- The browser only ever renders the newest accepted snapshot.

### Runtime data integrity

No mocked runtime values. No placeholder telemetry. No fabricated connection states. No synthetic prices. No fake health values. No estimated execution status.

If the runtime has not yet observed a value, the snapshot reports that explicitly together with its reason. Every value rendered anywhere in the operator terminal must originate from the runtime snapshot.

### 4. Abstract transport (future-proofing)

The dashboard reads through a single transport interface — subscribe to snapshots, receive snapshots. Today it is implemented by polling. Tomorrow a WebSocket snapshot stream replaces the implementation with no change to any page or panel.

### 5. No runtime logic in React

React renders. It never computes strategy, risk, health, validation, execution outcomes, connection state, provider selection, or runtime status. Every such value arrives already decided by the runtime. Any derived field a panel wants is added to the snapshot, not calculated in a component.

### 6. Time originates in the runtime

Every timestamp, age, countdown and duration is produced by the runtime and shipped in the snapshot. The browser formats strings only. No `Date.now()` for runtime values, no runtime state derived from browser time. This removes the SSR/hydration mismatch in `connection-card.tsx`, `connection-history.tsx`, `twap-provider-card.tsx`, `trading-target-card.tsx` and `index.tsx`.

### 7. Runtime history persistence

Persist to SQLite so Diagnostics survives every restart: runtime lifecycle transitions, boot timeline, connection history, resource audits, runtime validation results, provider switches, environment switches, TWAP provider changes, runtime failures, runtime recoveries.

### 8. VPS deployment requirement

Identical behaviour on Lovable Preview, the Preview URL, `bun run build`, PM2 on the VPS, behind an Nginx reverse proxy, and behind Cloudflare later. No environment-specific code, no preview-only behaviour, no localhost assumptions, no hot-reload assumptions, no embedded-runtime assumptions. The dashboard reaches the runtime through a configured base URL defaulting to same-origin, so it can also view a remote VPS runtime unchanged.

The operator terminal must render identically on:

- Lovable Preview
- Lovable Preview URL
- Local Production (`bun run build && bun run start`)
- VPS (PM2)
- VPS behind Nginx
- VPS behind Cloudflare (future)

Mission Control, Operations Desk, Replay, Manual Trading, Statistics, Diagnostics and Settings must display identical layouts, runtime cards, timelines, connection states, typography and behaviour.

There must be no Preview-only rendering, Preview-only runtime behaviour, VPS-only rendering or environment-specific UI logic.

### 9. Acceptance criteria

Phase 2 is not complete until all of these hold:

- Runtime starts without a browser.
- Browser reconnects instantly.
- Browser refresh loses nothing.
- Runtime survives browser close.
- Runtime survives PM2 restart.
- Runtime survives V1/V2 switching.
- Snapshot API remains the single source of truth.
- Zero duplicate polling.
- Zero duplicate runtime state.
- Zero dashboard-owned runtime logic.
- Zero browser-owned runtime state.
- Production build identical to Preview.
- VPS identical to Preview.
- No React warnings, no hydration warnings, no console errors.
- Runtime continues operating after every browser tab is closed.
- Dashboard restart never restarts the runtime.
- Runtime never depends on React.
- Runtime never depends on browser state.
- No mocked runtime values.
- No fabricated telemetry.
- No placeholder runtime data.
- Every displayed value originates from the runtime snapshot.
- Preview, Production and VPS display identical runtime information.

Verified by Playwright across all 7 operator pages in Lovable Preview, the Preview URL, local `bun run build && bun run start`, and the VPS.

Nothing here adds product features; it removes the ways the dashboard has started behaving like an application instead of a thin operator view.