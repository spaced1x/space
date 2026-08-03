import { loadEnv } from "../config/env.server";
import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";
import { DatabaseUnavailableError } from "../shared/errors";
import type { DatabaseDiagnostics, HealthResult } from "../health/types";
import type { SqlDriver } from "./driver";
import { createSqliteDriver } from "./drivers/sqlite.server";
import { migrations } from "./migrations";

const log = createLogger("database");

interface DatabaseState {
  driver?: SqlDriver;
  error?: string;
  appliedMigrations: number[];
  openedAt?: string;
  environmentStamp?: string;
  stampMismatch?: string;
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
        stampEnvironment(driver, env.SPACE_ENVIRONMENT);
        if (state.stampMismatch) throw new Error(state.stampMismatch);
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

// Environment conformance at the storage layer: a database created while running
// V1_TESTNET must never be reopened by a V2_MAINNET process (or the reverse).
// The stamp is written once, on the first open after migration 7.
function stampEnvironment(driver: SqlDriver, environment: string): void {
  delete state.stampMismatch;
  const existing = driver.get<{ value: string }>(
    "SELECT value FROM space_meta WHERE key = 'environment'",
  )?.value;
  if (!existing) {
    driver.run(
      "INSERT INTO space_meta (key, value, updated_at) VALUES ('environment', ?, ?)",
      [environment, systemClock.iso()],
    );
    state.environmentStamp = environment;
    return;
  }
  state.environmentStamp = existing;
  if (existing !== environment) {
    state.stampMismatch =
      `database is stamped ${existing} but SPACE_ENVIRONMENT is ${environment}; ` +
      "refusing to open — point DB_PATH at the database for this environment";
  }
}

export async function databaseEnvironmentStamp(): Promise<{
  stamp: string | null;
  mismatch: string | null;
}> {
  const current = await initDatabase();
  return { stamp: current.environmentStamp ?? null, mismatch: current.stampMismatch ?? null };
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
  const base: DatabaseDiagnostics = {
    engine: "sqlite",
    journalMode: "WAL",
    walEnabled: null,
    schemaVersion: current.appliedMigrations.at(-1) ?? null,
    migrationVersion: current.appliedMigrations.at(-1) ?? null,
    appliedMigrations: current.appliedMigrations,
    latencyMs: null,
    sizeBytes: null,
  };
  if (!current.driver) {
    // In production an unreachable database is not a degraded convenience —
    // no evidence can be written, so the engine must never be armed.
    const fatal = loadEnv().NODE_ENV === "production" || Boolean(current.stampMismatch);
    return {
      state: fatal ? ("FAILED" as const) : ("DEGRADED" as const),
      message: `SQLite not attached: ${current.error ?? "unknown reason"}`,
      details: {
        ...base,
        walEnabled: false,
        environmentStamp: current.environmentStamp ?? null,
        stampMismatch: current.stampMismatch ?? null,
        runtime: "no native sqlite; VPS deployment attaches better-sqlite3",
      },
    };
  }
  try {
    const startedAt = Date.now();
    const row = current.driver.get<{ ok: number }>("SELECT 1 AS ok");
    const latencyMs = Date.now() - startedAt;
    const stats = current.driver.stats?.() ?? {};
    return {
      state: row?.ok === 1 ? ("OK" as const) : ("FAILED" as const),
      message: row?.ok === 1 ? "sqlite (WAL) responding" : "unexpected probe result",
      details: {
        ...base,
        path: current.driver.location,
        openedAt: current.openedAt ?? "unknown",
        environmentStamp: current.environmentStamp ?? null,
        journalMode: stats.journalMode ?? "WAL",
        walEnabled: (stats.journalMode ?? "wal").toLowerCase() === "wal",
        sizeBytes: stats.sizeBytes ?? null,
        latencyMs,
      },
    };
  } catch (error) {
    return {
      state: "FAILED" as const,
      message: error instanceof Error ? error.message : "probe failed",
      details: base,
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
