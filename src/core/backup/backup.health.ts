import { backupRepository } from "../db/repositories/backup.repository";
import type { HealthResult } from "../health/types";

export async function backupServiceHealth(): Promise<HealthResult> {
  try {
    const recent = await backupRepository.recent(1);
    const last = recent[0];
    if (!last) {
      return {
        state: "OK",
        message: "backup service ready; no backups yet",
        details: { lastBackup: null },
      };
    }
    if (last.state === "FAILED") {
      return {
        state: "DEGRADED",
        message: `last backup failed: ${last.message}`,
        details: { lastBackup: { id: last.id, state: last.state, at: last.created_at } },
      };
    }
    return {
      state: "OK",
      message: `last backup ${last.state.toLowerCase()} at ${last.created_at}`,
      details: { lastBackup: { id: last.id, state: last.state, at: last.created_at } },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "DEGRADED",
      message: `backup health check failed: ${message}`,
      details: { error: message },
    };
  }
}
