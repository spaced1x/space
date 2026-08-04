# Phase 3 — Trading Engine Verification, Execution Integrity & Operator Control

Goal: finish the trading bot, not the dashboard. By the end of this phase V1 (Paper) trades exactly the way V2 (Live) would, with the execution adapter as the only difference.

Architecture invariants are unchanged: runtime is the only source of truth, the dashboard is a read-only projection of the single runtime snapshot, one engine loop, one scheduler, one active venue, one active TWAP provider, no mocked or placeholder runtime values.

## Confirmed starting position

Verified by reading the code before writing this plan:

- The pipeline view added in Phase 2 covers 11 stages. It does not yet cover position sizing, replay, statistics, or manual trading, and it reports latency/last-success but not execution duration, next execution, or owning module.
- The `orders` table stores only the **current** `state` column plus `created_at` / `updated_at` / `submitted_at` / `terminal_at`. There is no per-transition history, so an order that passes through SUBMITTED and PARTIAL_FILL leaves no persisted trace of those steps.
- There is **no positions table**. Positions are reconstructed in memory from the immutable `fills` rows, so position lifecycle is lost on restart and cannot be replayed transition-by-transition.
- Risk (`src/core/execution/risk.ts`) validates a size that is handed to it; it does not compute one. Sizing lives in execution config, so there is no single sizing decision object shared by V1, V2 and manual trading.
- Manual trading already routes through `submitManualIntent` into the same execution engine — this is correct and must be preserved, but it is not yet proven equivalent to the automatic path.

## What gets built

### 1. Order transition ledger (new migration)

A new `order_transitions` table: order id, intent id, from-state, to-state, at, venue order id, filled size, price, reason, error. Every state change writes a row inside the same transaction that updates `orders`, so a transition can never be applied without being recorded.

`order_transitions` are append-only. Transitions may never be updated or deleted; a correction is represented as a new transition. The `orders` table remains the current-state projection and the transition ledger becomes the historical truth. Database triggers enforce this the same way they already do for `fills`.

The lifecycle is normalised to the requested vocabulary — CREATED, VALIDATED, READY, SUBMITTED, ACKNOWLEDGED, PARTIALLY_FILLED, FILLED, SETTLED, with REJECTED / CANCELLED / EXPIRED / FAILED / RECOVERING as alternative terminals — mapped from the existing internal `OrderState` so no strategy or venue code changes meaning. Illegal transitions throw rather than silently applying.

### 2. Position transition ledger (same migration)

No mutable positions table is introduced. `fills` remains the canonical execution record and the current position stays derived from fills — the existing and correct architecture.

Only an append-only `position_transitions` ledger is added, recording lifecycle changes: opening, opened, increasing, reducing, partially closed, closed, settled. If a transition can be regenerated from fills after restart, it must regenerate identically; a test asserts the regenerated ledger matches the persisted one exactly.

Each position exposes market, token, side, quantity, average price, current price, realised PnL, unrealised PnL, fees and execution latency, all derived from the runtime's own records.

### 3. Single sizing decision

Extract sizing into one `sizing` module that produces an explicit decision object (requested size, applied size, cap that bound it, exposure before and after, reason). Automatic trading, manual trading and both venues consume that one function. The decision is attached to the order intent, persisted with the risk verdict, and surfaced in the snapshot.

### 4. Parity harness

Every completed strategy evaluation records its decision tuple: discovered market, selected market, direction, PTB, confidence, settlement TWAP, trigger, risk verdict, sizing, order intent — stamped with the environment that produced it.

Paper and Live decisions are compared automatically whenever both environments have evaluated the same market window. Differences are persisted as parity failures and surfaced in Diagnostics. Parity failures never modify trading behaviour; they are operator diagnostics only. A test additionally drives the same inputs through the paper adapter and the live adapter in dry-run mode and asserts every field except the adapter identity matches.

### 5. Pipeline completion

Extend the Phase 2 pipeline stages to the full 16-stage list, adding position sizing, order lifecycle, replay and statistics, and adding the missing per-stage fields: execution duration, next execution, owning module. Diagnostics continues to name the single blocking stage and why.

### 6. Replay and statistics reconciliation

Replay reconstructs market, TWAP, PTB, signal, order, fill, position, settlement and PnL from persisted rows only — now possible because transitions are persisted. A reconciliation check compares statistics against replay for the same trade set and reports any divergence as a runtime health failure rather than letting the two drift silently.

### 7. Scheduler reporting

Every task reports owner, interval, drift, runtime, last run, next run, skipped runs, failures and recovery, and the scheduler asserts a task is never registered twice.

### 8. Stress verification

A harness runs 100 discovery cycles, 100 TWAP updates, 100 scheduler cycles, repeated market and window rollovers and repeated provider reconnects against the live runtime without restarting it, then asserts through the existing resource audit that timers, sockets, schedulers and event listeners return to their expected counts and heap does not grow monotonically.

### 9. Bug sweep

Execution inconsistencies, paper/live differences, stale order and position state, replay and statistics mismatch, scheduler drift, incorrect lifecycle transitions, UI values not refreshing, and any remaining placeholder value.

## Verification gate

Phase 3 passes only when a complete paper trade runs discovery through settlement; the live path is verified without placing a real order when credentials are absent; V1 and V2 produce identical strategy, risk and sizing decisions with only the adapter differing; replay reconstructs every completed trade and statistics match it; every order and position transition is persisted and visible; the scheduler is stable with no duplicate timers, sockets or listeners; TypeScript is clean; all tests pass; the production build succeeds; and there are zero React, hydration and console errors.

## Deliverables

Reports written under `docs/phase-3/`: trading pipeline verification, paper vs live parity, order lifecycle, position lifecycle, replay consistency, statistics consistency, scheduler verification, bugs fixed, and the remaining items handed to Phase 4 (production hardening, long-running stability, deployment, security, stress testing, release readiness).

## Note on live settlement timing

Gamma currently publishes BTC up/down windows whose settlement is roughly a day ahead of this environment's clock, so an unattended end-to-end paper trade may not trigger naturally within a working session. The verification will drive a real trade through the real pipeline using a real discovered market with the runtime clock advanced to the window — the clock is the only thing simulated, never the data, the venue or the decisions.
