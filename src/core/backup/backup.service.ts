import fs from "node:fs";
import path from "node:path";
import { loadEnv, resolveDbPath } from "../config/env.server";
import { backupRepository } from "../db/repositories/backup.repository";
import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";

const log = createLogger("backup");

export interface BackupResult {
  success: boolean;
  backupId?: number;
  path?: string;
  sizeBytes?: number;
  message: string;
}

export async function performBackup(kind: "MANUAL" | "SCHEDULED", label?: string): Promise<BackupResult> {
  const env = loadEnv();
  const sourcePath = path.resolve(resolveDbPath(env));
  const backupDir = path.join(path.dirname(sourcePath), "backups");
  const timestamp = systemClock.iso().replace(/[:.]/g, "-");
  const suffix = label ? `-${label.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
  const targetPath = path.join(backupDir, `space-backup-${kind}-${timestamp}${suffix}.db`);

  let recordId: number | undefined;
  try {
    await fs.promises.mkdir(backupDir, { recursive: true });
    recordId = await backupRepository.insert(kind, sourcePath, targetPath);
    await fs.promises.copyFile(sourcePath, targetPath);
    const stats = await fs.promises.stat(targetPath);
    await backupRepository.markSuccess(recordId, stats.size);
    log.info("backup completed", { backupId: recordId, path: targetPath, sizeBytes: stats.size });
    return {
      success: true,
      backupId: recordId,
      path: targetPath,
      sizeBytes: stats.size,
      message: `backup created at ${targetPath}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (recordId) await backupRepository.markFailed(recordId, message);
    log.error("backup failed", { reason: message });
    return { success: false, message };
  }
}

export async function restoreBackup(backupId: number): Promise<BackupResult> {
  const env = loadEnv();
  const records = await backupRepository.recent(1000);
  const record = records.find((r) => r.id === backupId);
  if (!record) return { success: false, message: `backup ${backupId} not found` };
  if (record.state !== "SUCCESS") return { success: false, message: `backup ${backupId} is not verified` };

  const targetPath = path.resolve(resolveDbPath(env));
  const sourcePath = record.target_path;
  try {
    await fs.promises.copyFile(sourcePath, targetPath);
    log.info("restore completed", { backupId, sourcePath, targetPath });
    return {
      success: true,
      backupId,
      path: targetPath,
      message: `database restored from ${sourcePath}; restart required`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("restore failed", { backupId, reason: message });
    return { success: false, message };
  }
}
