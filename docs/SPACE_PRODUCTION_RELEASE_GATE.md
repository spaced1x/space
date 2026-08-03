# SPACE v1.0 Production Release Gate

This checklist must be completed before SPACE is considered production-ready and may trade live capital on Polymarket mainnet.

## 1. Environment & Secrets

- [ ] `.env.example` is current and every required secret is documented.
- [ ] VPS `.env` contains no operational settings (only secrets and immutable runtime facts).
- [ ] `OPERATOR_PASSWORD_HASH` is an Argon2id hash, not a plain password.
- [ ] `SESSION_SECRET` is at least 32 bytes of cryptographically random data.
- [ ] `WALLET_PRIVATE_KEY` is for a dedicated trading wallet with limited funds.
- [ ] `POLYMARKET_API_KEY`, `API_SECRET`, and `API_PASSPHRASE` are mainnet credentials when `SPACE_ENVIRONMENT=V2_MAINNET`.

## 2. Fresh VPS Install

- [ ] `git clone` succeeds on a clean Ubuntu 22.04/24.04 LTS host.
- [ ] `bun install` completes with no audit failures that affect runtime.
- [ ] `bun run build` produces `dist/` with exit code 0.
- [ ] `bun run pm2:start` starts the process and PM2 reports `online`.
- [ ] `bun run pm2:logs` shows the BOOT → OBSERVE sequence without errors.
- [ ] Nginx reverse proxy forwards `/` to `localhost:8080` and serves static assets.

## 3. Database & Persistence

- [ ] SQLite file is created at `DB_PATH` with WAL mode enabled.
- [ ] All migrations apply automatically on first boot.
- [ ] `database` health reports OK with WAL enabled and schema version current.
- [ ] Runtime state restores from `kv` table on reboot into OBSERVE (never ARMED).
- [ ] Backup directory is created and a manual backup succeeds.
- [ ] Restore from backup copies the file and the operator is instructed to restart.

## 4. Engine Lifecycle

- [ ] Boot completes in OBSERVE without auto-arming.
- [ ] `ARM` command is rejected unless engine is in OBSERVE and reconciliation succeeded.
- [ ] `DISARM` returns engine to OBSERVE from ARMED or PAUSED.
- [ ] `PAUSE` / `RESUME` work and health reflects the new state.
- [ ] `STOP` gracefully terminates the scheduler and venue connections.

## 5. Recovery & Reconciliation

- [ ] Boot-time reconciliation runs before the engine can be armed.
- [ ] Orphan orders from a previous process are adopted into local state.
- [ ] Divergences between local and venue state are logged and reported in health.
- [ ] Reconciliation failure prevents ARM and surfaces a clear error.
- [ ] Rate limiter state is reset on process restart (no stale backoffs).

## 6. Risk & Execution

- [ ] All 14 risk checks execute before any order is submitted.
- [ ] Risk failure rejects the intent and writes a `risk_decisions` row.
- [ ] Limit orders are the default; market orders require explicit mode.
- [ ] `LIMIT_THEN_MARKET` fallback submits a market order after the configured delay.
- [ ] Retry engine respects max attempts and backoff without duplicate orders.
- [ ] Fill detection updates positions and writes `fills` rows.

## 7. Market Data & Strategy

- [ ] Binance WebSocket feed connects and updates BTC price within 5 seconds.
- [ ] Chainlink RPC feed returns a price within 30 seconds.
- [ ] Polymarket discovery tracks the official BTC market.
- [ ] 5m and 15m settlement TWAPs calculate correctly against the feed.
- [ ] Frozen Window lifecycle transitions deterministically.
- [ ] Strategy generates execution intents but never submits orders unless approved.

## 8. Manual Trading

- [ ] Switching to MANUAL mode disables automatic strategy execution.
- [ ] BUY/SELL commands reuse the same risk and execution engines.
- [ ] Manual orders appear in the order book and fill monitoring.
- [ ] CANCEL_ORDER removes the order from venue and local state.

## 9. Operations Desk & Configuration

- [ ] All operational settings are editable from the UI and stored in SQLite.
- [ ] Staged changes are promoted to active only by operator action.
- [ ] Configuration validation rejects nonsensical values (negative sizes, etc.).
- [ ] No secrets are exposed in the operations desk.

## 10. Health & Monitoring

- [ ] Mission Control displays engine status, health, wallet, and PnL.
- [ ] Every health component reports OK, DEGRADED, FAILED, or DISABLED.
- [ ] Auto-disarm triggers when a critical component becomes unhealthy.
- [ ] Scheduler drift is monitored and reported.
- [ ] Runtime event log includes severity on every event.

## 11. Telegram

- [ ] `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured.
- [ ] Critical ERROR and WARNING events are forwarded to Telegram.
- [ ] Operator broadcast command queues a message and confirms in the UI.
- [ ] Failed Telegram sends are retried on the next event (manual re-send).

## 12. Internal Validation

- [ ] Failure simulation harness can inject errors into venue calls.
- [ ] Recovery path is exercised with simulated orphan orders.
- [ ] Rate limit behavior is verified under synthetic 429 responses.
- [ ] Auto-disarm fires under simulated database failure.
- [ ] 24-hour stability run completes with no unhandled exceptions or memory leaks.

## 13. Documentation & Audit

- [ ] `docs/SPACE_SPECIFICATION.md` matches the implemented behavior.
- [ ] `docs/SPACE_ARCHITECTURE.md` reflects the final topology.
- [ ] `docs/SPACE_DEPLOYMENT.md` instructions produce a working VPS.
- [ ] Final architecture audit confirms no bypass of Risk/Execution.
- [ ] Audit log contains every operator command with actor, verdict, and correlation id.

## Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Lead Architect | | | |
| Operator | | | |
| Security Review | | | |

SPACE may only leave OBSERVE for live trading after all checklist items are signed off.
