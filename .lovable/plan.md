# Milestone 7 — Production Validation & v1.0 Release Gate

No new trading features. This milestone makes SPACE deployable and provable on the real VPS, and closes the three gaps found in the full-repository review.

## Review findings (verified)

- The engine, strategy, execution, risk, replay, statistics, operations and backup layers are wired end to end; the production build serves and all 48 unit tests pass. The `loadRuntimeState` runtime error was a stale preview module, not a code defect.
- Local operator auth exists only as `OPERATOR_PASSWORD_HASH` / `SESSION_SECRET` in the env schema, `.env.example` and two docs. No login route, session or middleware was ever built.
- Telegram is outbound only: event forwarding plus an audited outbox. No inbound command path.
- Nothing prevents two PM2 processes opening the same SQLite file and trading twice from one set of credentials.

## 1. Remove authentication from v1.0

SPACE is a single-operator appliance; the VPS handles access control.

- Drop `OPERATOR_PASSWORD_HASH` and `SESSION_SECRET` from the env schema and `.env.example`.
- Remove the auth sections from the specification, deployment guide and release gate; replace with an explicit "access control is external (SSH, firewall, Nginx, VPN)" statement plus a short note that an auth layer can be reintroduced at the router root without touching engine code.
- The dashboard opens directly. No login page, cookie, timeout or re-auth anywhere.

## 2. Single-instance lock

- Acquire an exclusive lock next to the database file at boot (`space.db.lock`, PID plus start time).
- A second process refuses to boot with a clear message naming the holder, rather than corrupting state or double-trading.
- Lock released on clean shutdown; a stale lock from a dead PID is reclaimed automatically.
- Surfaced as a health component and released in the shutdown sequence.

## 3. Telegram permission modes (operator-configurable)

Stored in the database, editable from the Operations Desk, effective immediately, default `SAFE_CONTROLS` on every fresh install.

| Mode | Allows |
| --- | --- |
| `READ_ONLY` | status, health, statistics, orders, positions, replay, diagnostics |
| `SAFE_CONTROLS` (default) | read-only plus pause, resume, disarm, backup |
| `FULL_OPERATOR` | everything the dashboard can do: arm, disarm, pause, resume, manual buy UP/DOWN, backup, restore, configuration, strategy and Operations Desk controls |

Rules that hold in every mode:
- Chat-ID allow-list is mandatory; messages from any other chat are dropped and logged.
- Every Telegram command is translated into a Command Bus command — no direct service calls — so the audit log records source, chat ID, correlation ID and outcome.
- A command rejected by the active mode replies with the reason and is audited as denied.
- The Operations Desk shows the active mode and the allow-listed chat ID.

## 4. Inbound Telegram command path

- Long-polling receiver (`getUpdates`) started at boot only when a bot token and chat ID are present; absence degrades the component to `DISABLED`, never blocks boot.
- Command parsing, allow-list check, permission-mode check, then Command Bus dispatch, then a reply with the result.
- Backoff and health reporting on Telegram API failures; Telegram is never on the trading critical path.

## 5. Internal validation & failure simulation

Executed against the existing failure-simulation harness and recorded as a signed-off report in `docs/`:

- Crash during order submission, then reboot: reconciliation adopts the orphan, no double execution.
- Binance disconnect, Chainlink RPC failure, Polymarket 429 storm, clock drift beyond threshold: each degrades health and auto-disarms where specified.
- Database locked / disk full / log rotation at cap.
- Restart while ARMED: the engine returns to OBSERVE and requires an explicit ARM.
- Backup taken, database restored into a clean directory, engine boots and reconciles from the restored state.

## 6. Staged VPS rollout

Documented as the operational runbook, executed in this order:

1. Deploy to the production VPS: `git clone` → `.env` → `npm ci` → `build` → PM2 → Nginx.
2. Configure real Polymarket credentials with `SPACE_ENVIRONMENT=V1_TESTNET`.
3. Verify each subsystem live: Polymarket auth, market discovery, Binance feed, Chainlink feed, TWAP, Frozen Window strategy, risk engine, execution engine, recovery, Telegram, backup/restore, replay.
4. Restart, recovery and long-duration soak (24h minimum) with drift, memory, disk and event-log growth recorded.
5. Only after every gate item passes and you give final approval does `V2_MAINNET` get enabled.

The release gate document is updated so V2 activation is an explicit, checklisted operator action — never a side effect of a deploy.

## 7. Tests

- Single-instance lock: second boot refused, stale lock reclaimed.
- Telegram permission matrix: each mode allows and denies exactly the listed commands, and denials are audited.
- Telegram allow-list rejection.
- Mode persistence across restart, default `SAFE_CONTROLS` on a fresh database.

## Technical notes

- New migration adds the Telegram permission mode to the operations configuration; no existing table changes.
- Telegram receiver lives in `src/core/telegram/`, dispatching through `src/core/bus/command-bus.server.ts` only.
- Lock implemented in `src/core/db/` and registered in the boot and shutdown sequences.
- Milestones 1–5 remain frozen; the only edits outside Milestone 6 files are the env-schema and documentation removals for authentication.