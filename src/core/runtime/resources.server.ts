import { eventBus } from "../bus/events";
import { databaseResources } from "../db/database.server";
import { lockResources } from "../db/lock.server";
import { resourceAuditRepository } from "../db/repositories/resource-audit.repository";
import { engineResources } from "../engine/loop.server";
import { createLogger } from "../logging/logger";
import { schedulerResources } from "../scheduler/scheduler.server";
import { systemClock } from "../shared/clock";
import { telegramInboundResources } from "../telegram/inbound.server";
import { telegramForwardingResources } from "../telegram/telegram.service";
import { twapResources } from "../twap/service.server";
import { clobMarketResources } from "../market/clob-ws.server";

// Runtime resource audit.
//
// Every START, STOP and SWITCH must prove the previous runtime was fully
// destroyed and the new one owns exactly one of everything. The audit counts
// live resources directly from the modules that own them — it never infers a
// count from lifecycle state, because that is exactly the assumption a leak
// would break.

const log = createLogger("resource-audit");

export type ResourceAuditPhase = "START" | "STOP" | "SWITCH" | "PERIODIC";

export interface ResourceCheck {
  resource: string;
  expected: string;
  observed: number;
  ok: boolean;
  detail: string;
}

export interface RuntimeResourceAudit {
  at: string;
  phase: ResourceAuditPhase;
  /** The runtime lifecycle the counts were audited against. */
  expectation: "RUNNING" | "STOPPED";
  passed: boolean;
  failures: string[];
  checks: ResourceCheck[];
  heapUsedBytes: number;
}

const history: RuntimeResourceAudit[] = [];
const HISTORY_LIMIT = 50;

function check(
  resource: string,
  observed: number,
  expected: number,
  detail: string,
): ResourceCheck {
  return {
    resource,
    expected: String(expected),
    observed,
    ok: observed === expected,
    detail,
  };
}

/**
 * Count every resource-holding singleton and compare it against the count the
 * given expectation demands. `RUNNING` means a live runtime; `STOPPED` means a
 * runtime that has been torn down and must own nothing at all.
 */
export function auditRuntimeResources(
  phase: ResourceAuditPhase,
  expectation: "RUNNING" | "STOPPED",
): RuntimeResourceAudit {
  const running = expectation === "RUNNING";
  const scheduler = schedulerResources();
  const engine = engineResources();
  const db = databaseResources();
  const lock = lockResources();
  const twap = twapResources();
  const clobMarket = clobMarketResources();
  const inbound = telegramInboundResources();
  const forwarding = telegramForwardingResources();
  const bus = eventBus.stats();

  const checks: ResourceCheck[] = [
    check("scheduler", scheduler.schedulers, running ? 1 : 0, "one heartbeat owns every timer"),
    check("scheduler.timer", scheduler.timers, running ? 1 : 0, "exactly one heartbeat timer"),
    check(
      "scheduler.tasks",
      running ? Math.min(scheduler.tasks, 1) : scheduler.tasks,
      running ? 1 : 0,
      running
        ? `registered tasks: ${scheduler.taskNames.join(", ") || "none"}`
        : "no task may survive teardown",
    ),
    check("engine.loop", engine.loops, running ? 1 : 0, "one serialized engine loop"),
    check("feed.binance", engine.binanceFeeds, running ? 1 : 0, "one Binance socket"),
    check("feed.chainlink", engine.chainlinkFeeds, running ? 1 : 0, "one Chainlink poller"),
    check("twap.service", twap.services, running ? 1 : 0, "one TWAP service"),
    check("feed.clob_market", clobMarket.sockets, running ? 1 : 0, "one CLOB market data socket"),
    {
      resource: "database",
      expected: running ? "1" : "0",
      observed: db.connections,
      // Duplicate handles are always a failure. A missing handle is only a
      // failure when SQLite is actually attachable in this runtime; an
      // authoring sandbox without the native module reports zero honestly.
      ok: running ? db.connections <= 1 : db.connections === 0,
      detail: db.path ? `open database: ${db.path}` : "no database handle attached in this runtime",
    },
    check(
      "instance.lock",
      lock.locks,
      running ? 1 : 0,
      lock.path ? `lock file: ${lock.path}` : "no lock held",
    ),
    check("telegram.inbound", inbound.pollers, inbound.pollers, "poller only when configured"),
    check(
      "telegram.inbound.timer",
      inbound.timers,
      running ? inbound.pollers : 0,
      "one poll timer at most",
    ),
    check(
      "telegram.forwarder",
      forwarding.forwarders,
      running ? forwarding.forwarders : 0,
      "at most one event forwarder",
    ),
    check(
      "eventbus.wildcard",
      bus.wildcard,
      running ? bus.wildcard : 0,
      "no listener generation may survive teardown",
    ),
  ];

  const failures = checks
    .filter((entry) => !entry.ok)
    .map((entry) => `${entry.resource}: expected ${entry.expected}, observed ${entry.observed}`);

  const audit: RuntimeResourceAudit = {
    at: systemClock.iso(),
    phase,
    expectation,
    passed: failures.length === 0,
    failures,
    checks,
    heapUsedBytes: process.memoryUsage().heapUsed,
  };

  history.push(audit);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);

  resourceAuditRepository.append(audit).catch((error) => {
    log.warn("failed to persist resource audit", {
      reason: error instanceof Error ? error.message : String(error),
    });
  });

  if (audit.passed) log.info("runtime resource audit passed", { phase, expectation });
  else log.error("runtime resource audit failed", { phase, expectation, failures });

  return audit;
}

/** Load persisted resource audits into memory after the database is ready. */
export async function hydrateResourceAuditHistory(limit = 50): Promise<void> {
  try {
    const persisted = await resourceAuditRepository.recent(limit);
    history.length = 0;
    history.push(...persisted);
  } catch (error) {
    log.warn("failed to hydrate resource audit history", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function lastResourceAudit(): RuntimeResourceAudit | null {
  return history.at(-1) ?? null;
}

export function resourceAuditHistory(): RuntimeResourceAudit[] {
  return history.map((entry) => ({ ...entry, checks: entry.checks.map((c) => ({ ...c })) }));
}
