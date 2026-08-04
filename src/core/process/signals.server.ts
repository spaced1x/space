import { createLogger } from "../logging/logger";
import { shutdown } from "../shutdown.server";

// Process signal ownership.
//
// PM2 stops a process with SIGTERM and restarts it afterwards. Without an
// explicit handler the runtime would die mid-write: the SQLite handle would
// never close cleanly and the instance lock file would linger, so the next boot
// would refuse to start. These handlers are the only place the process
// lifecycle is bound to the runtime lifecycle, and they are installed exactly
// once per process.

const log = createLogger("process");

let installed = false;

const GRACE_MS = 10_000;

async function gracefulExit(reason: string, code: number): Promise<void> {
  log.warn("process shutdown requested", { reason, code });
  const timeout = setTimeout(() => {
    log.error("graceful shutdown timed out; exiting hard", { reason, graceMs: GRACE_MS });
    process.exit(code);
  }, GRACE_MS);
  // Never hold the event loop open just to wait for the deadline.
  timeout.unref?.();
  try {
    await shutdown(reason);
  } catch (error) {
    log.error("shutdown failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
    process.exit(code);
  }
}

/** Bind SIGTERM/SIGINT and last-resort fault handlers to the teardown path. */
export function installProcessSignalHandlers(): void {
  if (installed) return;
  installed = true;

  process.once("SIGTERM", () => void gracefulExit("SIGTERM", 0));
  process.once("SIGINT", () => void gracefulExit("SIGINT", 0));

  // A fatal fault must take the process down so PM2 restarts it clean. In
  // development that would kill the dev server on a transient HMR error, so the
  // fault handlers only latch in a production process.
  if (process.env["NODE_ENV"] !== "production") return;

  process.on("uncaughtException", (error) => {
    log.error("uncaught exception", { reason: error.message, stack: error.stack });
    void gracefulExit(`uncaught exception: ${error.message}`, 1);
  });

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    log.error("unhandled promise rejection", { reason: message });
    void gracefulExit(`unhandled rejection: ${message}`, 1);
  });
}

export function processSignalHandlersInstalled(): boolean {
  return installed;
}
