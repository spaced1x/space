import { closeDatabase } from "./db/database.server";
import { stopEngineLoop } from "./engine/loop.server";
import { stopScheduler } from "./scheduler/scheduler.server";
import { createLogger } from "./logging/logger";
import { updateRuntimeState } from "./state/store";
import { correlationId } from "./shared/ids";

// Shutdown sequence (specification §14), milestone 2 slice:
// stop accepting commands -> stop scheduler -> stop engine loop and feeds ->
// persist state -> flush -> close DB.
let shuttingDown = false;

export async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const cid = correlationId("shutdown");
  const log = createLogger("shutdown", cid);
  log.info("shutdown requested", { reason });
  updateRuntimeState({ engineStatus: "STOPPED" }, `shutdown: ${reason}`, cid);
  await stopScheduler();
  await stopEngineLoop();
  await closeDatabase();
  log.info("shutdown complete");
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
