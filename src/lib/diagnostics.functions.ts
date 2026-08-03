import { createServerFn } from "@tanstack/react-start";

import { boot } from "../core/boot.server";
import { eventBus } from "../core/bus/events";
import { engineRuntimeSnapshot } from "../core/engine/loop.server";
import { executionSnapshot } from "../core/execution/execution.server";
import { collectHealth } from "../core/health/registry";
import { getRuntimeState } from "../core/state/store";

// Read-only diagnostics. Every value comes from the running engine; the page
// itself owns nothing and can change nothing.
export const getDiagnostics = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  const events = eventBus.recent(60);
  return {
    runtime: getRuntimeState(),
    health: await collectHealth(),
    engine: engineRuntimeSnapshot(),
    execution: executionSnapshot(),
    events,
    errors: events.filter((event) => event.severity === "ERROR" || event.severity === "WARNING"),
  };
});
