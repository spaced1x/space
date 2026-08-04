export interface Migration {
  id: number;
  name: string;
  sql: string;
}

// Infrastructure plus strategy evidence. Execution tables (orders, fills,
// ledger_records, settlements) arrive with their milestones.
export const migrations: Migration[] = [
  {
    id: 1,
    name: "core_infrastructure",
    sql: `
      CREATE TABLE IF NOT EXISTS kv (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at     TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        actor          TEXT NOT NULL,
        source         TEXT NOT NULL,
        command        TEXT NOT NULL,
        payload        TEXT NOT NULL,
        verdict        TEXT NOT NULL,
        reason         TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at);

      -- audit_log is append-only: history is evidence, not state.
      CREATE TRIGGER IF NOT EXISTS audit_log_no_update
        BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
        BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    `,
  },
  {
    id: 2,
    name: "strategy_frozen_windows",
    sql: `
      CREATE TABLE IF NOT EXISTS strategy_windows (
        id                          TEXT PRIMARY KEY,
        condition_id                TEXT NOT NULL,
        slug                        TEXT NOT NULL,
        horizon                     TEXT NOT NULL,
        seconds                     INTEGER NOT NULL,
        buffer                      REAL NOT NULL,
        enabled                     INTEGER NOT NULL,
        opens_at                    TEXT NOT NULL,
        expires_at                  TEXT NOT NULL,
        state                       TEXT NOT NULL,
        reason                      TEXT NOT NULL,
        triggered_at                TEXT,
        settlement_twap_at_trigger  REAL,
        intent_id                   TEXT,
        updated_at                  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_strategy_windows_condition
        ON strategy_windows (condition_id);

      -- The frozen trigger is evidence, not state: one row per window, forever.
      CREATE TABLE IF NOT EXISTS frozen_triggers (
        window_id         TEXT PRIMARY KEY,
        condition_id      TEXT NOT NULL,
        horizon           TEXT NOT NULL,
        seconds           INTEGER NOT NULL,
        opening_twap      REAL NOT NULL,
        ptb               REAL NOT NULL,
        direction         TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
        buffer            REAL NOT NULL,
        frozen_trigger    REAL NOT NULL,
        window_open_time  TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS frozen_triggers_no_update
        BEFORE UPDATE ON frozen_triggers
        BEGIN SELECT RAISE(ABORT, 'frozen triggers are write-once'); END;

      CREATE TRIGGER IF NOT EXISTS frozen_triggers_no_delete
        BEFORE DELETE ON frozen_triggers
        BEGIN SELECT RAISE(ABORT, 'frozen triggers are write-once'); END;

      CREATE TABLE IF NOT EXISTS window_transitions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        window_id     TEXT NOT NULL,
        condition_id  TEXT NOT NULL,
        state         TEXT NOT NULL,
        reason        TEXT NOT NULL,
        occurred_at   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_window_transitions_window
        ON window_transitions (window_id);

      CREATE TRIGGER IF NOT EXISTS window_transitions_no_update
        BEFORE UPDATE ON window_transitions
        BEGIN SELECT RAISE(ABORT, 'window transitions are append-only'); END;

      -- Execution intents are the strategy's output contract. The Execution
      -- Engine (later milestone) reads them; nothing ever rewrites one.
      CREATE TABLE IF NOT EXISTS execution_intents (
        id               TEXT PRIMARY KEY,
        created_at       TEXT NOT NULL,
        condition_id     TEXT NOT NULL,
        slug             TEXT NOT NULL,
        horizon          TEXT NOT NULL,
        window_seconds   INTEGER NOT NULL,
        direction        TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
        opening_twap     REAL NOT NULL,
        settlement_twap  REAL NOT NULL,
        ptb              REAL NOT NULL,
        buffer           REAL NOT NULL,
        frozen_trigger   REAL NOT NULL,
        trigger_time     TEXT NOT NULL,
        reason           TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_execution_intents_created
        ON execution_intents (created_at);

      CREATE TRIGGER IF NOT EXISTS execution_intents_no_update
        BEFORE UPDATE ON execution_intents
        BEGIN SELECT RAISE(ABORT, 'execution intents are immutable'); END;

      CREATE TRIGGER IF NOT EXISTS execution_intents_no_delete
        BEFORE DELETE ON execution_intents
        BEGIN SELECT RAISE(ABORT, 'execution intents are immutable'); END;
    `,
  },
  {
    id: 3,
    name: "execution_orders",
    sql: `
      -- Exactly one order chain per execution intent. The UNIQUE constraint is
      -- the storage-level guarantee behind "restarting SPACE never creates a
      -- duplicate order": a second attempt to open a chain for the same intent
      -- is rejected by SQLite, not merely by application logic.
      CREATE TABLE IF NOT EXISTS orders (
        id              TEXT PRIMARY KEY,
        intent_id       TEXT NOT NULL UNIQUE,
        condition_id    TEXT NOT NULL,
        slug            TEXT NOT NULL,
        horizon         TEXT NOT NULL,
        token_id        TEXT NOT NULL,
        outcome         TEXT NOT NULL CHECK (outcome IN ('UP', 'DOWN')),
        side            TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        mode            TEXT NOT NULL,
        kind            TEXT NOT NULL CHECK (kind IN ('LIMIT', 'MARKET')),
        limit_price     REAL,
        size            REAL NOT NULL,
        state           TEXT NOT NULL,
        attempt         INTEGER NOT NULL DEFAULT 0,
        client_id       TEXT,
        venue_order_id  TEXT,
        filled_size     REAL NOT NULL DEFAULT 0,
        avg_price       REAL,
        reason          TEXT NOT NULL,
        last_error      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        submitted_at    TEXT,
        terminal_at     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_orders_state ON orders (state);
      CREATE INDEX IF NOT EXISTS idx_orders_condition ON orders (condition_id);

      -- Append-only lifecycle. Every transition is written before the engine
      -- is allowed to advance, so recovery always sees the true last state.
      CREATE TABLE IF NOT EXISTS order_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id    TEXT NOT NULL,
        intent_id   TEXT NOT NULL,
        state       TEXT NOT NULL,
        reason      TEXT NOT NULL,
        attempt     INTEGER NOT NULL DEFAULT 0,
        payload     TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id);

      CREATE TRIGGER IF NOT EXISTS order_events_no_update
        BEFORE UPDATE ON order_events
        BEGIN SELECT RAISE(ABORT, 'order events are append-only'); END;

      CREATE TRIGGER IF NOT EXISTS order_events_no_delete
        BEFORE DELETE ON order_events
        BEGIN SELECT RAISE(ABORT, 'order events are append-only'); END;

      -- Fills are keyed by the venue trade id, so replaying the trade feed
      -- after a restart can never double-count a fill.
      CREATE TABLE IF NOT EXISTS fills (
        id           TEXT PRIMARY KEY,
        order_id     TEXT NOT NULL,
        intent_id    TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        token_id     TEXT NOT NULL,
        outcome      TEXT NOT NULL,
        side         TEXT NOT NULL,
        size         REAL NOT NULL,
        price        REAL NOT NULL,
        filled_at    TEXT NOT NULL,
        source       TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_fills_order ON fills (order_id);

      CREATE TRIGGER IF NOT EXISTS fills_no_update
        BEFORE UPDATE ON fills
        BEGIN SELECT RAISE(ABORT, 'fills are immutable evidence'); END;

      CREATE TRIGGER IF NOT EXISTS fills_no_delete
        BEFORE DELETE ON fills
        BEGIN SELECT RAISE(ABORT, 'fills are immutable evidence'); END;

      -- Every risk verdict is kept, including rejections and retry re-checks.
      CREATE TABLE IF NOT EXISTS risk_decisions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        intent_id   TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('APPROVED', 'REJECTED')),
        code        TEXT NOT NULL,
        reason      TEXT NOT NULL,
        attempt     INTEGER NOT NULL DEFAULT 0,
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_risk_decisions_intent ON risk_decisions (intent_id);

      CREATE TRIGGER IF NOT EXISTS risk_decisions_no_update
        BEFORE UPDATE ON risk_decisions
        BEGIN SELECT RAISE(ABORT, 'risk decisions are append-only'); END;

      CREATE TRIGGER IF NOT EXISTS risk_decisions_no_delete
        BEFORE DELETE ON risk_decisions
        BEGIN SELECT RAISE(ABORT, 'risk decisions are append-only'); END;
    `,
  },
  {
    id: 4,
    name: "replay_market_discoveries",
    sql: `
      -- Replay must reconstruct a market entirely from persisted data, so
      -- discovery itself becomes evidence. One row per condition id, updated
      -- in place as the venue's view of the market changes.
      CREATE TABLE IF NOT EXISTS market_discoveries (
        condition_id   TEXT PRIMARY KEY,
        slug           TEXT NOT NULL,
        horizon        TEXT NOT NULL,
        question       TEXT NOT NULL,
        status         TEXT NOT NULL,
        ptb            REAL,
        close_at       TEXT,
        settlement_at  TEXT,
        up_token_id    TEXT,
        down_token_id  TEXT,
        discovered_at  TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_market_discoveries_settlement
        ON market_discoveries (settlement_at);
    `,
  },
  {
    id: 5,
    name: "milestone_6_recovery_backup_telegram",
    sql: `
      -- Venue reconciliation report. Every boot-time reconciliation is
      -- persisted so the operator can see what was adopted, closed or failed.
      CREATE TABLE IF NOT EXISTS reconciliation_reports (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at      TEXT NOT NULL,
        runtime_id      TEXT NOT NULL,
        state           TEXT NOT NULL,
        orders_examined INTEGER NOT NULL DEFAULT 0,
        adopted         INTEGER NOT NULL DEFAULT 0,
        closed          INTEGER NOT NULL DEFAULT 0,
        failed          INTEGER NOT NULL DEFAULT 0,
        divergences     INTEGER NOT NULL DEFAULT 0,
        message         TEXT NOT NULL,
        details         TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_created
        ON reconciliation_reports (created_at);

      -- Backup / restore audit trail.
      CREATE TABLE IF NOT EXISTS backups (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at    TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('MANUAL', 'SCHEDULED')),
        source_path   TEXT NOT NULL,
        target_path   TEXT NOT NULL,
        size_bytes    INTEGER,
        verified      INTEGER NOT NULL DEFAULT 0,
        state         TEXT NOT NULL,
        message       TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_backups_created
        ON backups (created_at);

      -- Telegram messages sent by the bot (for audit / replay of operator
      -- notifications, not the inbound command log which lives in audit_log).
      CREATE TABLE IF NOT EXISTS telegram_outbox (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at    TEXT NOT NULL,
        chat_id       TEXT NOT NULL,
        type          TEXT NOT NULL,
        text          TEXT NOT NULL,
        sent          INTEGER NOT NULL DEFAULT 0,
        error         TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_telegram_outbox_created
        ON telegram_outbox (created_at);
    `,
  },
  {
    id: 6,
    name: "milestone_7_metrics_snapshots_inbound_release",
    sql: `
      -- Production runtime metrics: memory, CPU, drift, reconnects, DB growth.
      -- Used for soak testing and release-gate evidence.
      CREATE TABLE IF NOT EXISTS runtime_metrics (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        sampled_at    TEXT NOT NULL,
        memory_rss_mb REAL,
        memory_heap_mb REAL,
        cpu_user_seconds REAL,
        cpu_system_seconds REAL,
        scheduler_drift_ms REAL,
        scheduler_ticks INTEGER,
        db_size_bytes INTEGER,
        feed_reconnects INTEGER NOT NULL DEFAULT 0,
        venue_errors INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_metrics_sampled
        ON runtime_metrics (sampled_at);

      -- Configuration snapshots: active operations document at ARM / mode switch.
      CREATE TABLE IF NOT EXISTS config_snapshots (
        id            TEXT PRIMARY KEY,
        version       INTEGER NOT NULL,
        active_at     TEXT NOT NULL,
        reason        TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        document      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_config_snapshots_active_at
        ON config_snapshots (active_at);

      -- Inbound Telegram messages (operator commands).
      CREATE TABLE IF NOT EXISTS telegram_inbound (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at    TEXT NOT NULL,
        chat_id       TEXT NOT NULL,
        username      TEXT NOT NULL,
        text          TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_telegram_inbound_created
        ON telegram_inbound (created_at);

      -- Versioned release artifacts and release-gate evidence.
      CREATE TABLE IF NOT EXISTS release_artifacts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        version       TEXT NOT NULL,
        deployed_at   TEXT NOT NULL,
        deployed_by   TEXT,
        rollback_version TEXT,
        report_path   TEXT,
        gate_passed   INTEGER NOT NULL DEFAULT 0,
        reason        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_release_artifacts_version
        ON release_artifacts (version);
    `,
  },
  {
    id: 7,
    name: "settlements_and_environment_stamp",
    sql: `
      -- Settlement ingestion. The venue's resolved outcome for a closed market
      -- is evidence, not a derived value: without it Replay cannot say whether a
      -- frozen-window decision was correct and Statistics cannot report settled
      -- PnL. One row per market, written once the venue reports resolution.
      CREATE TABLE IF NOT EXISTS settlements (
        condition_id     TEXT PRIMARY KEY,
        slug             TEXT NOT NULL,
        horizon          TEXT NOT NULL,
        settled_at       TEXT NOT NULL,
        resolved_outcome TEXT NOT NULL CHECK (resolved_outcome IN ('UP', 'DOWN', 'UNRESOLVED')),
        up_price         REAL,
        down_price       REAL,
        source           TEXT NOT NULL,
        recorded_at      TEXT NOT NULL,
        raw              TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_settlements_settled_at
        ON settlements (settled_at);

      -- A resolved settlement is immutable evidence. Re-ingestion is an upsert
      -- only while the market is still UNRESOLVED; see settlement.repository.
      CREATE TRIGGER IF NOT EXISTS settlements_no_delete
        BEFORE DELETE ON settlements
        BEGIN SELECT RAISE(ABORT, 'settlements are append-only evidence'); END;

      -- Configuration-version linkage: every intent records the Operations Desk
      -- version that produced it, so a PnL number can be attributed to the exact
      -- configuration that generated the trade.
      ALTER TABLE execution_intents ADD COLUMN config_version INTEGER;

      -- Environment stamp. A database created under V1_TESTNET must never be
      -- opened by a V2_MAINNET process, and the reverse. Written on first open,
      -- verified on every later open.
      CREATE TABLE IF NOT EXISTS space_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 8,
    name: "runtime_telemetry_persistence",
    sql: `
      -- Connection timeline. Every state change reported by the Runtime
      -- Connection Manager is persisted so the operator can reconstruct the
      -- session after a refresh, PM2 restart, V1/V2 switch, or VPS reboot.
      CREATE TABLE IF NOT EXISTS connection_timeline (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        label         TEXT NOT NULL,
        state         TEXT NOT NULL,
        message       TEXT NOT NULL,
        environment   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_connection_timeline_at
        ON connection_timeline (at);
      CREATE INDEX IF NOT EXISTS idx_connection_timeline_id
        ON connection_timeline (connection_id);

      -- Runtime resource audits. START, STOP, SWITCH and PERIODIC audits are
      -- evidence that exactly one of every resource exists when RUNNING and
      -- zero exist when STOPPED. Persisted so a restarted process can expose
      -- the last audit immediately instead of waiting for the next transition.
      CREATE TABLE IF NOT EXISTS resource_audits (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            TEXT NOT NULL,
        phase         TEXT NOT NULL,
        expectation   TEXT NOT NULL,
        passed        INTEGER NOT NULL,
        failures      TEXT NOT NULL,
        checks        TEXT NOT NULL,
        heap_used_bytes INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_resource_audits_at
        ON resource_audits (at);
    `,
  },
  {
    id: 9,
    name: "execution_transition_ledgers",
    sql: `
      -- Order transition ledger. The orders table is the current-state
      -- projection; this ledger is the history. Every state change is written
      -- inside the same transaction that updates orders, so a transition can
      -- never be applied without being recorded.
      CREATE TABLE IF NOT EXISTS order_transitions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id       TEXT NOT NULL,
        intent_id      TEXT NOT NULL,
        from_state     TEXT NOT NULL,
        to_state       TEXT NOT NULL,
        from_lifecycle TEXT NOT NULL,
        to_lifecycle   TEXT NOT NULL,
        at             TEXT NOT NULL,
        venue_order_id TEXT,
        filled_size    REAL NOT NULL DEFAULT 0,
        price          REAL,
        reason         TEXT NOT NULL,
        error          TEXT,
        environment    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_order_transitions_order
        ON order_transitions (order_id, id);
      CREATE INDEX IF NOT EXISTS idx_order_transitions_at
        ON order_transitions (at);

      CREATE TRIGGER IF NOT EXISTS order_transitions_no_update
        BEFORE UPDATE ON order_transitions
        BEGIN SELECT RAISE(ABORT, 'order_transitions is append-only'); END;

      CREATE TRIGGER IF NOT EXISTS order_transitions_no_delete
        BEFORE DELETE ON order_transitions
        BEGIN SELECT RAISE(ABORT, 'order_transitions is append-only'); END;

      -- Position transition ledger. No mutable positions table exists: fills
      -- remain the canonical execution record and the current position stays
      -- derived from them. This ledger records the derived lifecycle so the
      -- history survives restart and V1/V2 switching, and is regenerable from
      -- fills byte-for-byte.
      CREATE TABLE IF NOT EXISTS position_transitions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        position_key TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        token_id     TEXT NOT NULL,
        outcome      TEXT NOT NULL,
        transition   TEXT NOT NULL,
        size         REAL NOT NULL,
        avg_price    REAL NOT NULL,
        cost         REAL NOT NULL,
        fill_id      TEXT,
        at           TEXT NOT NULL,
        environment  TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_position_transitions_unique
        ON position_transitions (position_key, transition, at, fill_id);
      CREATE INDEX IF NOT EXISTS idx_position_transitions_condition
        ON position_transitions (condition_id, id);

      CREATE TRIGGER IF NOT EXISTS position_transitions_no_update
        BEFORE UPDATE ON position_transitions
        BEGIN SELECT RAISE(ABORT, 'position_transitions is append-only'); END;

      CREATE TRIGGER IF NOT EXISTS position_transitions_no_delete
        BEFORE DELETE ON position_transitions
        BEGIN SELECT RAISE(ABORT, 'position_transitions is append-only'); END;

      -- One sizing decision per intent attempt. Automatic trading, manual
      -- trading and both venues consume the same sizing module, so this row is
      -- the record of why a given size was traded.
      CREATE TABLE IF NOT EXISTS sizing_decisions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        intent_id       TEXT NOT NULL,
        attempt         INTEGER NOT NULL,
        source          TEXT NOT NULL,
        requested_size  REAL NOT NULL,
        applied_size    REAL NOT NULL,
        cap             TEXT NOT NULL,
        exposure_before REAL NOT NULL,
        exposure_after  REAL NOT NULL,
        reason          TEXT NOT NULL,
        at              TEXT NOT NULL,
        environment     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sizing_decisions_intent
        ON sizing_decisions (intent_id);

      CREATE TRIGGER IF NOT EXISTS sizing_decisions_no_update
        BEFORE UPDATE ON sizing_decisions
        BEGIN SELECT RAISE(ABORT, 'sizing_decisions is append-only'); END;

      -- Paper/Live parity. Every completed strategy evaluation records the
      -- decision tuple both environments must agree on, stamped with the
      -- environment that produced it. Divergences are operator diagnostics and
      -- never change trading behaviour.
      CREATE TABLE IF NOT EXISTS parity_decisions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        environment    TEXT NOT NULL,
        condition_id   TEXT NOT NULL,
        window_seconds INTEGER NOT NULL,
        intent_id      TEXT,
        tuple          TEXT NOT NULL,
        at             TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_parity_decisions_unique
        ON parity_decisions (environment, condition_id, window_seconds);

      CREATE TABLE IF NOT EXISTS parity_failures (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        condition_id   TEXT NOT NULL,
        window_seconds INTEGER NOT NULL,
        field          TEXT NOT NULL,
        v1_value       TEXT NOT NULL,
        v2_value       TEXT NOT NULL,
        at             TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_parity_failures_at
        ON parity_failures (at);

      CREATE TRIGGER IF NOT EXISTS parity_failures_no_update
        BEFORE UPDATE ON parity_failures
        BEGIN SELECT RAISE(ABORT, 'parity_failures is append-only'); END;
    `,
  },
];
