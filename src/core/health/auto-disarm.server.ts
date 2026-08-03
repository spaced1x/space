import { dispatchCommand } from "../bus/command-bus.server";
import { collectHealth } from "../health/registry";
import { createLogger } from "../logging/logger";
import { registerTask } from "../scheduler/scheduler.server";
import { getRuntimeState } from "../state/store";
import { correlationId } from "../shared/ids";

// Auto-disarm guard.
//
// When the engine is ARMED and a critical dependency becomes unhealthy, the
// safest operator-neutral action is to disarm. This is a last resort: it stops
// new strategy intents but does NOT cancel orders already in flight.

const log = createLogger("auto-disarm");

const AUTO_DISARM_INTERVAL_MS = 1000;

const CRITICAL_COMPONENTS = [
  "database",
  "scheduler",
  "execution",
  "risk",
  "wallet",
  "polymarket",
];

export function registerAutoDisarmTask(): void {
  registerTask({
    name: "auto-disarm",
    intervalMs: AUTO_DISARM_INTERVAL_MS,
    run: async () => {
      const state = getRuntimeState();
      if (state.engineStatus !== "ARMED") return;

      const report = await collectHealth();
      const failed = report.components.filter(
        (entry) => CRITICAL_COMPONENTS.includes(entry.component) && (entry.state === "FAILED" || entry.state === "DEGRADED"),
      );
      if (!failed.length) return;

      const names = failed.map((entry) => entry.component).join(", ");
      const cid = correlationId("auto-disarm");
      log.error("critical health failure while ARMED; auto-disarming", {
        components: names,
        correlationId: cid,
      });
      await dispatchCommand(
        { kind: "DISARM" },
        { actor: "system", source: "system", correlationId: cid },
      );
    },
  });
}
