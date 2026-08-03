import fs from "node:fs";
import nodePath from "node:path";

import { loadEnv } from "../config/env.server";
import type { SpaceEnv } from "../config/env.schema";
import { createSqliteDriver } from "../db/drivers/sqlite.server";
import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";

// Read-only peek into the inactive runtime.
//
// Only one runtime is live in a process, but the operator must still see the
// other one. The inactive panel is therefore rendered from that environment's
// own database, opened read-only, closed immediately and cached briefly. It is
// evidence, never a guess: when the file does not exist the panel says so.

const log = createLogger("runtime-peek");
const CACHE_MS = 10_000;

export type EnvironmentCode = SpaceEnv["SPACE_ENVIRONMENT"];

export interface RuntimePeek {
  environment: EnvironmentCode;
  available: boolean;
  reason: string;
  dbPath: string;
  sizeBytes: number | null;
  schemaVersion: number | null;
  environmentStamp: string | null;
  lifecycle: string | null;
  mode: string | null;
  emergencyStop: boolean | null;
  lastTransitionAt: string | null;
  lastTransitionReason: string | null;
  twapProvider: string | null;
  counts: { orders: number | null; fills: number | null; settlements: number | null };
  lastOrderAt: string | null;
  readAt: string;
}

export function databasePathFor(environment: EnvironmentCode): string {
  const suffix = environment === "V2_MAINNET" ? "v2" : "v1";
  return `./data/space-${suffix}.db`;
}

export function otherEnvironment(active: EnvironmentCode): EnvironmentCode {
  return active === "V1_TESTNET" ? "V2_MAINNET" : "V1_TESTNET";
}

const cache = new Map<EnvironmentCode, { at: number; value: RuntimePeek }>();

function unavailable(
  environment: EnvironmentCode,
  dbPath: string,
  reason: string,
): RuntimePeek {
  return {
    environment,
    available: false,
    reason,
    dbPath,
    sizeBytes: null,
    schemaVersion: null,
    environmentStamp: null,
    lifecycle: null,
    mode: null,
    emergencyStop: null,
    lastTransitionAt: null,
    lastTransitionReason: null,
    twapProvider: null,
    counts: { orders: null, fills: null, settlements: null },
    lastOrderAt: null,
    readAt: systemClock.iso(),
  };
}

/**
 * Read the persisted state of an environment that is not running in this
 * process. Never called for the active environment — that one is live.
 */
export async function peekEnvironment(environment: EnvironmentCode): Promise<RuntimePeek> {
  const dbPath = databasePathFor(environment);
  const cached = cache.get(environment);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const resolved = nodePath.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    const value = unavailable(
      environment,
      dbPath,
      "this environment has never run on this host, so it has no database yet",
    );
    cache.set(environment, { at: Date.now(), value });
    return value;
  }

  let driver: Awaited<ReturnType<typeof createSqliteDriver>> | undefined;
  try {
    driver = await createSqliteDriver(dbPath);
    const tables = new Set(
      driver
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((row) => row.name),
    );
    const kv = (key: string): string | null => {
      if (!tables.has("kv")) return null;
      return driver!.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key])?.value ?? null;
    };
    const count = (table: string): number | null => {
      if (!tables.has(table)) return null;
      return driver!.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? null;
    };

    const runtimeRaw = kv("runtime.state");
    const runtime = runtimeRaw
      ? (JSON.parse(runtimeRaw) as {
          lifecycle?: string;
          mode?: string;
          emergencyStop?: boolean;
          lastTransitionAt?: string;
          lastTransitionReason?: string;
        })
      : null;

    const value: RuntimePeek = {
      environment,
      available: true,
      reason: "read from this environment's database; the runtime is not live in this process",
      dbPath,
      sizeBytes: fs.statSync(resolved).size,
      schemaVersion: tables.has("schema_migrations")
        ? driver.get<{ id: number }>("SELECT MAX(id) AS id FROM schema_migrations")?.id ?? null
        : null,
      environmentStamp: tables.has("space_meta")
        ? driver.get<{ value: string }>("SELECT value FROM space_meta WHERE key = 'environment'")
            ?.value ?? null
        : null,
      // A stored lifecycle describes the last session, not this process: an
      // inactive runtime is always STOPPED here and now.
      lifecycle: "STOPPED",
      mode: runtime?.mode ?? null,
      emergencyStop: runtime?.emergencyStop ?? null,
      lastTransitionAt: runtime?.lastTransitionAt ?? null,
      lastTransitionReason: runtime?.lastTransitionReason ?? null,
      twapProvider: kv("twap.active_provider"),
      counts: {
        orders: count("orders"),
        fills: count("fills"),
        settlements: count("settlements"),
      },
      lastOrderAt: tables.has("orders")
        ? driver.get<{ at: string | null }>("SELECT MAX(created_at) AS at FROM orders")?.at ?? null
        : null,
      readAt: systemClock.iso(),
    };
    cache.set(environment, { at: Date.now(), value });
    return value;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn("inactive runtime peek failed", { environment, reason });
    const value = unavailable(environment, dbPath, `database could not be read: ${reason}`);
    cache.set(environment, { at: Date.now(), value });
    return value;
  } finally {
    try {
      driver?.close();
    } catch {
      // Closing a read-only peek must never affect the live runtime.
    }
  }
}

/** Drop the cache so the next read reflects a database that just changed. */
export function invalidatePeek(): void {
  cache.clear();
}

export function activeEnvironment(): EnvironmentCode {
  try {
    return loadEnv().SPACE_ENVIRONMENT;
  } catch {
    return "V1_TESTNET";
  }
}
