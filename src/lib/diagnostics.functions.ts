import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { boot } from "../core/boot.server";
import { loadEnv } from "../core/config/env.server";
import { eventBus } from "../core/bus/events";
import { engineRuntimeSnapshot } from "../core/engine/loop.server";
import { executionSnapshot } from "../core/execution/execution.server";
import { collectHealth } from "../core/health/registry";
import { getRuntimeState } from "../core/state/store";
import {
  clearAllFailureScenarios,
  clearFailureScenario,
  getFailureScenarios,
  registerFailureScenario,
} from "../core/validation/failure-simulation.server";

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

// Failure simulation harness. It exists so recovery paths can be exercised on a
// staging host; on a production host it is refused outright.
export const getFailureHarness = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  const production = loadEnv().NODE_ENV === "production";
  return { enabled: !production, scenarios: production ? [] : getFailureScenarios() };
});

const harnessCommand = z.object({
  action: z.enum(["register", "clear", "clear-all"]),
  name: z.string().trim().min(1).max(64).optional(),
  kind: z.enum(["throw", "timeout", "return"]).default("throw"),
  errorMessage: z.string().trim().max(200).default("simulated failure"),
  delayMs: z.number().int().min(0).max(60_000).optional(),
});

export const setFailureScenario = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => harnessCommand.parse(data))
  .handler(async ({ data }) => {
    await boot();
    if (loadEnv().NODE_ENV === "production") {
      return { ok: false, reason: "failure simulation is disabled on production hosts" };
    }
    if (data.action === "clear-all") clearAllFailureScenarios();
    else if (data.action === "clear" && data.name) clearFailureScenario(data.name);
    else if (data.action === "register" && data.name) {
      registerFailureScenario({
        name: data.name,
        active: true,
        kind: data.kind,
        errorMessage: data.errorMessage,
        delayMs: data.delayMs,
      });
    }
    return { ok: true, scenarios: getFailureScenarios() };
  });
