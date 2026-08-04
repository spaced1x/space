import { createLogger } from "../logging/logger";

const log = createLogger("failure-simulation");

// Internal validation harness. These hooks are intentionally narrow: they let
// automated tests and the operator exercise recovery paths without changing
// production logic. They are only active when explicitly enabled and never
// alter persisted state.
//
// Every dependency SPACE can lose has a named fault target, and every target is
// wired to a real call site. A target with no call site would make the recovery
// report a lie, so the catalogue and the wiring are verified by a test.

export const FAULT_TARGETS = [
  "gamma",
  "polygon_rpc",
  "wallet",
  "telegram",
  "settlement",
  "chainlink",
  "binance",
  "rtds",
  "clob_market_ws",
  "clob_trading",
  "sqlite",
  "snapshot",
] as const;

export type FaultTarget = (typeof FAULT_TARGETS)[number];

export const FAULT_TARGET_LABELS: Record<FaultTarget, string> = {
  gamma: "Gamma API (market discovery)",
  polygon_rpc: "Polygon RPC",
  wallet: "Wallet / balance reads",
  telegram: "Telegram API",
  settlement: "Settlement ingestion",
  chainlink: "Chainlink price feed",
  binance: "Binance websocket",
  rtds: "Polymarket RTDS websocket",
  clob_market_ws: "CLOB market websocket",
  clob_trading: "CLOB trading API",
  sqlite: "SQLite (busy / lock contention)",
  snapshot: "Runtime snapshot generation",
};

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

/** Sync probe for call sites that cannot await, such as socket construction. */
export function activeFailureScenario(name: string): FailureScenario | null {
  const scenario = scenarios.get(name);
  return scenario && scenario.active ? scenario : null;
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
      // The delay above already held the caller. A scenario that never settles
      // would leak that promise for the life of the process, so the hang is
      // bounded and then reported as a timeout — which is what the real
      // dependency does anyway.
      throw new Error(`${scenario.errorMessage} (simulated timeout)`);
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
