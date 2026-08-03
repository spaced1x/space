import type { SqlDriver } from "../driver";

// better-sqlite3 is a native module: present on the VPS, absent in the
// authoring sandbox. The specifier is built at runtime so no bundler tries to
// resolve or inline it.
export async function createSqliteDriver(dbPath: string): Promise<SqlDriver> {
  const [{ default: Database }, fs, path] = await Promise.all([
    import(/* @vite-ignore */ ["better", "sqlite3"].join("-")) as Promise<{
      default: new (file: string) => SqliteHandle;
    }>,
    import("node:fs"),
    import("node:path"),
  ]);

  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);

  // WAL + NORMAL synchronous: durable across process crashes, fast enough for
  // a single-writer engine loop, and safe for online backups.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  return {
    kind: "sqlite-wal",
    location: dbPath,
    exec: (sql) => db.exec(sql),
    all: (sql, params = []) => db.prepare(sql).all(...params) as never,
    get: (sql, params = []) => db.prepare(sql).get(...params) as never,
    run: (sql, params = []) => db.prepare(sql).run(...params),
    transaction: (fn) => db.transaction(fn)(),
    stats: () => {
      const journal = db.pragma("journal_mode");
      const mode = Array.isArray(journal)
        ? String((journal[0] as { journal_mode?: string } | undefined)?.journal_mode ?? "unknown")
        : "unknown";
      let sizeBytes: number | null = null;
      try {
        sizeBytes = fs.statSync(path.resolve(dbPath)).size;
      } catch {
        sizeBytes = null;
      }
      return { journalMode: mode, sizeBytes };
    },
    close: () => db.close(),
  };
}

interface SqliteHandle {
  pragma(source: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  transaction<T>(fn: () => T): () => T;
  close(): void;
}