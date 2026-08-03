import { beforeEach, describe, expect, it } from "vitest";

import {
  registerTask,
  resetSchedulerForTests,
  runDueTasksForTests,
  schedulerHealth,
  schedulerStatus,
} from "../../src/core/scheduler/scheduler.server";

describe("runtime scheduler", () => {
  beforeEach(() => {
    resetSchedulerForTests();
  });

  it("rejects tasks faster than the heartbeat", () => {
    expect(() => registerTask({ name: "too-fast", intervalMs: 10, run: () => {} })).toThrow();
  });

  it("runs due tasks exactly once per tick and records them", async () => {
    let runs = 0;
    registerTask({ name: "a", intervalMs: 100, runOnStart: true, run: () => void runs++ });
    await runDueTasksForTests();
    expect(runs).toBe(1);
    const status = schedulerStatus();
    expect(status.tasks[0]?.runs).toBe(1);
    expect(status.tasks[0]?.failures).toBe(0);
  });

  it("captures task failures without stopping the loop", async () => {
    registerTask({
      name: "boom",
      intervalMs: 100,
      runOnStart: true,
      run: () => {
        throw new Error("nope");
      },
    });
    registerTask({ name: "fine", intervalMs: 100, runOnStart: true, run: () => {} });
    await runDueTasksForTests();
    const status = schedulerStatus();
    expect(status.tasks.find((t) => t.name === "boom")?.failures).toBe(1);
    expect(status.tasks.find((t) => t.name === "fine")?.runs).toBe(1);
  });

  it("reports DISABLED while stopped", () => {
    expect(schedulerHealth().state).toBe("DISABLED");
  });
});