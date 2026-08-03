# SPACE — Milestone 6 Plan

Status: **Draft for approval**. Milestones 1–5 are frozen. This plan adds no new trading strategy, risk, or execution behaviour; it hardens the existing engine for production.

---

## 1. Objective

Make SPACE production-ready: resilient to crashes, power loss, restarts, feed outages, venue failures, rate limits and clock drift; observable and controllable by a single operator through Telegram; portable through backup/restore/export; and validated end-to-end on the target VPS stack.

---

## 2. Scope

### In scope

1. **Production hardening**
   - Health auto-disarm on critical failures while ARMED.
   - Scheduler robustness (overrun handling, clock jump detection).
   - Host resource monitoring (disk, memory, CPU) as health checks.
   - Clock drift monitoring against external reference.
   - Single-instance protection (lock file / SQLite lock so clones cannot trade the same wallet).
   - Rate-limit handling for Gamma discovery and CLOB order/fill polling.
   - Long-running stability (in-memory retention limits, bounded queues).
2. **Recovery and reliability**
   - Fix orphan-order recovery: query venue open orders by market/wallet on boot and adopt or reconcile, never assume failure.
   - Idempotent restart validation.
   - Crash / power-loss / PM2-restart recovery paths.
   - Replay chain integrity verification.
   - Backup verification and restore verification.
3. **Telegram operator interface**
   - Notifications: engine state, health changes, market discovery, risk decisions, executions, critical failures, recovery, backup.
   - Commands: `/status`, `/health`, `/orders`, `/positions`, `/statistics`, `/pause`, `/resume`, `/arm`, `/disarm`.
   - All commands route through the existing Command Bus; no engine bypass.
4. **Backup / restore / export**
   - Manual backup, scheduled backup, restore.
   - Audit export, replay export, statistics export, log download.
   - Restore guarded against duplicate execution and conflicting environment/wallet.
5. **Production validation**
   - End-to-end validation.
   - Long-duration runtime test.
   - Restart, recovery and PM2 tests.
   - VPS deployment verification.
   - Performance validation.
   - Final documentation update.
6. **Internal validation and failure simulation (optional)**
   - Internal tooling for development and production verification only.
   - Failure simulation is used to validate recovery, health auto-disarm and scheduler robustness.
   - Must not become a runtime trading mode, operator mode or execution path.
   - Must not complicate the production engine.


### Out of scope

- New strategy logic, indicators, prediction models.
- New execution modes or order types.
- New markets or multi-market support.
- Multi-wallet or multi-user support.
- Cloud services, microservices, paid infrastructure.

---

## 3. Priorities

Work is ordered by risk, not by convenience:

1. **Recovery conformance** (orphan order adoption, idempotent restart, venue reconciliation).
2. **Production hardening** (rate limits, clock drift, health auto-disarm, single-instance lock, resource monitoring).
3. **Telegram operator interface**.
4. **Backup / restore / export**.
5. **Production validation and documentation**.
6. **Paper / chaos testing harness** (if time permits, strictly as validation tooling).

---

## 4. Technical approach

### 4.1 Recovery

- Add a `VenueReconciler` that runs during boot before the engine accepts `ARM`.
- Query the CLOB for open orders by wallet/market; reconcile against local `orders` table.
- Adopt orphans with a deterministic idempotency key derived from `(market, window, attempt)`; reject duplicates.
- Persist reconciliation report and divergence alerts.
- Block `ARM` until reconciliation succeeds or operator explicitly overrides after a warning.

### 4.2 Rate limiting

- Introduce a `RateLimiter` per venue endpoint (Gamma discovery, CLOB submit, CLOB fills) with configurable budget.
- On 429: backoff with jitter, surface `DEGRADED` health, block new entries, never auto-disarm with open positions.
- For order submission, treat a 429 as an indeterminate state: poll venue for the order before retrying to avoid duplicate execution.
- Pause fill-polling timeout clock during sustained rate-limit backoff.

### 4.3 Clock drift

- Compare VPS time against Binance server time and/or an NTP source every N seconds.
- Surface offset in Diagnostics and health check.
- Thresholds: warning at 1s, ARM-blocking / auto-disarm at 5s.
- Never silently apply an offset to the engine clock; only report and rely on system NTP.

### 4.4 Single-instance protection

- Create a process lock file at `DB_PATH.lock` or use SQLite `PRAGMA locking_mode` / advisory lock.
- A second process attempting to start with the same database refuses to boot and alerts the operator.
- Stamp `environment`, `chain_id`, and `wallet_address` into the database on creation; refuse to open a database whose stamp mismatches the runtime.

### 4.5 Health and resource monitoring

- Add health checks for disk free space, memory usage and CPU load.
- Define thresholds: warning and ARM-blocking.
- Auto-disarm from ARMED when a critical health check fails (e.g., venue unreachable, clock drift, disk full).
- Degraded checks block new entries but do not close existing positions.

### 4.6 Telegram

- New `telegram.adapter.ts` behind a port in the `platform` layer.
- Polls for commands; pushes notifications via the event bus.
- Chat-id allow-list from `.env`.
- Commands map 1:1 to Command Bus commands and return the same `Verdict`.
- No command executes off-loop; all are enqueued and audited.

### 4.7 Backup / restore / export

- Manual backup: hot `VACUUM INTO` snapshot to a configured directory.
- Scheduled backup: cron-like job with configurable interval and retention count.
- Restore: stop engine, replace DB file, validate stamp, resume in `OBSERVE`.
- Exports: JSON exports for audit, replay, statistics; gzip log download.
- Restore refuses to ARM until operator confirms the original instance is stopped.

### 4.8 Production validation

- Automated test suite additions: recovery scenarios, rate-limit simulation, clock-jump simulation, orphan-order reconciliation.
- Long-duration test: run for at least 24 hours against testnet/paper with simulated feeds.
- VPS test: fresh Ubuntu VM, `git clone` → `.env` → `install` → `build` → `PM2 start` → health check.
- Performance test: tick latency, feed ingestion throughput, database write latency.

---

## 5. Release criteria (definition of done)

Milestone 6 is complete only when:

1. All release-blocking architecture-review questions are answered and reflected in code or docs.
2. Orphan-order recovery (Q14) and venue rate-limit handling (Q68–72) are implemented and tested.
3. Health auto-disarm, clock drift, single-instance lock and resource monitoring are in place.
4. Telegram operator interface sends notifications and accepts all listed commands through the Command Bus.
5. Backup, restore and export flows are implemented and verified against duplicate execution.
6. End-to-end production validation passes on the target VPS stack.
7. Recovery scenarios (crash, power loss, PM2 restart) are verified.
8. Long-running stability test passes without critical defects.
9. Documentation (`SPACE_SPECIFICATION.md`, `SPACE_ARCHITECTURE.md`, runbooks) is updated.
10. No critical known defects remain.

---

## 6. Risks and assumptions

- **Assumption:** Polymarket CLOB v2 API remains stable during implementation; any breaking change will be treated as a defect and fixed.
- **Risk:** Orphan-order recovery depends on the venue exposing open orders by wallet; if the endpoint is unreliable, reconciliation may fail and block ARM.
- **Risk:** Rate-limit policies differ between testnet and mainnet; mainnet behaviour must be validated before live trading.
- **Assumption:** The operator has sole control of the VPS and will not start a second instance manually; the single-instance lock is a safety net, not a guarantee against deliberate duplication.
