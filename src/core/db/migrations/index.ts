export interface Migration {
  id: number;
  name: string;
  sql: string;
}

// Infrastructure only. Trading tables (markets, windows, orders, fills,
// platform_events, ledger_records, settlements) arrive with their milestones.
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
];
