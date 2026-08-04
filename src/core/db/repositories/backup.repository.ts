import { systemClock } from "../../shared/clock";
import { requireDriver } from "../database.server";

export interface BackupRecord {
  id: number;
  created_at: string;
  kind: "MANUAL" | "SCHEDULED";
  source_path: string;
  target_path: string;
  size_bytes: number | null;
  verified: number;
  state: "PENDING" | "SUCCESS" | "FAILED";
  message: string | null;
}

export const backupRepository = {
  async insert(
    kind: BackupRecord["kind"],
    sourcePath: string,
    targetPath: string,
  ): Promise<number> {
    const driver = await requireDriver();
    const result = driver.run(
      `INSERT INTO backups (created_at, kind, source_path, target_path, state)
       VALUES (?, ?, ?, ?, ?)`,
      [systemClock.iso(), kind, sourcePath, targetPath, "PENDING"],
    );
    return Number(result.lastInsertRowid);
  },

  async markSuccess(id: number, sizeBytes: number): Promise<void> {
    const driver = await requireDriver();
    driver.run(
      `UPDATE backups SET state = 'SUCCESS', size_bytes = ?, verified = 1, message = 'verified by size'
       WHERE id = ?`,
      [sizeBytes, id],
    );
  },

  async markFailed(id: number, message: string): Promise<void> {
    const driver = await requireDriver();
    driver.run(`UPDATE backups SET state = 'FAILED', message = ? WHERE id = ?`, [message, id]);
  },

  async recent(limit = 20): Promise<BackupRecord[]> {
    const driver = await requireDriver();
    return driver.all<BackupRecord>(
      `SELECT id, created_at, kind, source_path, target_path, size_bytes, verified, state, message
       FROM backups
       ORDER BY id DESC
       LIMIT ?`,
      [limit],
    );
  },
};
