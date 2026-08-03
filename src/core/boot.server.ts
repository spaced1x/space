import { describeEnvReadiness, loadEnv } from "./config/env.server";
import { databaseHealth, initDatabase } from "./db/database.server";
import { registerHealthCheck } from "./health/registry";
import { installFileSink } from "./logging/file-sink.server";
import { configureLogging, createLogger } from "./logging/logger";
import { eventBus } from "./bus/events";
import { getRuntimeState, updateRuntimeState } from "./state/store";
import { correlationId } from "./shared/ids";

// Startup sequence (specification §13), foundation slice:
// Boot -> Env -> Logging -> DB -> Health -> OBSERVE.
// Discovery, feeds, wallet, Telegram and recovery attach in later milestones.
let bootPromise: Promise<void> | undefined;

export async function boot(): Promise<void> {
  if (!bootPromise) bootPromise = runBoot();
  return bootPromise;
}

async function runBoot(): Promise<void> {
  const cid = correlationId("boot");
  const env = loadEnv();
  configureLogging({ level: env.LOG_LEVEL });
  const fileSink = await installFileSink({
    dir: env.LOG_DIR,
    maxBytes: env.LOG_MAX_BYTES,
    maxFiles: env.LOG_MAX_FILES,
  });
  const log = createLogger("boot", cid);
  log.info("SPACE starting", { environment: env.SPACE_ENVIRONMENT, nodeEnv: env.NODE_ENV });

  await initDatabase();

  registerHealthCheck("configuration", () => {
    const readiness = describeEnvReadiness();
    return {
      state: !readiness.valid ? "FAILED" : readiness.missingForArmed.length ? "DEGRADED" : "OK",
      message: readiness.message,
      details: { environment: readiness.environment, missingForArmed: readiness.missingForArmed },
    };
  });

  registerHealthCheck("database", databaseHealth);

  registerHealthCheck("logging", () => ({
    state: "OK",
    message: fileSink ? "console + rotating file sink" : "console sink only",
    details: { level: env.LOG_LEVEL, dir: env.LOG_DIR },
  }));

  registerHealthCheck("dashboard", () => ({
    state: "OK",
    message: "serving mission control",
  }));

  if (getRuntimeState().engineStatus === "BOOTING") {
    // Never auto-arm. OBSERVE is the only safe post-boot state.
    updateRuntimeState({ engineStatus: "OBSERVE" }, "boot complete", cid);
  }

  eventBus.publish({
    type: "process.booted",
    correlationId: cid,
    source: "boot",
    payload: { environment: env.SPACE_ENVIRONMENT },
  });
  log.info("SPACE ready in OBSERVE");
}