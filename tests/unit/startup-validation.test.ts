import { describe, expect, it, vi, beforeEach } from "vitest";

const mockEnv = {
  loadEnv: vi.fn(() => ({
    DB_PATH: "./data/space.db",
    SPACE_ENVIRONMENT: "V1_TESTNET",
    NODE_ENV: "test",
  })),
  describeEnvReadiness: vi.fn(() => ({
    valid: true,
    missingForArmed: [],
    message: "env ready",
    environment: "V1_TESTNET",
  })),
};

const mockDatabaseHealth = vi.fn(async () => ({ state: "OK", message: "db ok" }));
const mockConformance = vi.fn(async () => ({
  environment: "V1_TESTNET",
  conformant: true,
  at: new Date().toISOString(),
  checks: [],
  failures: [],
}));

const mockOperations = {
  activeOperations: vi.fn(() => ({ version: 1 })),
  operationsHealth: vi.fn(() => ({ state: "OK", message: "ops ok" })),
};

const mockLock = { instanceLockHeld: vi.fn(() => true) };
const mockRecovery = {
  executionRecoveryStatus: vi.fn(() => ({ state: "OK", message: "recovered" })),
};

let runtimeState = {
  engineStatus: "OBSERVE",
  emergencyStop: false,
  emergencyStopReason: null,
};

const mockStore = { getRuntimeState: vi.fn(() => runtimeState) };

const mockHealth = {
  collectHealth: vi.fn(async () => ({
    state: "OK",
    components: [
      { component: "wallet", state: "OK", message: "wallet ok" },
      { component: "polymarket", state: "OK", message: "polymarket ok" },
      { component: "binance", state: "OK", message: "binance ok" },
      { component: "chainlink", state: "OK", message: "chainlink ok" },
    ],
  })),
};

vi.mock("../../src/core/config/env.server", () => mockEnv);
vi.mock("../../src/core/db/database.server", () => ({ databaseHealth: mockDatabaseHealth }));
vi.mock("../../src/core/config/environment.server", () => ({
  evaluateEnvironmentConformance: mockConformance,
}));
vi.mock("../../src/core/config/operations.server", () => mockOperations);
vi.mock("../../src/core/db/lock.server", () => mockLock);
vi.mock("../../src/core/execution/execution.server", () => mockRecovery);
vi.mock("../../src/core/state/store", () => mockStore);
vi.mock("../../src/core/health/registry", () => mockHealth);

// Startup validation pulls in the whole core. We test the pure report-building
// logic by mocking the heavy dependencies.

describe("startup validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeState = {
      engineStatus: "OBSERVE",
      emergencyStop: false,
      emergencyStopReason: null,
    };
  });

  it("reports valid when all required items are OK", async () => {
    const { runStartupValidation } = await import("../../src/core/startup/validation.server");
    const report = await runStartupValidation();
    expect(report.valid).toBe(true);
    expect(report.blockers).toHaveLength(0);
  });

  it("blocks when emergency stop is latched", async () => {
    runtimeState = {
      engineStatus: "OBSERVE",
      emergencyStop: true,
      emergencyStopReason: "operator panic",
    };
    mockHealth.collectHealth.mockResolvedValue({ state: "OK", components: [] });

    const { runStartupValidation } = await import("../../src/core/startup/validation.server");
    const report = await runStartupValidation();
    expect(report.valid).toBe(false);
    expect(report.blockers.some((b) => b.includes("emergency_stop"))).toBe(true);
  });
});
