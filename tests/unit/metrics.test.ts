import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Metrics tests verify the snapshot shape without persisting to the database.

describe("runtime metrics snapshot", () => {
  beforeEach(() => {
    vi.stubGlobal("process", {
      ...process,
      memoryUsage: () => ({
        rss: 100 * 1024 * 1024,
        heapUsed: 50 * 1024 * 1024,
        heapTotal: 80 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      }),
      cpuUsage: () => ({ user: 1_000_000, system: 500_000 }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("captures memory and cpu in MB/seconds", async () => {
    vi.doMock("../../src/core/scheduler/scheduler.server", () => ({
      schedulerStatus: () => ({ maxTickDriftMs: 12, ticks: 123 }),
    }));

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
