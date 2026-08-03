# SPACE v1.0.0 — Test and Build Evidence

## Unit tests

Command: `bunx vitest run`

| Suite | Covers |
| --- | --- |
| `execution.test.ts` | Order lifecycle, retries, risk decisions |
| `failure-simulation.test.ts` | Injected failure scenarios and recovery paths |
| `lock.test.ts` | Single-instance lock acquisition and refusal |
| `market-state.test.ts` | Unified market state transitions |
| `metrics.test.ts` | Metrics sampling and persistence |
| `rate-limit.test.ts` | Venue rate limiter |
| `scheduler.test.ts` | Heartbeat, drift, task isolation |
| `startup-validation.test.ts` | Pre-ARM gate and environment conformance |
| `strategy.test.ts` | TWAP, buffers, frozen trigger, window lifecycle |

Result at release: **9 files, 52 tests, all passing.**

## Build

- `bun run build` — production build succeeds.
- VPS build uses `NITRO_PRESET=node_server bun run build`, producing
  `dist/server/index.mjs`, which is what `ecosystem.config.cjs` runs.

## Runtime verification

- Boot trace reaches Database Ready → OBSERVE → Dashboard Ready with no hang.
- Dashboard responds `200 OK` on the health endpoint and every workspace route.
- Health registry reports each component individually; missing venue secrets
  degrade to OBSERVE rather than blocking boot.

Re-run this evidence on the VPS before promotion; the numbers above are the
authoring-host baseline.