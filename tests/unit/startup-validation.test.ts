import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Startup validation pulls in the whole core. We test the pure report-building
// logic by mocking the heavy dependencies.

describe("startup validation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports valid when all required items are OK", async () => {
    vi.doMock("../../src/core/config/env.server", () => ({
      loadEnv: () => ({
        DB_PATH: "./data/space.db",
        SPACE_ENVIRONMENT: "V1_TESTNET",
        NODE_ENV: "test",
      }),
      describeEnvReadiness: () => ({
        valid: true,
        missingForArmed: [],
        message: "env ready",
        environment: "V1_TESTNET",
      }),
    }));

    vi.doMock("../../src/core/db/database.server", () => ({
      databaseHealth: async () => ({ state: "OK", message: "db ok" }),
      databaseEnvironmentStamp: async () => ({ ok: true, stamped: "V1_TESTNET", expected: "V1_TESTNET", message: "environment stamp matches" }),
    }));

    vi.doMock("../../src/core/config/operations.server", () => ({
      activeOperations: () => ({ version: 1 }),
      operationsHealth: () => ({ state: "OK", message: "ops ok" }),
    }));

    vi.doMock("../../src/core/db/lock.server", () => ({
      instanceLockHeld: () => true,
    }));

    vi.doMock("../../src/core/execution/execution.server", () => ({
      executionRecoveryStatus: () => ({ state: "OK", message: "recovered" }),
    }));

    vi.doMock("../../src/core/state/store", () => ({
      getRuntimeState: () => ({
        engineStatus: "OBSERVE",
        emergencyStop: false,
        emergencyStopReason: null,
      }),
    }));

    vi.doMock("../../src/core/health/registry", () => ({
      collectHealth: async () => ({
        state: "OK",
        components: [
          { component: "wallet", state: "OK", message: "wallet ok" },
          { component: "polymarket", state: "OK", message: "polymarket ok" },
          { component: "binance", state: "OK", message: "binance ok" },
          { component: "chainlink", state: "OK", message: "chainlink ok" },
        ],
      }),
    }));

    const { runStartupValidation } = await import("../../src/core/startup/validation.server");
    const report = await runStartupValidation();
    expect(report.valid).toBe(true);
    expect(report.blockers).toHaveLength(0);
  });

  it("blocks when emergency stop is latched", async () => {
    vi.doMock("../../src/core/config/env.server", () => ({
      loadEnv: () => ({
        DB_PATH: "./data/space.db",
        SPACE_ENVIRONMENT: "V1_TESTNET",
        NODE_ENV: "test",
      }),
      describeEnvReadiness: () => ({
        valid: true,
        missingForArmed: [],
        message: "env ready",
        environment: "V1_TESTNET",
      }),
    }));

    vi.doMock("../../src/core/db/database.server", () => ({
      databaseHealth: async () => ({ state: "OK", message: "db ok" }),
      databaseEnvironmentStamp: async () => ({ ok: true, stamped: "V1_TESTNET", expected: "V1_TESTNET", message: "environment stamp matches" }),
    }));

    vi.doMock("../../src/core/config/operations.server", () => ({
      activeOperations: () => ({ version: 1 }),
      operationsHealth: () => ({ state: "OK", message: "ops ok" }),
    }));

    vi.doMock("../../src/core/db/lock.server", () => ({
      instanceLockHeld: () => true,
    }));

    vi.doMock("../../src/core/execution/execution.server", () => ({
      executionRecoveryStatus: () => ({ state: "OK", message: "recovered" }),
    }));

    vi.doMock("../../src/core/state/store", () => ({
      getRuntimeState: () => ({
        engineStatus: "OBSERVE",
        emergencyStop: true,
        emergencyStopReason: "operator panic",
      }),
    }));

    vi.doMock("../../src/core/health/registry", () => ({
      collectHealth: async () => ({ state: "OK", components: [] }),
    }));

    const { runStartupValidation } = await import("../../src/core/startup/validation.server");
    const report = await runStartupValidation();
    expect(report.valid).toBe(false);
    expect(report.blockers.some((b) => b.includes("emergency_stop"))).toBe(true);
  });
});
