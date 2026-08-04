# SPACE v1.0 — Release Engineering Closure

No new product functionality. This closes the six remaining Phase 4 items: finish
the accelerated soak harness, complete the release gate, run both, and publish the
evidence and the final verdict.

## 1. Accelerated soak harness

`scripts/soak.ts` today boots the runtime, samples stability and writes a JSON
record. It does not exercise anything — it only watches an idle process. Extend it
into a real accelerated soak, exposed as `bun run soak:accelerated` (plain
`bun run soak` stays as the passive long-run variant):

- **Compressed scheduler** — drive the runtime through many more scheduler cycles
  per wall-clock minute via existing tick configuration, so a 5 minute run covers
  hours of scheduling. No fake clock; the real system clock stays authoritative.
- **Reconnect storms** — repeatedly force the RTDS, CLOB market and Binance sockets
  down through the existing fault-injection targets, and assert every one comes back
  with no socket, timer or listener left behind.
- **TWAP rollover** — switch the active TWAP provider back and forth during the run
  and assert exactly one provider socket set exists afterwards.
- **Discovery rollover** — force market discovery to re-select a window repeatedly
  and assert no duplicate subscriptions accumulate.
- **Leak detection** — per-sample heap, RSS, timers, sockets, listeners, handles,
  plus growth-per-hour thresholds already in `stability.server.ts`.
- **Stability report** — one JSON record plus a readable summary with PASS/FAIL.

## 2. Release gate

`scripts/release-gate.ts` already covers TS, ESLint, tests, build, dependency
audit, secret scan, migrations, env manifest, runtime health, resource audit,
snapshot determinism, stability and V1/V2 visibility. Remaining work:

- Add the two missing checks: **replay/statistics regeneration** (replay a persisted
  window and confirm the statistics dataset regenerates identically) and
  **accelerated soak** (run the harness as a gate stage, fail on FAIL).
- Fix a real defect found during the audit: stage 1 builds with `vite build` inside
  the Lovable sandbox, where the Cloudflare preset is forced, so stage 2 would spawn
  a Worker bundle under Node. The gate must build the Node artifact the way the VPS
  does and verify the produced preset is `node-server` before stage 2 starts.
- Verify SIGTERM shutdown of the spawned runtime is clean rather than fire-and-forget.

## 3. Runtime ownership verification

Add `tests/unit/ownership.test.ts` asserting exactly one owner module for each of:
Runtime, Snapshot, Scheduler, Engine, Boot, Shutdown, Resource Audit, Validation,
Connection Registry, Provider Registry, Venue Selector. The test scans the source
for competing definitions so ownership cannot silently fork later, and the result is
recorded in the readiness report.

## 4. Evidence and final documents

Run the gate and the accelerated soak against the real Node artifact, then write:

- `docs/releases/v1.0.0/SOAK_RESULTS.md` — measured heap, RSS, CPU, sockets, timers,
  listeners, handles, scheduler drift/overlaps, reconnect counts, verdict.
- `docs/releases/v1.0.0/PRODUCTION_READINESS.md` — runtime audit, repository audit,
  security audit, performance, connection conformance (official endpoints),
  database integrity, VPS guide reference, release report, known limitations.
- `docs/releases/v1.0.0/OWNERSHIP.md` — the eleven owners, one line each.
- `docs/releases/v1.0.0/VERDICT.md` — the final statement, either
  `PRODUCTION READY (Codebase) — Operational Validation Pending` or
  `NOT PRODUCTION READY` with the blocking list.

Existing `PRODUCTION_REPORT.md`, `RELEASE_GATE.md`, `ROLLBACK.md` and
`TEST_RESULTS.md` are refreshed so no document contradicts the new evidence.

## Verdict policy

The verdict is issued on measured output only. The accelerated soak and the release
gate must both pass in this environment. The 24–48h VPS paper-trading soak is
recorded as the outstanding operational acceptance step, not as a codebase blocker —
so a clean run yields `PRODUCTION READY (Codebase) — Operational Validation Pending`.
Any failing gate check yields `NOT PRODUCTION READY` with the blockers listed
verbatim; no failure is written off as advisory.

## Technical notes

- Fault injection reuses the verified `FAULT_TARGETS` catalogue; no new injection
  points are introduced.
- The soak boots the runtime in-process through the same `boot()` PM2 uses, and
  tears down through `shutdown()`, so handle counts are meaningful.
- The gate's node build runs with the sandbox markers unset so `NITRO_PRESET`
  is honoured; on a VPS this is a no-op.
