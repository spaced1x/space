import { systemClock } from "../../shared/clock";
import { requireDriver } from "../database.server";
import type { OperationsConfig } from "../../config/operations";

export interface ConfigSnapshotRecord {
  id: string;
  version: number;
  active_at: string;
  reason: string;
  correlation_id: string;
  document: string;
}

export const snapshotRepository = {
  async insert(
    id: string,
    version: number,
    activeAt: string,
    reason: string,
    correlationId: string,
    document: OperationsConfig,
  ): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `INSERT INTO config_snapshots (id, version, active_at, reason, correlation_id, document)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, version, activeAt, reason, correlationId, JSON.stringify(document)],
    );
  },

  async latest(): Promise<ConfigSnapshotRecord | null> {
    const driver = await requireDriver();
    return (
      driver.get<ConfigSnapshotRecord>(
        `SELECT id, version, active_at, reason, correlation_id, document
         FROM config_snapshots
         ORDER BY active_at DESC
         LIMIT 1`,
      ) ?? null
    );
  },

  async recent(limit = 20): Promise<ConfigSnapshotRecord[]> {
    const driver = await requireDriver();
    return driver.all<ConfigSnapshotRecord>(
      `SELECT id, version, active_at, reason, correlation_id, document
       FROM config_snapshots
       ORDER BY active_at DESC
       LIMIT ?`,
      [limit],
    );
  },
};
