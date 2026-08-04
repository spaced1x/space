import fs from "node:fs";
import nodePath from "node:path";

import type { ParityDifference, ParityTuple } from "../../execution/parity";
import { createSqliteDriver } from "../drivers/sqlite.server";
import { requireDriver } from "../database.server";

// Parity storage. Local rows live in the active environment's database; the
// other environment's rows are read from its own database file, read-only and
// closed immediately, exactly as the inactive-runtime peek does.

export interface ParityRow {
  environment: string;
  conditionId: string;
  windowSeconds: number;
  intentId: string | null;
  tuple: ParityTuple;
  at: string;
}

interface RawRow {
  environment: string;
  condition_id: string;
  window_seconds: number;
  intent_id: string | null;
  tuple: string;
  at: string;
}

function toRow(row: RawRow): ParityRow {
  return {
    environment: row.environment,
    conditionId: row.condition_id,
    windowSeconds: row.window_seconds,
    intentId: row.intent_id,
    tuple: JSON.parse(row.tuple) as ParityTuple,
    at: row.at,
  };
}

export const parityRepository = {
  /** One row per environment + market + window. Re-evaluation replaces it. */
  async record(row: ParityRow): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO parity_decisions (environment, condition_id, window_seconds, intent_id, tuple, at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (environment, condition_id, window_seconds)
       DO UPDATE SET intent_id = excluded.intent_id, tuple = excluded.tuple, at = excluded.at`,
      [
        row.environment,
        row.conditionId,
        row.windowSeconds,
        row.intentId,
        JSON.stringify(row.tuple),
        row.at,
      ],
    );
  },

  async local(limit = 200): Promise<ParityRow[]> {
    const driver = await requireDriver();
    return driver
      .all<RawRow>(`SELECT * FROM parity_decisions ORDER BY at DESC LIMIT ?`, [limit])
      .map(toRow);
  },

  /** Read the other environment's decisions from its own database file. */
  async foreign(dbPath: string, limit = 200): Promise<ParityRow[]> {
    const resolved = nodePath.resolve(dbPath);
    if (!fs.existsSync(resolved)) return [];
    let driver: Awaited<ReturnType<typeof createSqliteDriver>> | undefined;
    try {
      driver = await createSqliteDriver(dbPath);
      const exists = driver.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'parity_decisions'",
      );
      if (!exists) return [];
      return driver
        .all<RawRow>(`SELECT * FROM parity_decisions ORDER BY at DESC LIMIT ?`, [limit])
        .map(toRow);
    } finally {
      try {
        driver?.close();
      } catch {
        // A read-only peek must never affect the live runtime.
      }
    }
  },

  async recordFailures(
    conditionId: string,
    windowSeconds: number,
    differences: ParityDifference[],
    at: string,
  ): Promise<void> {
    if (!differences.length) return;
    const driver = await requireDriver();
    driver.transaction(() => {
      for (const difference of differences) {
        driver.run(
          `INSERT INTO parity_failures (condition_id, window_seconds, field, v1_value, v2_value, at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [conditionId, windowSeconds, difference.field, difference.v1, difference.v2, at],
        );
      }
    });
  },

  async failures(limit = 50): Promise<
    {
      conditionId: string;
      windowSeconds: number;
      field: string;
      v1: string;
      v2: string;
      at: string;
    }[]
  > {
    const driver = await requireDriver();
    return driver
      .all<{
        condition_id: string;
        window_seconds: number;
        field: string;
        v1_value: string;
        v2_value: string;
        at: string;
      }>(`SELECT * FROM parity_failures ORDER BY id DESC LIMIT ?`, [limit])
      .map((row) => ({
        conditionId: row.condition_id,
        windowSeconds: row.window_seconds,
        field: row.field,
        v1: row.v1_value,
        v2: row.v2_value,
        at: row.at,
      }));
  },
};
