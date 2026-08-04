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

1. **Runtime owns boot.** Move `boot()` to process start (server entry). Server functions become pure readers; if the runtime is not booted they return a `NOT_BOOTED` snapshot rather than starting it. Remove all 24 in-handler `boot()` calls.
2. **One poller.** Delete the duplicate snapshot query in `runtime-diagnostics.tsx` and feed it from `useRuntimeSnapshot`. Fold `production-panel.tsx`'s five polls and diagnostics' snapshot-derived fields into the snapshot. Keep separate queries only for replay, statistics and the manual desk, on explicit refresh or a single slow interval.
3. **Clock parity.** Compute relative times from a snapshot-supplied `generatedAt` and render them client-side only, so SSR and hydration agree.
4. **Restart-durable history.** Persist connection state changes, resource audits and events to SQLite so the timeline survives PM2 restart, environment switch and reboot.
5. **Remote-capable read path.** Expose the frozen snapshot at `/api/runtime/snapshot` and have the dashboard read from a configured runtime base URL (defaulting to same-origin), so a browser can point at a VPS runtime unchanged.
6. **Four-way verification.** Playwright over all 7 pages in Lovable Preview, Preview URL, local `bun run build && bun run start`, and VPS — identical values, zero console errors, no fabricated data.

Nothing here adds product features; it removes the ways the dashboard has started behaving like an application instead of a thin operator view.