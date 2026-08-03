import { loadEnv } from "../config/env.server";
import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";
import { DatabaseUnavailableError } from "../shared/errors";
import type { HealthResult } from "../health/types";
import type { SqlDriver } from "./driver";
import { createSqliteDriver } from "./drivers/sqlite.server";
import { migrations } from "./migrations";

const log = createLogger("database");

interface DatabaseState {
  driver?: SqlDriver;
  error?: string;
  appliedMigrations: number[];
  openedAt?: string;
}

const state: DatabaseState = { appliedMigrations: [] };
let initPromise: Promise<DatabaseState> | undefined;

// Automatic initialization: the first caller opens the file, sets WAL and runs
// pending migrations inside one transaction. Every later caller reuses it.
export async function initDatabase(): Promise<DatabaseState> {
  if (!initPromise) {
    initPromise = (async () => {
      const env = loadEnv();
      try {
        const driver = await createSqliteDriver(env.DB_PATH);
        applyMigrations(driver);
        state.driver = driver;
        state.openedAt = systemClock.iso();
        delete state.error;
        log.info("database ready", { path: driver.location, migrations: state.appliedMigrations });
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        log.warn("database unavailable in this runtime", { reason: state.error });
      }
      return state;
    })();
  }
  return initPromise;
}

function applyMigrations(driver: SqlDriver): void {
  driver.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `);
  const applied = new Set(
    driver.all<{ id: number }>("SELECT id FROM schema_migrations").map((row) => row.id),
  );
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    driver.transaction(() => {
      driver.exec(migration.sql);
      driver.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [
        migration.id,
        migration.name,
        systemClock.iso(),
      ]);
    });
    log.info("migration applied", { id: migration.id, name: migration.name });
  }
  state.appliedMigrations = driver
    .all<{ id: number }>("SELECT id FROM schema_migrations ORDER BY id")
    .map((row) => row.id);
}

// Repositories are the only callers. Nothing in app/** may reach past this.
export async function requireDriver(): Promise<SqlDriver> {
  const current = await initDatabase();
  if (!current.driver) {
    throw new DatabaseUnavailableError(
      `SQLite is not available in this runtime: ${current.error ?? "unknown reason"}`,
    );
  }
  return current.driver;
}

export async function databaseHealth(): Promise<HealthResult> {
  const current = await initDatabase();
  if (!current.driver) {
    return {
      state: "DEGRADED" as const,
      message: `SQLite not attached: ${current.error ?? "unknown reason"}`,
      details: { runtime: "no native sqlite; VPS deployment attaches better-sqlite3" },
    };
  }
  try {
    const row = current.driver.get<{ ok: number }>("SELECT 1 AS ok");
    return {
      state: row?.ok === 1 ? ("OK" as const) : ("FAILED" as const),
      message: row?.ok === 1 ? "sqlite (WAL) responding" : "unexpected probe result",
      details: {
        path: current.driver.location,
        openedAt: current.openedAt ?? "unknown",
        migrations: current.appliedMigrations,
      },
    };
  } catch (error) {
    return {
      state: "FAILED" as const,
      message: error instanceof Error ? error.message : "probe failed",
    };
  }
}

// Graceful shutdown: checkpoint WAL and release the file handle exactly once.
export async function closeDatabase(): Promise<void> {
  const current = await initDatabase();
  if (!current.driver) return;
  try {
    current.driver.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    current.driver.close();
    log.info("database closed");
  } finally {
    delete state.driver;
    delete state.openedAt;
    initPromise = undefined;
  }
}