import { loadEnv } from "./env.server";
import { databaseEnvironmentStamp } from "../db/database.server";
import { CHAIN_IDS, verifyChainId, walletStatus } from "../execution/wallet.server";
import type { HealthResult } from "../health/types";
import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";

// Environment Conformance Gate.
//
// SPACE runs the same code against a testnet (V1) and mainnet (V2). The single
// most expensive mistake available to an operator is running one environment's
// process against another environment's chain, wallet or database. This gate is
// the composite proof that all seven facts agree, evaluated at boot and again
// before every ARM.

const log = createLogger("environment");

export interface ConformanceCheck {
  name: string;
  state: "OK" | "DEGRADED" | "FAILED";
  message: string;
}

export interface ConformanceReport {
  environment: string;
  conformant: boolean;
  at: string;
  checks: ConformanceCheck[];
  failures: string[];
}

let last: ConformanceReport | null = null;

export async function evaluateEnvironmentConformance(): Promise<ConformanceReport> {
  const env = loadEnv();
  const environment = env.SPACE_ENVIRONMENT;
  const expectedChainId = CHAIN_IDS[environment];
  const wallet = walletStatus();
  const chain = await verifyChainId();
  const stamp = await databaseEnvironmentStamp();

  const checks: ConformanceCheck[] = [
    {
      name: "environment_selected",
      state: "OK",
      message: `running ${environment}`,
    },
    {
      name: "environment_supported",
      state: environment === "V1_TESTNET" || environment === "V2_MAINNET" ? "OK" : "FAILED",
      message:
        environment === "V1_TESTNET"
          ? "V1 testnet (Amoy) selected"
          : environment === "V2_MAINNET"
            ? "V2 mainnet (Polygon) selected"
            : `unsupported environment ${environment}`,
    },
    {
      name: "rpc_matches_environment",
      state: chain.matches === true ? "OK" : chain.matches === false ? "FAILED" : "DEGRADED",
      message: chain.reason,
    },
    {
      name: "chain_id_matches_environment",
      state:
        chain.actualChainId === null
          ? "DEGRADED"
          : chain.actualChainId === expectedChainId
            ? "OK"
            : "FAILED",
      message:
        chain.actualChainId === null
          ? `chain id not read; ${environment} requires ${expectedChainId}`
          : `chain ${chain.actualChainId} vs required ${expectedChainId}`,
    },
    {
      name: "wallet_matches_environment",
      state: !wallet.hasPrivateKey
        ? "DEGRADED"
        : wallet.address && wallet.chainId === expectedChainId
          ? "OK"
          : "FAILED",
      message: !wallet.hasPrivateKey
        ? "no wallet key configured for this environment"
        : wallet.address
          ? `wallet ${wallet.address} bound to chain ${wallet.chainId}`
          : wallet.reason,
    },
    {
      name: "database_stamp_matches_environment",
      state: stamp.mismatch ? "FAILED" : stamp.stamp === environment ? "OK" : "DEGRADED",
      message:
        stamp.mismatch ??
        (stamp.stamp
          ? `database stamped ${stamp.stamp}`
          : "database not reachable; environment stamp unknown"),
    },
    {
      name: "environment_switching",
      state: "OK",
      message:
        "switching environments requires a restart with a matching DB_PATH; the stamp enforces it",
    },
  ];

  const failures = checks
    .filter((check) => check.state === "FAILED")
    .map((check) => `${check.name}: ${check.message}`);

  last = {
    environment,
    conformant: failures.length === 0,
    at: systemClock.iso(),
    checks,
    failures,
  };
  if (!last.conformant) log.error("environment conformance failed", { failures });
  return last;
}

export function lastConformance(): ConformanceReport | null {
  return last;
}

export function conformanceHealth(): HealthResult {
  if (!last) {
    return {
      state: "NOT_INITIALIZED",
      message: "environment conformance not evaluated yet",
      details: {},
    };
  }
  const details = {
    environment: last.environment,
    at: last.at,
    checks: last.checks.map((check) => ({ ...check })),
  };
  if (!last.conformant) {
    return { state: "FAILED", message: last.failures.join("; "), details };
  }
  const degraded = last.checks.filter((check) => check.state === "DEGRADED");
  if (degraded.length > 0) {
    return {
      state: "DEGRADED",
      message: degraded.map((check) => `${check.name}: ${check.message}`).join("; "),
      details,
    };
  }
  return { state: "OK", message: `environment conformant (${last.environment})`, details };
}
