import { describeEnvReadiness, loadEnv } from "./config/env.server";
import { databaseHealth, initDatabase } from "./db/database.server";
import { registerAutoDisarmTask } from "./health/auto-disarm.server";
import { registerHealthCheck } from "./health/registry";
import { installFileSink } from "./logging/file-sink.server";
import { configureLogging, createLogger } from "./logging/logger";
import { eventBus } from "./bus/events";
import { getRuntimeState, loadRuntimeState, updateRuntimeState } from "./state/store";
import { correlationId } from "./shared/ids";
import { registerClockService } from "./clock/clock.service";
import { loadOperations, operationsHealth } from "./config/operations.server";
import { replayHealth } from "./replay/replay.server";
import { statisticsHealth } from "./stats/statistics.server";
import { engineHealth, feeds, startEngineLoop } from "./engine/loop.server";
import { discoveryHealth } from "./market/discovery.server";
import { registerTask, schedulerHealth, startScheduler } from "./scheduler/scheduler.server";
import { settlementTwapHealth, strategyHealth } from "./strategy/strategy.server";
import { executionHealth, riskHealth } from "./execution/execution.server";
import { polymarketAdapter } from "./execution/polymarket.server";
import { walletHealth } from "./execution/wallet.server";
import { registerTelegramEventForwarding } from "./telegram/telegram.service";
import { telegramServiceHealth } from "./telegram/telegram.health";
import { backupServiceHealth } from "./backup/backup.health";
import { performBackup } from "./backup/backup.service";

// Startup sequence (specification §13), milestone 2 slice:
// Boot -> Env -> Logging -> DB -> Clock -> Health -> Scheduler -> Engine loop
// (feeds + discovery) -> OBSERVE.
// Wallet, Telegram and recovery attach in later milestones.
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

  // Operational settings live in SQLite, never in .env. Restore the operator's
  // configuration document before anything reads it.
  await loadOperations();

  // Runtime state is authoritative in memory but persisted for graceful restart
  // continuity. Never restore into ARMED; a reboot always demands an explicit ARM.
  await loadRuntimeState();

  // Clock is a first-class service: registered before anything schedules work.
  registerClockService();

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

  registerHealthCheck("scheduler", schedulerHealth);
  registerHealthCheck("engine", engineHealth);
  registerHealthCheck("market_discovery", discoveryHealth);
  registerHealthCheck("settlement_twap", settlementTwapHealth);
  registerHealthCheck("strategy", strategyHealth);
  registerHealthCheck("wallet", walletHealth);
  registerHealthCheck("polymarket", () => polymarketAdapter.health());
  registerHealthCheck("risk", riskHealth);
  registerHealthCheck("execution", executionHealth);
  registerHealthCheck("operations", operationsHealth);
  registerHealthCheck("replay", replayHealth);
  registerHealthCheck("statistics", statisticsHealth);
  registerHealthCheck("binance", () => feedHealth("binance"));
  registerHealthCheck("chainlink", () => feedHealth("chainlink"));

  // Windows are implemented switches, so they report DISABLED (not
  // NOT_INITIALIZED) whenever the operator turns them off.
  registerHealthCheck("window_5m", () => windowHealth("fiveMinute", "BTC 5 minute"));
  registerHealthCheck("window_15m", () => windowHealth("fifteenMinute", "BTC 15 minute"));

  // Timers exist only after the scheduler is up, and the engine loop registers
  // its tasks with that one scheduler rather than owning timers of its own.
  await startScheduler();
  registerAutoDisarmTask();
  await startEngineLoop();

  if (getRuntimeState().engineStatus === "BOOTING") {
    // Never auto-arm. OBSERVE is the only safe post-boot state.
    updateRuntimeState({ engineStatus: "OBSERVE" }, "boot complete", cid);
  }

  eventBus.publish({
    type: "process.booted",
    severity: "SUCCESS",
    correlationId: cid,
    source: "boot",
    payload: { environment: env.SPACE_ENVIRONMENT },
  });
  log.info("SPACE ready in OBSERVE");
}

function feedHealth(name: "binance" | "chainlink") {
  const feed = feeds()[name];
  if (!feed) {
    return {
      state: "NOT_INITIALIZED" as const,
      message: "feed adapter not constructed yet",
    };
  }
  return feed.health();
}

function windowHealth(key: "fiveMinute" | "fifteenMinute", label: string) {
  const state = getRuntimeState();
  const enabled = state.windows[key];
  return {
    state: enabled ? ("OK" as const) : ("DISABLED" as const),
    message: enabled ? `${label} window enabled` : `${label} window switched off by operator`,
    details: { window: label, enabled, engineStatus: state.engineStatus },
  };
}
