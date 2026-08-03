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

export interface EnvReadiness {
  environment: SpaceEnv["SPACE_ENVIRONMENT"];
  valid: boolean;
  missingForArmed: string[];
  message: string;
}

// Configuration health: the process always boots, but it reports precisely
// which secrets still block the OBSERVE -> ARMED transition.
export function describeEnvReadiness(): EnvReadiness {
  try {
    const env = loadEnv();
    const missing = ARMED_REQUIRED_KEYS.filter((key) => !env[key]);
    return {
      environment: env.SPACE_ENVIRONMENT,
      valid: true,
      missingForArmed: [...missing],
      message: missing.length
        ? `${missing.length} secret(s) missing; engine is limited to OBSERVE`
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
