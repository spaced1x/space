import { ConfigError } from "../shared/errors";
import { ARMED_REQUIRED_KEYS, envSchema, type SpaceEnv } from "./env.schema";

// Single validation point. Read inside handlers only — env injection happens
// at call time, never at module scope.
let cached: SpaceEnv | undefined;

export function loadEnv(source: Record<string, string | undefined> = process.env): SpaceEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new ConfigError(
      `SPACE cannot start: invalid environment.\n${issues.join("\n")}\nSee .env.example for the full contract.`,
      { issues: parsed.error.issues },
    );
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * Resolve the SQLite database path for the active environment.
 * If DB_PATH is explicitly set, it wins. Otherwise SPACE uses per-environment
 * isolation: space-v1.db for V1_TESTNET, space-v2.db for V2_MAINNET.
 */
export function resolveDbPath(env?: SpaceEnv): string {
  const e = env ?? loadEnv();
  if (e.DB_PATH) return e.DB_PATH;
  const suffix = e.SPACE_ENVIRONMENT === "V2_MAINNET" ? "v2" : "v1";
  return `./data/space-${suffix}.db`;
}

export interface EnvReadiness {
  environment: SpaceEnv["SPACE_ENVIRONMENT"];
  valid: boolean;
  missingForArmed: string[];
  message: string;
}

// Configuration health: the process always boots, but it reports precisely
// which secrets still block the READY -> RUNNING transition.
export function describeEnvReadiness(): EnvReadiness {
  try {
    const env = loadEnv();
    const missing = ARMED_REQUIRED_KEYS.filter((key) => !env[key]);
    return {
      environment: env.SPACE_ENVIRONMENT,
      valid: true,
      missingForArmed: [...missing],
      message: missing.length
        ? `${missing.length} secret(s) missing; engine is limited to READY`
        : "all required secrets present",
    };
  } catch (error) {
    return {
      environment: "V1_TESTNET",
      valid: false,
      missingForArmed: [...ARMED_REQUIRED_KEYS],
      message: error instanceof Error ? error.message : "environment validation failed",
    };
  }
}
