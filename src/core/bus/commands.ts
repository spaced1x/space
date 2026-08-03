import { z } from "zod";

import type { JsonObject } from "../shared/json";

// One entry point for every state-changing operator action, from the dashboard
// or Telegram. Validated at the edge, executed on the engine loop, answered
// with an explicit verdict, written to the audit log.
export const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("START_RUNTIME") }),
  z.object({ kind: z.literal("STOP_RUNTIME") }),
  z.object({ kind: z.literal("ARM") }),
  z.object({ kind: z.literal("DISARM") }),
  z.object({ kind: z.literal("PAUSE") }),
  z.object({ kind: z.literal("RESUME") }),
  z.object({ kind: z.literal("ENABLE_5M"), enabled: z.boolean() }),
  z.object({ kind: z.literal("ENABLE_15M"), enabled: z.boolean() }),
  // Manual Trading is an operating mode, not a second engine: switching to
  // MANUAL disables automatic strategy execution.
  z.object({ kind: z.literal("SET_MODE"), mode: z.enum(["STRATEGY", "MANUAL"]) }),
  // Latched kill switch. Stops new orders; existing orders remain in flight.
  z.object({ kind: z.literal("EMERGENCY_STOP"), reason: z.string().max(256).optional() }),
  // Reset the emergency stop latch after the operator has resolved the fault.
  z.object({ kind: z.literal("RESET_EMERGENCY_STOP") }),
  z.object({
    kind: z.literal("BACKUP"),
    label: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal("RESTORE"),
    backupId: z.string(),
  }),
  z.object({
    kind: z.literal("TELEGRAM_BROADCAST"),
    message: z.string().max(4000),
  }),
  // Operator configuration edits are state-changing actions and therefore
  // commands: they are validated, serialised and audited like every other one.
  z.object({
    kind: z.literal("STAGE_OPERATIONS"),
    document: z.unknown(),
  }),
  // Manual trading goes through the same audited path as automatic trading.
  z.object({
    kind: z.literal("MANUAL_ORDER"),
    horizon: z.enum(["FIVE_MINUTE", "FIFTEEN_MINUTE"]),
    direction: z.enum(["UP", "DOWN"]),
    orderKind: z.enum(["LIMIT", "MARKET"]),
    size: z.number().positive().max(100_000),
  }),
]);

export type Command = z.infer<typeof commandSchema>;
export type CommandKind = Command["kind"];

export const COMMAND_KINDS: CommandKind[] = [
  "START_RUNTIME",
  "STOP_RUNTIME",
  "ARM",
  "DISARM",
  "PAUSE",
  "RESUME",
  "ENABLE_5M",
  "ENABLE_15M",
  "SET_MODE",
  "EMERGENCY_STOP",
  "RESET_EMERGENCY_STOP",
  "BACKUP",
  "RESTORE",
  "TELEGRAM_BROADCAST",
  "STAGE_OPERATIONS",
  "MANUAL_ORDER",
];

export type CommandSource = "dashboard" | "telegram" | "system";

export interface CommandContext {
  actor: string;
  source: CommandSource;
  correlationId: string;
}

export type VerdictStatus = "ACCEPTED" | "REJECTED";

export interface Verdict {
  status: VerdictStatus;
  reason: string;
  correlationId: string;
  command: CommandKind;
  at: string;
  /** Command-specific result payload (order ids, staged document, ...). */
  details?: JsonObject;
}
