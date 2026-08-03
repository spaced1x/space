// Minimal synchronous SQL surface. SQLite (WAL) via better-sqlite3 is the only
// production implementation; the interface exists so repositories can be tested
// and so a runtime without a real filesystem fails loudly instead of silently.
export interface SqlDriver {
  readonly kind: string;
  readonly location: string;
  exec(sql: string): void;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  transaction<T>(fn: () => T): T;
  close(): void;
}