import { createLogger } from "../logging/logger";

const log = createLogger("failure-simulation");

// Internal validation harness. These hooks are intentionally narrow: they let
// automated tests and the operator exercise recovery paths without changing
// production logic. They are only active when explicitly enabled and never
// alter persisted state.

export interface FailureScenario {
  name: string;
  active: boolean;
  kind: "throw" | "timeout" | "return";
  errorMessage: string;
  delayMs?: number;
  returnValue?: unknown;
}

const scenarios = new Map<string, FailureScenario>();

export function registerFailureScenario(scenario: FailureScenario): void {
  scenarios.set(scenario.name, scenario);
  log.warn("failure scenario registered", { name: scenario.name, kind: scenario.kind });
}

export function clearFailureScenario(name: string): void {
  scenarios.delete(name);
  log.info("failure scenario cleared", { name });
}

export function clearAllFailureScenarios(): void {
  scenarios.clear();
  log.info("all failure scenarios cleared");
}

export function getFailureScenarios(): FailureScenario[] {
  return Array.from(scenarios.values());
}

export async function applyFailureScenario<T>(
  name: string,
  normal: () => Promise<T> | T,
): Promise<T> {
  const scenario = scenarios.get(name);
  if (!scenario || !scenario.active) return normal();

  log.warn("applying failure scenario", { name, kind: scenario.kind });

  if (scenario.delayMs && scenario.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
  }

  switch (scenario.kind) {
    case "throw":
      throw new Error(scenario.errorMessage);
    case "timeout":
      await new Promise(() => undefined); // never resolves
      throw new Error("unreachable");
    case "return":
      return scenario.returnValue as T;
    default:
      return normal();
  }
}

export function applyFailureScenarioSync<T>(name: string, normal: () => T): T {
  const scenario = scenarios.get(name);
  if (!scenario || !scenario.active) return normal();

  log.warn("applying failure scenario (sync)", { name, kind: scenario.kind });

  switch (scenario.kind) {
    case "throw":
      throw new Error(scenario.errorMessage);
    case "return":
      return scenario.returnValue as T;
    default:
      return normal();
  }
}
