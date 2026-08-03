import { auditRepository } from "../db/repositories/audit.repository";
import { performBackup, restoreBackup } from "../backup/backup.service";
import { snapshotActiveConfig } from "../config/snapshots.server";
import { executionRecoveryStatus } from "../execution/execution.server";
import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";
import { correlationId as newCorrelationId } from "../shared/ids";
import { sendTelegramMessage } from "../telegram/telegram.service";
import {
  ARM_REASON,
  getRuntimeState,
  latchEmergencyStop,
  resetEmergencyStop,
  updateRuntimeState,
  type RuntimeState,
} from "../state/store";
import { runStartupValidation } from "../startup/validation.server";
import { eventBus } from "./events";
import { commandSchema, type Command, type CommandContext, type Verdict } from "./commands";

const log = createLogger("command-bus");

// Serialised queue. Commands never execute concurrently, so later trading
// handlers inherit the same single-writer guarantee the engine loop needs.
let tail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(task, task);
  tail = result.catch(() => undefined);
  return result;
}

export type CommandHandler = (
  command: Command,
  context: CommandContext,
) => Verdict | Promise<Verdict>;

const handlers = new Map<Command["kind"], CommandHandler>();

// Later milestones replace these infrastructure handlers with engine-owned ones.
export function registerCommandHandler(kind: Command["kind"], handler: CommandHandler): void {
  handlers.set(kind, handler);
}

function verdict(
  status: Verdict["status"],
  reason: string,
  command: Command["kind"],
  correlationId: string,
): Verdict {
  return { status, reason, command, correlationId, at: systemClock.iso() };
}

async function defaultHandler(command: Command, context: CommandContext): Promise<Verdict> {
  const state = getRuntimeState();
  const reject = (reason: string) =>
    verdict("REJECTED", reason, command.kind, context.correlationId);
  const accept = (reason: string, patch: Partial<RuntimeState>) => {
    updateRuntimeState(patch, reason, context.correlationId);
    return verdict("ACCEPTED", reason, command.kind, context.correlationId);
  };

  switch (command.kind) {
    case "ARM": {
      if (state.engineStatus === "ARMED") return reject("engine is already ARMED");
      if (state.engineStatus === "PAUSED") return reject("resume before arming");
      if (state.engineStatus !== "OBSERVE") return reject("engine must be in OBSERVE to arm");
      const recovery = executionRecoveryStatus();
      if (!recovery) return reject("execution recovery has not run yet");
      if (recovery.state === "FAILED") {
        return reject(`reconciliation failed: ${recovery.message}`);
      }
      if (state.emergencyStop) {
        return reject(`emergency stop is latched: ${state.emergencyStopReason}`);
      }
      const validation = await runStartupValidation();
      if (!validation.valid) {
        return reject(`pre-arm validation failed: ${validation.blockers.join("; ")}`);
      }
      // Snapshot the active configuration so every trade generated while ARMED
      // is explainable against the exact live configuration.
      await snapshotActiveConfig("ARM command", context.correlationId);
      return accept(ARM_REASON, { engineStatus: "ARMED" });
    }
    case "DISARM":
      if (state.engineStatus === "OBSERVE") return reject("engine is already in OBSERVE");
      return accept("engine disarmed to OBSERVE", { engineStatus: "OBSERVE" });
    case "PAUSE":
      if (state.engineStatus === "PAUSED") return reject("engine is already paused");
      return accept("engine paused", { engineStatus: "PAUSED" });
    case "RESUME":
      if (state.engineStatus !== "PAUSED") return reject("engine is not paused");
      return accept("engine resumed in OBSERVE", { engineStatus: "OBSERVE" });
    case "ENABLE_5M":
      return accept(`5m window ${command.enabled ? "enabled" : "disabled"}`, {
        windows: { ...state.windows, fiveMinute: command.enabled },
      });
    case "ENABLE_15M":
      return accept(`15m window ${command.enabled ? "enabled" : "disabled"}`, {
        windows: { ...state.windows, fifteenMinute: command.enabled },
      });
    case "SET_MODE": {
      if (state.mode === command.mode) return reject(`engine is already in ${command.mode} mode`);
      if (state.engineStatus === "ARMED") {
        return reject("disarm before switching operating mode");
      }
      const result = accept(`operating mode set to ${command.mode}`, { mode: command.mode });
      await snapshotActiveConfig(`mode switch to ${command.mode}`, context.correlationId);
      return result;
    }
    case "EMERGENCY_STOP": {
      if (state.emergencyStop) return reject("emergency stop is already latched");
      const reason = command.reason ?? "operator emergency stop";
      latchEmergencyStop(reason, context.correlationId);
      return verdict("ACCEPTED", `emergency stop latched: ${reason}`, command.kind, context.correlationId);
    }
    case "RESET_EMERGENCY_STOP": {
      if (!state.emergencyStop) return reject("emergency stop is not latched");
      resetEmergencyStop(context.correlationId);
      return verdict(
        "ACCEPTED",
        "emergency stop latch reset; re-run pre-arm validation before ARM",
        command.kind,
        context.correlationId,
      );
    }
    case "BACKUP": {
      const result = await performBackup("MANUAL", command.label);
      return result.success
        ? verdict("ACCEPTED", result.message, command.kind, context.correlationId)
        : verdict("REJECTED", result.message, command.kind, context.correlationId);
    }
    case "RESTORE": {
      const id = Number(command.backupId);
      if (!Number.isFinite(id) || id <= 0) {
        return reject("backupId must be a positive integer");
      }
      const result = await restoreBackup(id);
      return result.success
        ? verdict("ACCEPTED", result.message, command.kind, context.correlationId)
        : verdict("REJECTED", result.message, command.kind, context.correlationId);
    }
    case "TELEGRAM_BROADCAST": {
      await sendTelegramMessage(command.message, "operator");
      return verdict("ACCEPTED", "message queued for Telegram", command.kind, context.correlationId);
    }
    case "STAGE_OPERATIONS": {
      // Imported lazily so the command bus stays free of configuration and
      // execution module cycles.
      const { stageOperations } = await import("../config/operations.server");
      const result = await stageOperations(command.document);
      if (result.status === "REJECTED") return reject(result.reason);
      return {
        ...verdict("ACCEPTED", result.reason, command.kind, context.correlationId),
        details: { version: result.staged.version, pending: result.pending },
      };
    }
    case "MANUAL_ORDER": {
      if (state.mode !== "MANUAL") return reject("switch to MANUAL mode before placing an order");
      const { placeManualOrder } = await import("../execution/manual.server");
      const result = await placeManualOrder({
        horizon: command.horizon,
        direction: command.direction,
        kind: command.orderKind,
        size: command.size,
      });
      return {
        ...verdict(
          result.status,
          result.reason,
          command.kind,
          context.correlationId,
        ),
        details: {
          orderId: result.order?.id ?? null,
          intentId: result.order?.intentId ?? null,
          risk: result.risk
            ? {
                status: result.risk.status,
                reason: result.risk.reason,
                code: result.risk.code,
                at: result.risk.at,
              }
            : null,
        },
      };
    }
    default:
      return reject("command not implemented");
  }
}

export async function dispatchCommand(
  input: unknown,
  context: Omit<CommandContext, "correlationId"> & { correlationId?: string },
): Promise<Verdict> {
  const cid = context.correlationId ?? newCorrelationId("cmd");
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) {
    return verdict("REJECTED", `invalid command: ${parsed.error.issues[0]?.message}`, "ARM", cid);
  }
  const command = parsed.data;
  const fullContext: CommandContext = { ...context, correlationId: cid };

  return enqueue(async () => {
    const handler = handlers.get(command.kind) ?? defaultHandler;
    const result = await handler(command, fullContext);

    eventBus.publish({
      type: `command.${result.status.toLowerCase()}`,
      severity: result.status === "ACCEPTED" ? "SUCCESS" : "WARNING",
      correlationId: cid,
      source: fullContext.source,
      payload: { command: command.kind, reason: result.reason, actor: fullContext.actor },
    });

    log.info("command handled", {
      command: command.kind,
      verdict: result.status,
      reason: result.reason,
      correlationId: cid,
    });

    try {
      await auditRepository.append({
        correlationId: cid,
        actor: fullContext.actor,
        source: fullContext.source,
        command: command.kind,
        payload: command as unknown as Record<string, unknown>,
        verdict: result.status,
        reason: result.reason,
      });
    } catch (error) {
      // Audit persistence is best-effort while SQLite is unattached; the log
      // line above still carries actor, verdict and correlation id.
      log.warn("audit append skipped", {
        correlationId: cid,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    return result;
  });
}
