import { loadEnv } from "../config/env.server";
import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";

// Single-instance lock.
//
// SPACE is one process with one writer. Running two copies against the same
// database would create duplicate orders, double position counts and divergent
// risk decisions. The lock file lives next to the database and is held for the
// lifetime of the process.

const log = createLogger("database-lock");

interface LockHandle {
  path: string;
  release(): void;
}

let held: LockHandle | null = null;

export function lockPath(): string {
  const env = loadEnv();
  return `${env.DB_PATH}.lock`;
}

/**
 * Acquire the single-instance lock. Throws if another SPACE process is already
 * running against the same database. Must be called before the database opens.
 */
export function acquireInstanceLock(): LockHandle {
  if (held) return held;

  const path = lockPath();
  const fs = require("node:fs");
  const pid = process.pid;

  try {
    // writeSync with EXCL is atomic on POSIX and Windows for this purpose.
    const fd = fs.openSync(path, "wx");
    fs.writeSync(fd, `${pid}\n${systemClock.iso()}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EEXIST") {
      const existing = fs.existsSync(path) ? fs.readFileSync(path, "utf8").split("\n")[0] ?? "unknown" : "unknown";
      throw new Error(
        `SPACE is already running (lock held by PID ${existing.trim()} at ${path}). ` +
          `Stop the other process or delete the lock file only if you are certain it is stale.`,
      );
    }
    throw error;
  }

  held = {
    path,
    release: () => {
      if (!held) return;
      try {
        fs.unlinkSync(path);
      } catch (error) {
        log.warn("failed to remove instance lock", {
          path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      held = null;
    },
  };

  // Defensive: release the lock if the process exits unexpectedly.
  process.once("exit", () => held?.release());

  log.info("instance lock acquired", { path, pid });
  return held;
}

export function releaseInstanceLock(): void {
  held?.release();
}

export function instanceLockHeld(): boolean {
  return held !== null;
}
