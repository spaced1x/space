import { auditRepository } from "../db/repositories/audit.repository";
import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";
import { correlationId as newCorrelationId } from "../shared/ids";
import { ARM_REASON, getRuntimeState, updateRuntimeState, type RuntimeState } from "../state/store";
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

function defaultHandler(command: Command, context: CommandContext): Verdict {
  const state = getRuntimeState();
  const reject = (reason: string) =>
    verdict("REJECTED", reason, command.kind, context.correlationId);
  const accept = (reason: string, patch: Partial<RuntimeState>) => {
    updateRuntimeState(patch, reason, context.correlationId);
    return verdict("ACCEPTED", reason, command.kind, context.correlationId);
  };

  switch (command.kind) {
    case "ARM":
      if (state.engineStatus === "ARMED") return reject("engine is already ARMED");
      if (state.engineStatus === "PAUSED") return reject("resume before arming");
      if (state.engineStatus !== "OBSERVE") return reject("engine must be in OBSERVE to arm");
      return accept(ARM_REASON, { engineStatus: "ARMED" });
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
