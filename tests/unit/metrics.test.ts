import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as scheduler from "../../src/core/scheduler/scheduler.server";

// Metrics tests verify the snapshot shape without persisting to the database.

describe("runtime metrics snapshot", () => {
  let originalMemoryUsage: typeof process.memoryUsage;
  let originalCpuUsage: typeof process.cpuUsage;
  let schedulerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalMemoryUsage = process.memoryUsage;
    originalCpuUsage = process.cpuUsage;
    process.memoryUsage = () => ({
      rss: 100 * 1024 * 1024,
      heapUsed: 50 * 1024 * 1024,
      heapTotal: 80 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 5 * 1024 * 1024,
    });
    process.cpuUsage = () => ({ user: 1_000_000, system: 500_000 });
    schedulerSpy = vi
      .spyOn(scheduler, "schedulerStatus")
      .mockReturnValue({ maxTickDriftMs: 12, ticks: 123 } as any);
  });

  afterEach(() => {
    process.memoryUsage = originalMemoryUsage;
    process.cpuUsage = originalCpuUsage;
    schedulerSpy.mockRestore();
  });

  it("captures memory and cpu in MB/seconds", async () => {
    const { captureMetricsSnapshot } = await import("../../src/core/metrics/metrics.server");
    const snapshot = captureMetricsSnapshot();
    expect(snapshot.memoryRssMb).toBe(100);
    expect(snapshot.memoryHeapMb).toBe(50);
    expect(snapshot.cpuUserSeconds).toBe(1);
    expect(snapshot.cpuSystemSeconds).toBe(0.5);
    expect(snapshot.schedulerDriftMs).toBe(12);
    expect(snapshot.schedulerTicks).toBe(123);
    expect(snapshot.sampledAt).toBeDefined();
  });
});
