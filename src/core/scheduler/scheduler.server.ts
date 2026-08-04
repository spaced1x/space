import { clock } from "../clock/clock.service";
import { kvRepository } from "../db/repositories/kv.repository";
import { createLogger } from "../logging/logger";
import { correlationId } from "../shared/ids";
import type { HealthResult } from "../health/types";
import type { JsonObject } from "../shared/json";

// The single authoritative scheduler. Every module that needs recurring work
// registers a task here; no module is allowed to own a timer of its own.
// Tasks run sequentially on one heartbeat, so registrations inherit the
// single-writer guarantee the engine loop depends on.

const TICK_MS = 100;
const KV_KEY = "scheduler.checkpoint";
const log = createLogger("scheduler");

export interface TaskContext {
  name: string;
  scheduledAt: number;
  correlationId: string;
}

export interface TaskDefinition {
  name: string;
  intervalMs: number;
  /** Run immediately on start instead of waiting a full interval. */
  runOnStart?: boolean;
  run(context: TaskContext): void | Promise<void>;
}

interface TaskRuntime {
  definition: TaskDefinition;
  nextDueAt: number;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runs: number;
  failures: number;
  maxLagMs: number;
  /** Difference between the intended slot and the actual start, per run. */
  lastJitterMs: number | null;
  maxJitterMs: number;
  jitterSumMs: number;
  jitterSamples: number;
  /** Slots that elapsed without a run because a previous run overran. */
  missedRuns: number;
  /** A due slot that arrived while the previous run was still in flight. */
  overlaps: number;
  inFlight: boolean;
  registeredAt: number;
  duplicateRegistrations: number;
}

export interface TaskStatus extends JsonObject {
  name: string;
  intervalMs: number;
  runs: number;
  failures: number;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  overdueMs: number;
  maxLagMs: number;
  lastJitterMs: number | null;
  avgJitterMs: number | null;
  maxJitterMs: number;
  missedRuns: number;
  overlaps: number;
  duplicateRegistrations: number;
  expectedRuns: number;
  inFlight: boolean;
}

const tasks = new Map<string, TaskRuntime>();
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let ticking = false;
let startedAt: number | null = null;
let ticks = 0;
let maxTickDriftMs = 0;
let checkpointRestored = false;
let duplicateRegistrations = 0;

export function registerTask(definition: TaskDefinition): void {
  if (definition.intervalMs < TICK_MS) {
    throw new Error(`task ${definition.name}: intervalMs must be >= ${TICK_MS}`);
  }
  const now = clock().now();
  const existing = tasks.get(definition.name);
  // A second registration under the same name is a runtime defect: it would
  // silently replace a live task. It is counted and surfaced, never hidden.
  if (existing) duplicateRegistrations += 1;
  tasks.set(definition.name, {
    definition,
    nextDueAt: existing?.nextDueAt ?? (definition.runOnStart ? now : now + definition.intervalMs),
    lastRunAt: existing?.lastRunAt ?? null,
    lastDurationMs: null,
    lastError: null,
    runs: existing?.runs ?? 0,
    failures: existing?.failures ?? 0,
    maxLagMs: 0,
    lastJitterMs: null,
    maxJitterMs: existing?.maxJitterMs ?? 0,
    jitterSumMs: existing?.jitterSumMs ?? 0,
    jitterSamples: existing?.jitterSamples ?? 0,
    missedRuns: existing?.missedRuns ?? 0,
    overlaps: existing?.overlaps ?? 0,
    inFlight: false,
    registeredAt: existing?.registeredAt ?? now,
    duplicateRegistrations: existing ? existing.duplicateRegistrations + 1 : 0,
  });
  if (existing) {
    log.warn("task registered twice", { task: definition.name });
  }
}

export function unregisterTask(name: string): void {
  tasks.delete(name);
}

/**
 * Soak-only cadence compression. Divides every registered task interval so an
 * accelerated harness observes hours of scheduling behaviour in minutes. It
 * mutates the live definitions in place — it never re-registers a task — so
 * duplicate-registration accounting stays truthful. `restoreTaskIntervals()`
 * puts the original cadence back. Nothing in the runtime calls either.
 */
const originalIntervals = new Map<string, number>();

export function compressTaskIntervals(divisor: number): { task: string; intervalMs: number }[] {
  if (!Number.isFinite(divisor) || divisor < 1) throw new Error("divisor must be >= 1");
  const applied: { task: string; intervalMs: number }[] = [];
  const now = clock().now();
  for (const [name, task] of tasks) {
    if (!originalIntervals.has(name)) originalIntervals.set(name, task.definition.intervalMs);
    const source = originalIntervals.get(name)!;
    const next = Math.max(TICK_MS, Math.round(source / divisor));
    task.definition.intervalMs = next;
    task.nextDueAt = Math.min(task.nextDueAt, now + next);
    applied.push({ task: name, intervalMs: next });
  }
  log.warn("task intervals compressed", { divisor, tasks: applied.length });
  return applied;
}

export function restoreTaskIntervals(): void {
  for (const [name, intervalMs] of originalIntervals) {
    const task = tasks.get(name);
    if (task) task.definition.intervalMs = intervalMs;
  }
  originalIntervals.clear();
}

/**
 * Remove every registration. Teardown only: a restarted runtime re-registers
 * its tasks from scratch, so a stale definition can never survive a switch.
 */
export function clearTasks(): void {
  tasks.clear();
  checkpointRestored = false;
  duplicateRegistrations = 0;
}

/** Live resource counts for the runtime resource audit. */
export function schedulerResources(): {
  schedulers: number;
  timers: number;
  tasks: number;
  taskNames: string[];
} {
  return {
    schedulers: running ? 1 : 0,
    timers: timer ? 1 : 0,
    tasks: tasks.size,
    taskNames: [...tasks.keys()],
  };
}

// Restart recovery: a task that was due while the process was down becomes due
// immediately, and a task that ran recently keeps its original cadence.
async function restoreCheckpoint(): Promise<void> {
  if (checkpointRestored) return;
  checkpointRestored = true;
  try {
    const raw = await kvRepository.get(KV_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, number>;
    for (const [name, lastRunAt] of Object.entries(saved)) {
      const task = tasks.get(name);
      if (!task || typeof lastRunAt !== "number") continue;
      task.lastRunAt = lastRunAt;
      task.nextDueAt = Math.max(clock().now(), lastRunAt + task.definition.intervalMs);
    }
    log.info("scheduler checkpoint restored", { tasks: Object.keys(saved).length });
  } catch (error) {
    log.warn("scheduler checkpoint unavailable", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function persistCheckpoint(): Promise<void> {
  const payload: Record<string, number> = {};
  for (const [name, task] of tasks) if (task.lastRunAt) payload[name] = task.lastRunAt;
  try {
    await kvRepository.set(KV_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort: SQLite may be unattached in an authoring runtime.
  }
}

export async function startScheduler(): Promise<void> {
  if (running) return;
  await restoreCheckpoint();
  running = true;
  startedAt = clock().now();
  ticks = 0;
  maxTickDriftMs = 0;
  schedule(clock().now() + TICK_MS);
  log.info("scheduler started", { tickMs: TICK_MS, tasks: [...tasks.keys()] });
}

export async function stopScheduler(): Promise<void> {
  if (!running) return;
  running = false;
  if (timer) clearTimeout(timer);
  timer = undefined;
  // Let an in-flight tick finish so no task is interrupted mid-run.
  while (ticking) await new Promise((resolve) => setTimeout(resolve, 10));
  await persistCheckpoint();
  log.info("scheduler stopped", { ticks });
}

function schedule(targetAt: number): void {
  if (!running) return;
  const delay = Math.max(0, targetAt - clock().now());
  timer = setTimeout(() => {
    void tick(targetAt);
  }, delay);
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

// Self-correcting heartbeat: the next tick is scheduled from the intended
// target time, not from "now", so slow tasks cannot accumulate drift.
async function tick(targetAt: number): Promise<void> {
  if (!running) return;
  ticking = true;
  const now = clock().now();
  const drift = now - targetAt;
  if (drift > maxTickDriftMs) maxTickDriftMs = drift;
  ticks += 1;

  try {
    for (const task of tasks.values()) {
      if (task.nextDueAt > now) continue;
      if (task.inFlight) {
        task.overlaps += 1;
        log.warn("task slot overlapped a running execution", { task: task.definition.name });
        continue;
      }
      const lag = now - task.nextDueAt;
      if (lag > task.maxLagMs) task.maxLagMs = lag;
      const context: TaskContext = {
        name: task.definition.name,
        scheduledAt: task.nextDueAt,
        correlationId: correlationId("task"),
      };
      const startedTaskAt = clock().now();
      task.inFlight = true;
      const jitter = startedTaskAt - task.nextDueAt;
      task.lastJitterMs = jitter;
      if (jitter > task.maxJitterMs) task.maxJitterMs = jitter;
      task.jitterSumMs += Math.abs(jitter);
      task.jitterSamples += 1;
      try {
        await task.definition.run(context);
        task.lastError = null;
      } catch (error) {
        task.failures += 1;
        task.lastError = error instanceof Error ? error.message : String(error);
        log.error("task failed", { task: task.definition.name, reason: task.lastError });
      } finally {
        task.inFlight = false;
      }
      task.runs += 1;
      task.lastRunAt = startedTaskAt;
      task.lastDurationMs = clock().now() - startedTaskAt;
      // Skip missed slots instead of bursting after a stall.
      const interval = task.definition.intervalMs;
      const elapsed = clock().now();
      const slots = Math.ceil((elapsed - task.nextDueAt) / interval);
      if (slots > 1) task.missedRuns += slots - 1;
      task.nextDueAt = task.nextDueAt + slots * interval;
    }
  } finally {
    ticking = false;
  }

  if (ticks % 50 === 0) void persistCheckpoint();
  schedule(targetAt + TICK_MS);
}

export function schedulerStatus(): {
  running: boolean;
  tickMs: number;
  ticks: number;
  startedAt: string | null;
  maxTickDriftMs: number;
  duplicateRegistrations: number;
  overlaps: number;
  tasks: TaskStatus[];
} {
  const now = clock().now();
  return {
    running,
    tickMs: TICK_MS,
    ticks,
    startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
    maxTickDriftMs,
    duplicateRegistrations,
    overlaps: [...tasks.values()].reduce((sum, task) => sum + task.overlaps, 0),
    tasks: [...tasks.values()].map((task) => ({
      name: task.definition.name,
      intervalMs: task.definition.intervalMs,
      runs: task.runs,
      failures: task.failures,
      lastRunAt: task.lastRunAt === null ? null : new Date(task.lastRunAt).toISOString(),
      lastDurationMs: task.lastDurationMs,
      lastError: task.lastError,
      overdueMs: Math.max(0, now - task.nextDueAt),
      maxLagMs: task.maxLagMs,
      lastJitterMs: task.lastJitterMs,
      avgJitterMs: task.jitterSamples ? task.jitterSumMs / task.jitterSamples : null,
      maxJitterMs: task.maxJitterMs,
      missedRuns: task.missedRuns,
      overlaps: task.overlaps,
      duplicateRegistrations: task.duplicateRegistrations,
      // Expected runs since registration, so operators can see silent stalls.
      expectedRuns: Math.max(0, Math.floor((now - task.registeredAt) / task.definition.intervalMs)),
      inFlight: task.inFlight,
    })),
  };
}

const DRIFT_DEGRADED_MS = 250;
const DRIFT_FAILED_MS = 1000;

export function schedulerHealth(): HealthResult {
  const status = schedulerStatus();
  if (!status.running) {
    return {
      state: "DISABLED",
      message: "scheduler stopped by operator or shutdown",
      details: { ...status },
    };
  }
  const failing = status.tasks.filter((task) => task.lastError !== null);
  const overdue = status.tasks.filter((task) => task.overdueMs > task.intervalMs * 3);
  if (
    failing.length ||
    overdue.length ||
    status.overlaps > 0 ||
    status.duplicateRegistrations > 0
  ) {
    return {
      state: "DEGRADED",
      message:
        `${failing.length} failing, ${overdue.length} overdue task(s), ` +
        `${status.overlaps} overlap(s), ${status.duplicateRegistrations} duplicate registration(s)`,
      details: { ...status },
    };
  }
  if (status.maxTickDriftMs > DRIFT_FAILED_MS) {
    return {
      state: "FAILED",
      message: `scheduler drift ${status.maxTickDriftMs.toFixed(1)}ms exceeds safe limit`,
      details: { ...status },
    };
  }
  if (status.maxTickDriftMs > DRIFT_DEGRADED_MS) {
    return {
      state: "DEGRADED",
      message: `scheduler drift ${status.maxTickDriftMs.toFixed(1)}ms elevated`,
      details: { ...status },
    };
  }
  return {
    state: "OK",
    message: `${status.tasks.length} task(s) on one ${status.tickMs}ms heartbeat`,
    details: { ...status },
  };
}

// Test seam only: never called by the running process.
export function resetSchedulerForTests(): void {
  tasks.clear();
  running = false;
  ticking = false;
  ticks = 0;
  startedAt = null;
  maxTickDriftMs = 0;
  duplicateRegistrations = 0;
  checkpointRestored = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}

// Test seam: drive one tick deterministically without the heartbeat.
export async function runDueTasksForTests(): Promise<void> {
  running = true;
  await tick(clock().now());
  running = false;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
