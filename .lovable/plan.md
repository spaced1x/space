# Phase 4 — Production Hardening, VPS Readiness & Release Candidate

Architecture is frozen. No subsystem is redesigned. This phase removes debt, proves stability, and produces the release-candidate evidence pack.

## Scope note on "24-hour" verification

A literal 24-hour soak cannot run inside this build environment. Instead:

- Build a **soak harness** that drives the runtime with a compressed clock multiplier (scheduler ticks, discovery rollovers, TWAP rollovers, reconnect storms) so that a 24-hour duty cycle is executed in minutes of wall time, using the real runtime code paths (no mocks of runtime logic; only fault injection at the network edge).
- Add **continuous leak instrumentation** that runs in production too, so a real 24h VPS soak is measurable by the operator with the same numbers the harness reports.
- Report harness results as "accelerated soak" and give the operator an exact command + acceptance thresholds for the real 24h VPS run.

## Step A — Repository audit and cleanup

Automated + manual sweep, results captured in a report:

- Dead exports, unreachable branches, unused files, unused DB tables/columns, unused migrations, obsolete env vars and feature flags.
- Duplicate polling, timers, listeners, sockets, schedulers — cross-checked against the Resource Audit's expected singleton set.
- Unnecessary wrapper layers collapsed only where removal is behaviour-neutral.
- Remaining `console.*` in runtime paths routed through the structured logger (`src/lib/error-capture.ts`, `src/server.ts`, `src/core/logging/logger.ts`, `src/start.ts`, `src/routes/__root.tsx`, `src/lib/system.functions.ts` reviewed individually; boot-before-logger sites keep a documented exception).
- Zero TODO/FIXME confirmed and enforced by a lint rule so it stays zero.

## Step B — Long-running stability instrumentation

Extend `src/core/metrics/metrics.server.ts` and the snapshot with a `stability` block:

- RSS, heap used/total, external, per-hour growth slope.
- Live counts: active timers, active intervals, event-listener counts per emitter, open WebSockets, open SQLite statements/handles.
- Scheduler tick count, jitter percentiles, overlap count, missed ticks.
- Per-connection reconnect counts and uptime ratio, snapshot generation count + p50/p95 duration, CPU time delta.

Leak detection turns growth into a health signal (WARN/FAIL thresholds), surfaced in Diagnostics and included in the Resource Audit verdict.

## Step C — Fault injection and recovery verification

Extend `src/core/validation/failure-simulation.server.ts` to cover every dependency in the request list (Binance, RTDS, Gamma timeout/HTTP, Polygon RPC, wallet, Telegram, CLOB disconnect + auth failure, TWAP provider, snapshot regeneration, scheduler pause, SQLite busy, lock contention).

Each fault produces a timestamped **recovery record**: detected_at → state transition → recovery attempt(s) → restored_at → snapshot version updated. Persisted to the existing connection timeline table and rendered as a recovery timeline in Diagnostics. Any fault that recovers without a record is a test failure — no silent recovery.

## Step D — SQLite hardening

Verify and, where missing, enforce: WAL, busy_timeout, checkpoint policy, foreign_keys ON, `PRAGMA integrity_check` at boot, index coverage for the hot Replay/Statistics queries, bounded transaction duration, vacuum/growth policy, backup→restore round trip. Findings become the Database Integrity Report.

## Step E — Configuration and security hardening

- Single env manifest derived from the Zod schema: name, required/optional, default, validation, consumer module, trading impact. Cross-checked against `.env.example` and README; unused/deprecated variables removed.
- Every config failure reports variable, reason, operator action, recovery, trading impact — no generic errors.
- Security sweep: private key never leaves the signer path; credentials redacted in logs, errors, snapshot, Diagnostics, Mission Control, API responses and stack traces (redaction enforced centrally in the logger + snapshot serializer, with a test that asserts secrets never appear).

## Step F — Runtime API and dashboard production review

- Assert every API route is read-only over the snapshot; no route may boot, restart, or mutate runtime implicitly. Mutations only via CommandBus operator commands.
- Walk all 13 screens for blank cards, placeholder text, "Loading…" loops, undefined values, hydration mismatches, duplicated polling, and Preview-vs-production differences; verify each after refresh, runtime restart, PM2 restart and V1↔V2 switch using a headless browser pass against the production build.

## Step G — Performance benchmarks

Measure and record: boot time by stage, snapshot generation, scheduler/TWAP/discovery/strategy/risk/venue/order latency, replay + statistics generation, dashboard render, memory/CPU/heap, DB query timings. Thresholds recorded so regressions are detectable.

## Step H — VPS and PM2 validation

Verify graceful shutdown/restart, crash recovery, cold boot, warm restart, simulated reboot (fresh process against existing data dir), database recovery, runtime-target recovery, environment recovery, snapshot and connection recovery — all with zero operator intervention. Documented as a reproducible checklist plus the exact PM2 commands.

## Step I — Documentation and release artifacts

Update `docs/` to final state (runtime, trading, execution, venue, TWAP, snapshot, replay, statistics architecture; DB schema; connection, boot, recovery lifecycles; resource audit; validation; environment switching; V1 paper / V2 live; deployment, PM2, backup, restore, release, troubleshooting, known limitations) and publish `docs/releases/v1.0.0-rc/` with all 22 deliverables, including the five diagrams, state machine, changed-file list, migration list, env-var list, runtime commands, external dependencies, and the explicit production-readiness confirmations.

## Step J — Release gate

Encode the Step 15 checklist as an executable gate (`bun run release:gate`) that runs typecheck, lint, tests, production build, resource audit, runtime validation, snapshot determinism, leak thresholds and secret-redaction checks. The release is PASS only if the gate exits clean; any item that cannot be machine-verified is listed as an operator-signed manual item rather than silently marked pass.

## Technical notes

- Changes stay additive to instrumentation, validation, docs, and cleanup. Strategy, risk, discovery, TWAP math, scheduler behaviour, replay, statistics, venue, runtime and dashboard architecture are untouched unless a verified defect is found — each such fix will be listed separately with its evidence.
- No new migration is expected beyond one optional migration for recovery-record columns if the existing timeline table cannot carry them; it will be additive and append-only, consistent with Phase 3.
- Verification runs against `bun run build && bun run start`, not the dev server.
