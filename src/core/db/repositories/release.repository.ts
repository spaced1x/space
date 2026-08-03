import { systemClock } from "../../shared/clock";
import { requireDriver } from "../database.server";

export interface ReleaseArtifactRecord {
  id: number;
  version: string;
  deployed_at: string;
  deployed_by: string | null;
  rollback_version: string | null;
  report_path: string | null;
  gate_passed: number;
  reason: string | null;
}

export const releaseRepository = {
  async insert(record: {
    version: string;
    deployedBy?: string;
    rollbackVersion?: string;
    reportPath?: string;
    gatePassed: boolean;
    reason?: string;
  }): Promise<number> {
    const driver = await requireDriver();
    const result = driver.run(
      `INSERT INTO release_artifacts
       (version, deployed_at, deployed_by, rollback_version, report_path, gate_passed, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.version,
        systemClock.iso(),
        record.deployedBy ?? null,
        record.rollbackVersion ?? null,
        record.reportPath ?? null,
        record.gatePassed ? 1 : 0,
        record.reason ?? null,
      ],
    );
    return Number(result.lastInsertRowid);
  },

  async latest(): Promise<ReleaseArtifactRecord | null> {
    const driver = await requireDriver();
    return (
      driver.get<ReleaseArtifactRecord>(
        `SELECT id, version, deployed_at, deployed_by, rollback_version, report_path, gate_passed, reason
         FROM release_artifacts
         ORDER BY deployed_at DESC
         LIMIT 1`,
      ) ?? null
    );
  },

  async recordRollback(version: string, reason: string): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `UPDATE release_artifacts SET reason = ? WHERE version = ?`,
      [reason, version],
    );
  },
};
