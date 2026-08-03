import { beforeEach, describe, expect, it } from "vitest";

import {
  applyFailureScenario,
  applyFailureScenarioSync,
  clearAllFailureScenarios,
  registerFailureScenario,
} from "../../src/core/validation/failure-simulation.server";

describe("failure simulation", () => {
  beforeEach(() => {
    clearAllFailureScenarios();
  });

  it("runs normally when no scenario is active", async () => {
    const result = await applyFailureScenario("none", () => "ok");
    expect(result).toBe("ok");
  });

  it("throws when a throw scenario is active", async () => {
    registerFailureScenario({
      name: "boom",
      active: true,
      kind: "throw",
      errorMessage: "injected failure",
    });
    await expect(applyFailureScenario("boom", () => "ok")).rejects.toThrow("injected failure");
  });

  it("returns a fixed value when a return scenario is active", async () => {
    registerFailureScenario({
      name: "fixed",
      active: true,
      kind: "return",
      errorMessage: "",
      returnValue: 42,
    });
    const result = await applyFailureScenario("fixed", () => "ok");
    expect(result).toBe(42);
  });

  it("supports sync injection", () => {
    registerFailureScenario({
      name: "sync-boom",
      active: true,
      kind: "throw",
      errorMessage: "sync injected",
    });
    expect(() => applyFailureScenarioSync("sync-boom", () => "ok")).toThrow("sync injected");
  });
});
