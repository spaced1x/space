import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { loadEnv } from "../core/config/env.server";
import { ENVIRONMENT_MANIFEST, unknownEnvKeys } from "../core/config/manifest";
import { eventBus } from "../core/bus/events";
import { engineRuntimeSnapshot } from "../core/engine/loop.server";
import { executionSnapshot } from "../core/execution/execution.server";
import { collectHealth } from "../core/health/registry";
import { getRuntimeState } from "../core/state/store";
import {
  clearAllFailureScenarios,
  clearFailureScenario,
  FAULT_TARGETS,
  FAULT_TARGET_LABELS,
  getFailureScenarios,
  registerFailureScenario,
} from "../core/validation/failure-simulation.server";

// Read-only diagnostics. Every value comes from the running engine; the page
// itself owns nothing and can change nothing.
export const getDiagnostics = createServerFn({ method: "GET" }).handler(async () => {
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

/**
 * The environment contract as the running process sees it. Secret values are
 * never sent: the operator learns only whether a credential is present.
 */
export const getEnvironmentManifest = createServerFn({ method: "GET" }).handler(async () => {
  return {
    unknown: unknownEnvKeys(process.env),
    variables: ENVIRONMENT_MANIFEST.map((entry) => {
      const raw = process.env[entry.name];
      const set = raw !== undefined && raw !== "";
      return {
        name: entry.name,
        group: entry.group,
        secret: entry.secret,
        requiredForArmed: entry.requiredForArmed,
        description: entry.description,
        set,
        value: entry.secret ? (set ? "••••••••" : "") : (raw ?? ""),
        usingDefault: !set,
      };
    }),
  };
});

// Serializable projection: the scenario's returnValue is deliberately not sent
// to the browser, it can hold any shape.
interface HarnessScenarioView {
  name: string;
  active: boolean;
  kind: "throw" | "timeout" | "return";
  errorMessage: string;
  delayMs: number | null;
}

function harnessView(): HarnessScenarioView[] {
  return getFailureScenarios().map((scenario) => ({
    name: scenario.name,
    active: scenario.active,
    kind: scenario.kind,
    errorMessage: scenario.errorMessage,
    delayMs: scenario.delayMs ?? null,
  }));
}

// Failure simulation harness. It exists so recovery paths can be exercised on a
// staging host; on a production host it is refused outright.
export const getFailureHarness = createServerFn({ method: "GET" }).handler(async () => {
  const production = loadEnv().NODE_ENV === "production";
  return {
    enabled: !production,
    // The catalogue is the injectable surface: every entry is wired to a real
    // dependency call site, so the operator cannot arm a drill that does nothing.
    targets: FAULT_TARGETS.map((target) => ({ name: target, label: FAULT_TARGET_LABELS[target] })),
    scenarios: production ? ([] as HarnessScenarioView[]) : harnessView(),
  };
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
    if (loadEnv().NODE_ENV === "production") {
      return {
        ok: false,
        reason: "failure simulation is disabled on production hosts",
        scenarios: [] as HarnessScenarioView[],
      };
    }
    if (data.action === "clear-all") clearAllFailureScenarios();
    else if (data.action === "clear" && data.name) clearFailureScenario(data.name);
    else if (data.action === "register" && data.name) {
      registerFailureScenario({
        name: data.name,
        active: true,
        kind: data.kind,
        errorMessage: data.errorMessage,
        ...(data.delayMs === undefined ? {} : { delayMs: data.delayMs }),
      });
    }
    return { ok: true, reason: "", scenarios: harnessView() };
  });
