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
import { readRuntimeTarget, requestEnvironmentSwitch, targetMatchesEnvironment } from "./runtime/target.server";
import { resetEnvCache } from "./config/env.server";
import { invalidatePeek, type EnvironmentCode } from "./runtime/peek.server";
import { auditRuntimeResources, type RuntimeResourceAudit } from "./runtime/resources.server";
import { teardownRuntime } from "./shutdown.server";
import { verifyChainId } from "./execution/wallet.server";
import { refreshMarkets } from "./market/discovery.server";

// Startup sequence (specification §13), milestone 2 slice:
// Boot -> Env -> Logging -> DB -> Clock -> Health -> Scheduler -> Engine loop
// (feeds + discovery) -> OBSERVE.
// Wallet, Telegram and recovery attach in later milestones.
let bootPromise: Promise<void> | undefined;

export async function boot(): Promise<void> {
  // An operator STOP is a decision, not a fault: a page load must never
  // resurrect a runtime the operator deliberately shut down.
  if (stoppedByOperator) return;
  if (!bootPromise) bootPromise = runBoot();
  return bootPromise;
}

let stoppedByOperator = false;

export function runtimeStoppedByOperator(): boolean {
  return stoppedByOperator;
}

/**
 * Forget the previous boot so the next boot() runs the full sequence again.
 * Only the lifecycle transitions below call this — never a request handler.
 */
function resetBootState(): void {
  bootPromise = undefined;
  bootTrace.length = 0;
  bootStartedAt = null;
  bootCompletedAt = null;
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

  // Lifecycle begins in STARTING the moment the boot sequence runs.
  updateRuntimeState({ lifecycle: "STARTING" }, "boot sequence started", cid);

  // Verify the persisted runtime target agrees with the active environment. A
  // mismatch means an operator requested a switch that has not been restarted.
  const target = readRuntimeTarget();
  if (!targetMatchesEnvironment()) {
    log.warn("runtime target mismatch", {
      targetEnvironment: target.environment,
      activeEnvironment: env.SPACE_ENVIRONMENT,
    });
  }

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
  // continuity. Never restore into RUNNING; a reboot always demands an explicit ARM.
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

  // Boot-time evaluation of the composite environment gate.
  await stage("environment-conformance", () => evaluateEnvironmentConformance());

  // Move into the explicit validation stage so the dashboard shows why boot
  // may be blocked before any background work begins.
  updateRuntimeState({ lifecycle: "VALIDATING" }, "running startup validation gate", cid);
  const startupValidation = await stage("startup-validation", () => runStartupValidation());
  if (!startupValidation.valid) {
    log.warn("startup validation has blockers; engine limited to READY", {
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

  if (getRuntimeState().lifecycle === "VALIDATING") {
    // Boot completes in READY. Trading only begins after the operator arms.
    updateRuntimeState({ lifecycle: "READY" }, "boot complete", cid);
  }

  bootCompletedAt = new Date().toISOString();
  noteTimeline("scheduler", "SPACE READY");

  eventBus.publish({
    type: "process.booted",
    severity: "SUCCESS",
    correlationId: cid,
    source: "boot",
    payload: { environment: env.SPACE_ENVIRONMENT, targetVersion: target.version },
  });
  log.info("SPACE ready in READY");
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

// ---------------------------------------------------------------------------
// Runtime lifecycle transitions.
//
// boot.server.ts is the one lifecycle owner: START, STOP and SWITCH all run
// through this module so there can never be two runtimes, two boots or two
// teardowns racing each other. Every transition ends in a resource audit; a
// failed audit is a FAILED runtime, never a warning.
// ---------------------------------------------------------------------------

export interface RuntimeTransition {
  ok: boolean;
  reason: string;
  environment: EnvironmentCode;
  audit: RuntimeResourceAudit;
}

let transitionLock: Promise<unknown> = Promise.resolve();

function serialise<T>(task: () => Promise<T>): Promise<T> {
  const result = transitionLock.then(task, task);
  transitionLock = result.catch(() => undefined);
  return result;
}

function currentEnvironment(): EnvironmentCode {
  try {
    return loadEnv().SPACE_ENVIRONMENT;
  } catch {
    return "V1_TESTNET";
  }
}

async function bootAndAudit(
  phase: "START" | "SWITCH",
  cid: string,
): Promise<RuntimeTransition> {
  const environment = currentEnvironment();
  stoppedByOperator = false;
  try {
    resetBootState();
    await boot();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateRuntimeState({ lifecycle: "FAILED", shutdownReason: reason }, `boot failed: ${reason}`, cid);
    return { ok: false, reason, environment, audit: auditRuntimeResources(phase, "RUNNING") };
  }

  const audit = auditRuntimeResources(phase, "RUNNING");
  if (!audit.passed) {
    const reason = `runtime resource audit failed: ${audit.failures.join("; ")}`;
    updateRuntimeState({ lifecycle: "FAILED", shutdownReason: reason }, reason, cid);
    return { ok: false, reason, environment, audit };
  }
  return { ok: true, reason: `runtime started in ${environment}`, environment, audit };
}

/** Start (or restart) the runtime in the currently active environment. */
export function startRuntime(reason: string): Promise<RuntimeTransition> {
  return serialise(async () => {
    const cid = correlationId("start");
    const state = getRuntimeState();
    const live = state.lifecycle !== "STOPPED" && state.lifecycle !== "FAILED";
    if (bootCompletedAt && live) {
      return {
        ok: false,
        reason: `runtime is already ${state.lifecycle}`,
        environment: currentEnvironment(),
        audit: auditRuntimeResources("START", "RUNNING"),
      };
    }
    // A FAILED or partially started runtime is destroyed before restarting, so
    // START can never stack a second generation of timers or sockets.
    await teardownRuntime(`restart: ${reason}`);
    return bootAndAudit("START", cid);
  });
}

/** Stop the runtime completely, leaving the process alive and observable. */
export function stopRuntime(reason: string): Promise<RuntimeTransition> {
  return serialise(async () => {
    const environment = currentEnvironment();
    const audit = await teardownRuntime(reason);
    resetBootState();
    stoppedByOperator = true;
    if (!audit.passed) {
      const failure = `runtime resource audit failed: ${audit.failures.join("; ")}`;
      updateRuntimeState(
        { lifecycle: "FAILED", shutdownReason: failure },
        failure,
        correlationId("stop"),
      );
      return { ok: false, reason: failure, environment, audit };
    }
    return { ok: true, reason: `runtime stopped: ${reason}`, environment, audit };
  });
}

/**
 * Switch the active environment. The persisted target is written first so a
 * process restart lands in the same place an in-process switch does.
 */
export function switchRuntimeEnvironment(
  target: EnvironmentCode,
  actor: string,
): Promise<RuntimeTransition> {
  return serialise(async () => {
    const cid = correlationId("switch");
    const active = currentEnvironment();
    const log = createLogger("boot", cid);

    if (target === active) {
      return {
        ok: false,
        reason: `${target} is already the active runtime`,
        environment: active,
        audit: auditRuntimeResources("SWITCH", "RUNNING"),
      };
    }

    let pinnedDbPath: string | undefined;
    try {
      pinnedDbPath = loadEnv().DB_PATH;
    } catch {
      pinnedDbPath = undefined;
    }
    if (pinnedDbPath) {
      return {
        ok: false,
        reason:
          "DB_PATH pins this process to one database; unset it so each environment uses its own file",
        environment: active,
        audit: auditRuntimeResources("SWITCH", "RUNNING"),
      };
    }

    const stopAudit = await teardownRuntime(`switching to ${target}`);
    stoppedByOperator = true;
    if (!stopAudit.passed) {
      const failure = `switch aborted, previous runtime not fully destroyed: ${stopAudit.failures.join("; ")}`;
      updateRuntimeState({ lifecycle: "FAILED", shutdownReason: failure }, failure, cid);
      return { ok: false, reason: failure, environment: active, audit: stopAudit };
    }

    requestEnvironmentSwitch(target, actor);
    process.env["SPACE_ENVIRONMENT"] = target;
    resetEnvCache();
    invalidatePeek();
    resetBootState();

    // PM2 deployments may prefer a clean process per environment. The target
    // file is already written, so the respawned process boots into it.
    if (process.env["SPACE_RESTART_ON_SWITCH"] === "true") {
      log.warn("exiting for supervisor restart after environment switch", { target });
      setTimeout(() => process.exit(1), 250);
      return {
        ok: true,
        reason: `target set to ${target}; process is restarting under the supervisor`,
        environment: target,
        audit: stopAudit,
      };
    }

    const result = await bootAndAudit("SWITCH", cid);
    return {
      ...result,
      reason: result.ok ? `runtime switched to ${target}` : result.reason,
    };
  });
}
