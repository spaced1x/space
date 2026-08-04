# SPACE v1.0 — Runtime Ownership Verification

Every subsystem in SPACE has exactly one owning module. A second implementation
is the defect class that produces duplicate orders, duplicate timers and
phantom telemetry, so ownership is not documented on trust: it is asserted from
the source tree by `tests/unit/ownership.test.ts` and fails the release gate on
regression.

## Owners

| Subsystem | Owner | Enforced by |
| --- | --- | --- |
| Runtime process | `src/server.ts` (calls `boot()` at module load) | ownership test: no route or component may call `boot()` |
| Boot | `src/core/boot.server.ts` — `boot()` | single declaration of `export async function boot(` |
| Shutdown | `src/core/shutdown.server.ts` — `shutdown()` | single declaration |
| Scheduler | `src/core/scheduler/scheduler.server.ts` — `startScheduler()` | single declaration; no `setInterval` anywhere under `src/core/` |
| Engine loop | `src/core/engine/loop.server.ts` — `engineResources()` | single declaration; resource audit asserts `engineLoops <= 1` |
| Snapshot | `src/lib/system.functions.ts` — `getSystemSnapshot` | single declaration; every screen reads this one payload |
| Resource audit | `src/core/runtime/resources.server.ts` — `auditRuntimeResources()` | single declaration |
| Startup validation | `src/core/startup/validation.server.ts` — `runStartupValidation()` | single declaration |
| Connection registry | `src/core/runtime/connections.server.ts` — `reportConnection()` | single declaration; every adapter reports through it |
| Provider registry | `src/core/twap/registry.server.ts` — `listProviders()` | single declaration |
| Venue selector | `src/core/execution/adapter.server.ts` — `activeVenue()` | single declaration; the one place that chooses paper vs live |
| Instance lock | `src/core/db/lock.server.ts` — `lockResources()` | single declaration; runtime refuses to boot on a held lock |
| Position derivation | `src/core/execution/positions.ts` — `derivePositionTransitions()` | single declaration; positions are derived, never stored mutably |
| Sizing | `src/core/execution/sizing.ts` — `decideSize()` | single declaration; the only sizing decision in the system |

## Single-implementation invariants

| Invariant | Owner |
| --- | --- |
| Only one module opens a SQLite handle | `src/core/db/drivers/sqlite.server.ts` (`new Database(`) |
| Only one module constructs websockets | `src/core/shared/ws-client.server.ts` (`new WebSocket(`) |
| No runtime module owns a recurring timer | scheduler only; browser hooks are not runtime modules |
| No route or component boots the runtime | the runtime process owns boot |

`src/routes/api/public/health.ts` previously called `boot()` on request. That
violated runtime ownership (an HTTP caller could trigger boot) and was removed
during release engineering; the route now only reports the state of the
already-running runtime.

## Live enforcement

Beyond the static test, the running system re-checks ownership continuously:

- The resource audit runs on START, STOP, SWITCH and periodically, and fails
  the snapshot if more than one scheduler, engine loop, database handle or lock
  is live.
- The stability instrumentation grades count drift against the first sample of
  the process; any growth in handle counts is a WARN, and duplication is a FAIL.
- The scheduler counts duplicate task registrations and surfaces them in the
  snapshot; the release gate fails if the count is non-zero.
