import { describeEnvReadiness, loadEnv } from "./config/env.server";
import { databaseHealth, initDatabase } from "./db/database.server";
import { registerAutoDisarmTask } from "./health/auto-disarm.server";
import { registerHealthCheck } from "./health/registry";
import { conformanceHealth, evaluateEnvironmentConformance } from "./config/environment.server";
import { settlementHealth } from "./settlement/settlement.server";
import { installFileSink } from "./logging/file-sink.server";
import { configureLogging, createLogger } from "./logging/logger";
import { eventBus } from "./bus/events";
import { getRuntimeState, loadRuntimeState, updateRuntimeState } from "./state/store";
import { correlationId } from "./shared/ids";
import { registerClockService, clockServiceHealth } from "./clock/clock.service";
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
import { acquireInstanceLock, releaseInstanceLock } from "./db/lock.server";
import { runStartupValidation } from "./startup/validation.server";
import { sampleAndPersistMetrics } from "./metrics/metrics.server";
import { startTelegramInbound } from "./telegram/inbound.server";
import { noteTimeline, reportConnection } from "./runtime/connections.server";
import { syncConnections } from "./runtime/connection-sync.server";
import { verifyChainId } from "./execution/wallet.server";
import { refreshMarkets } from "./market/discovery.server";

// Startup sequence (specification §13), milestone 2 slice:
// Boot -> Env -> Logging -> DB -> Clock -> Health -> Scheduler -> Engine loop
// (feeds + discovery) -> OBSERVE.
// Wallet, Telegram and recovery attach in later milestones.
let bootPromise: Promise<void> | undefined;

export async function boot(): Promise<void> {
  if (!bootPromise) bootPromise = runBoot();
  return bootPromise;
}

export interface BootStageTrace {
  stage: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  nextStage?: string;
  error?: string;
}

const bootTrace: BootStageTrace[] = [];

let bootStartedAt: string | null = null;
let bootCompletedAt: string | null = null;

export function bootTimes(): { startedAt: string | null; completedAt: string | null } {
  return { startedAt: bootStartedAt, completedAt: bootCompletedAt };
}

/** Full boot trace: stage, started, completed, duration, next stage. */
export function getBootTrace(): BootStageTrace[] {
  return bootTrace.map((entry) => ({ ...entry }));
}

/**
 * Instrument one awaited boot stage. Every stage is timed and logged so a hang
 * is attributable to a single named step instead of the whole sequence.
 */
async function stage<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  const stageLog = createLogger("boot", undefined);
  const previous = bootTrace[bootTrace.length - 1];
  if (previous) previous.nextStage = name;

  const entry: BootStageTrace = { stage: name, startedAt: new Date().toISOString() };
  bootTrace.push(entry);
  const started = Date.now();
  stageLog.info(`boot stage started: ${name}`);

  try {
    const result = await run();
    entry.completedAt = new Date().toISOString();
    entry.durationMs = Date.now() - started;
    stageLog.info(`boot stage completed: ${name}`, { durationMs: entry.durationMs });
    return result;
  } catch (error) {
    entry.durationMs = Date.now() - started;
    entry.error = error instanceof Error ? error.message : String(error);
    stageLog.error(`boot stage failed: ${name}`, { durationMs: entry.durationMs, reason: entry.error });
    throw error;
  }
}

async function runBoot(): Promise<void> {
  const cid = correlationId("boot");
  bootStartedAt = new Date().toISOString();
  const env = loadEnv();
  configureLogging({ level: env.LOG_LEVEL });
  const fileSink = await installFileSink({
    dir: env.LOG_DIR,
    maxBytes: env.LOG_MAX_BYTES,
    maxFiles: env.LOG_MAX_FILES,
  });
  const log = createLogger("boot", cid);
  log.info("SPACE starting", { environment: env.SPACE_ENVIRONMENT, nodeEnv: env.NODE_ENV });

  // Prevent two SPACE processes from running against the same database. This
  // is a single-instance safety guard: double execution would double-trade.
  await stage("instance-lock", () => acquireInstanceLock());

  await stage("database-init", async () => {
    reportConnection("sqlite", { state: "CONNECTING", reason: "opening the SQLite database" });
    await initDatabase();
  });

  // Operational settings live in SQLite, never in .env. Restore the operator's
  // configuration document before anything reads it.
  await stage("operations-config", () => loadOperations());

  // Runtime state is authoritative in memory but persisted for graceful restart
  // continuity. Never restore into ARMED; a reboot always demands an explicit ARM.
  await stage("runtime-state", () => loadRuntimeState());

  // Clock is a first-class service: registered before anything schedules work.
  await stage("clock-service", () => registerClockService());

  await stage("health-registry", () => {

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

  registerHealthCheck("clock", clockServiceHealth);
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

  registerHealthCheck("telegram", telegramServiceHealth);
  registerHealthCheck("backup", backupServiceHealth);
  registerHealthCheck("settlement", settlementHealth);
  registerHealthCheck("environment_conformance", conformanceHealth);
  });

  // Run startup validation before any background work begins. This gate catches
  // missing secrets, an unhealthy database, or an invalid wallet. Boot always
  // completes so the operator can see the dashboard and the validation report;
  // only the ARM command is blocked when validation fails.
  // Boot-time evaluation of the composite environment gate; pre-ARM re-runs it.
  await stage("environment-conformance", () => evaluateEnvironmentConformance());

  const startupValidation = await stage("startup-validation", () => runStartupValidation());
  if (!startupValidation.valid) {
    log.warn("startup validation has blockers; engine limited to OBSERVE", {
      blockers: startupValidation.blockers,
    });
    eventBus.publish({
      type: "process.startup_validation_blockers",
      severity: "WARNING",
      correlationId: cid,
      source: "boot",
      payload: { blockers: startupValidation.blockers },
    });
  }

  // Timers exist only after the scheduler is up, and the engine loop registers
  // its tasks with that one scheduler rather than owning timers of its own.
  await stage("scheduler", async () => {
    reportConnection("scheduler", { state: "CONNECTING", reason: "starting the heartbeat" });
    await startScheduler();
  });

  // Chain identity is verified before anything talks to the venue, so a wrong
  // RPC can never masquerade as the selected environment.
  await stage("rpc-verify", async () => {
    reportConnection("polygon_rpc", { state: "CONNECTING", reason: "verifying chain identity" });
    await verifyChainId().catch(() => undefined);
  });

  await stage("auto-disarm", () => registerAutoDisarmTask());
  await stage("telegram-outbound", () => registerTelegramEventForwarding());
  await stage("telegram-inbound", () => startTelegramInbound());

  // Capture runtime metrics every 30 seconds for soak-test evidence.
  await stage("runtime-metrics", () =>
    registerTask({
      name: "runtime-metrics",
      intervalMs: 30_000,
      run: async () => {
        await sampleAndPersistMetrics();
      },
    }),
  );

  await stage("scheduled-backup", () =>
    registerTask({
      name: "scheduled-backup",
      intervalMs: 24 * 60 * 60 * 1000,
      run: async () => {
        await performBackup("SCHEDULED");
      },
    }),
  );
  await stage("engine-loop", () => startEngineLoop());

  // Discovery runs inside boot so the first dashboard snapshot already knows
  // whether a BTC market is open, instead of reporting "loading".
  await stage("market-discovery", () => refreshMarkets().catch(() => undefined));

  // The final stage builds the first runtime snapshot. The UI only ever reads
  // it; boot never waits on the UI.
  await stage("dashboard-snapshot", () => syncConnections());

  if (getRuntimeState().lifecycle === "STARTING") {
    // Boot completes in READY. Trading only begins after the operator arms.
    updateRuntimeState({ lifecycle: "READY" }, "boot complete", cid);
  }

  bootCompletedAt = new Date().toISOString();
  noteTimeline("scheduler", "SPACE READY (OBSERVE)");

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
    details: { window: label, enabled, lifecycle: state.lifecycle },
  };
}
