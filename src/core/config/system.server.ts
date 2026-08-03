import { databaseHealth } from "../db/database.server";
import { describeEnvReadiness } from "./env.server";
import { loadEnv } from "./env.server";
import { systemClock } from "../shared/clock";

/** Read-only system information for the Settings workspace. Owns no state. */
export async function systemInformation() {
  const env = loadEnv();
  const database = await databaseHealth();
  return {
    generatedAt: systemClock.iso(),
    environment: {
      space: env.SPACE_ENVIRONMENT,
      node: env.NODE_ENV,
      port: env.PORT,
      logLevel: env.LOG_LEVEL,
      logDir: env.LOG_DIR,
      dbPath: env.DB_PATH,
      runtimeVersion: typeof process !== "undefined" ? process.version : "unknown",
    },
    readiness: describeEnvReadiness(),
    database: { state: database.state, message: database.message, details: database.details },
  };
}