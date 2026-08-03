import { closeDatabase } from "./db/database.server";
import { releaseInstanceLock } from "./db/lock.server";
import { stopEngineLoop } from "./engine/loop.server";
import { clearTasks, stopScheduler } from "./scheduler/scheduler.server";
import { stopTelegramInbound } from "./telegram/inbound.server";
import { stopTelegramEventForwarding } from "./telegram/telegram.service";
import { resetPolymarketAdapter } from "./execution/polymarket.server";
import { resetWallet } from "./execution/wallet.server";
import { resetProviderRegistry } from "./twap/registry.server";
import { resetMarketState } from "./market/state";
import { stopClobMarketFeed } from "./market/clob-ws.server";
import { resetPaperVenue } from "./execution/paper.server";
import { resetOperations } from "./config/operations.server";
import { clearHealthChecks } from "./health/registry";
import { resetConnections } from "./runtime/connections.server";
import { invalidatePeek } from "./runtime/peek.server";
import { eventBus } from "./bus/events";
import { createLogger } from "./logging/logger";
import { updateRuntimeState } from "./state/store";
import { correlationId } from "./shared/ids";
import { auditRuntimeResources, type RuntimeResourceAudit } from "./runtime/resources.server";

// Shutdown sequence (specification §14).
//
// One teardown path serves process exit, operator STOP and environment SWITCH.
// It must leave the process owning nothing: no timer, no socket, no database
// handle, no lock file and no event subscriber. The resource audit that follows
// it is the proof, not the intention.
let shuttingDown = false;
let processExiting = false;

/**
 * Destroy the running runtime completely. Safe to call when nothing is running.
 * Returns the resource audit proving every count is back to zero.
 */
export async function teardownRuntime(reason: string): Promise<RuntimeResourceAudit> {
  if (shuttingDown) {
    return auditRuntimeResources("STOP", "STOPPED");
  }
  shuttingDown = true;
  const cid = correlationId("shutdown");
  const log = createLogger("shutdown", cid);
  log.info("runtime teardown requested", { reason });

  try {
    updateRuntimeState({ lifecycle: "STOPPING" }, `stopping: ${reason}`, cid);

    // Inbound first: stop accepting operator input before anything it could
    // command disappears underneath it.
    stopTelegramInbound();
    stopTelegramEventForwarding();

    // Timers, then the work those timers drive, then the registrations.
    await stopScheduler();
    await stopEngineLoop();
    clearTasks();

    // Venue, wallet and provider singletons hold sockets and signers.
    resetPolymarketAdapter();
    resetPaperVenue();
    stopClobMarketFeed();
    resetWallet();
    resetProviderRegistry();

    // In-memory projections belong to the environment that produced them.
    resetMarketState();
    resetOperations();
    resetConnections();
    clearHealthChecks();
    invalidatePeek();

    // Persist the final state while storage is still attached.
    updateRuntimeState(
      { lifecycle: "STOPPED", shutdownReason: reason },
      `stopped: ${reason}`,
      cid,
    );

    // No listener generation may survive; the next boot re-subscribes.
    eventBus.clearSubscribers();

    // Let the best-effort state write finish before the handle goes away.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Storage last: everything above may still want to write on the way out.
    await closeDatabase();
    // A late best-effort write can re-attach the handle; close it again so the
    // audit that follows can only ever see zero open databases.
    await closeDatabase();
    releaseInstanceLock();
    log.info("runtime teardown complete", { reason });
  } finally {
    shuttingDown = false;
  }

  return auditRuntimeResources("STOP", "STOPPED");
}

/** Process-level shutdown. Runs the same teardown, then latches. */
export async function shutdown(reason: string): Promise<void> {
  if (processExiting) return;
  processExiting = true;
  await teardownRuntime(reason);
}

export function isShuttingDown(): boolean {
  return shuttingDown || processExiting;
}
