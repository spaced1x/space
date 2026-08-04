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
describe("scheduler jitter and duplicate detection", () => {
  beforeEach(() => {
    resetSchedulerForTests();
  });

  it("records jitter for every run", async () => {
    registerTask({ name: "jitter", intervalMs: 100, runOnStart: true, run: () => {} });
    await runDueTasksForTests();
    const task = schedulerStatus().tasks[0]!;
    expect(task.lastJitterMs).not.toBeNull();
    expect(task.maxJitterMs).toBeGreaterThanOrEqual(0);
    expect(task.avgJitterMs).not.toBeNull();
  });

  it("counts a duplicate registration and reports it as degraded", async () => {
    registerTask({ name: "dup", intervalMs: 100, runOnStart: true, run: () => {} });
    registerTask({ name: "dup", intervalMs: 100, runOnStart: true, run: () => {} });
    const status = schedulerStatus();
    expect(status.tasks).toHaveLength(1);
    expect(status.duplicateRegistrations).toBe(1);
    await runDueTasksForTests();
    expect(schedulerHealth().detail).toContain("duplicate");
  });

  it("counts missed slots when a run overruns its interval", async () => {
    registerTask({
      name: "slow",
      intervalMs: 100,
      runOnStart: true,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 260));
      },
    });
    await runDueTasksForTests();
    expect(schedulerStatus().tasks[0]!.missedRuns).toBeGreaterThan(0);
  });
});
