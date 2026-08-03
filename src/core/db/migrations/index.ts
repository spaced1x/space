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
];
