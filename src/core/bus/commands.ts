import { z } from "zod";

// One entry point for every state-changing operator action, from the dashboard
// or Telegram. Validated at the edge, executed on the engine loop, answered
// with an explicit verdict, written to the audit log.
export const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ARM") }),
  z.object({ kind: z.literal("DISARM") }),
  z.object({ kind: z.literal("PAUSE") }),
  z.object({ kind: z.literal("RESUME") }),
  z.object({ kind: z.literal("ENABLE_5M"), enabled: z.boolean() }),
  z.object({ kind: z.literal("ENABLE_15M"), enabled: z.boolean() }),
]);

export type Command = z.infer<typeof commandSchema>;
export type CommandKind = Command["kind"];

export const COMMAND_KINDS: CommandKind[] = [
  "ARM",
  "DISARM",
  "PAUSE",
  "RESUME",
  "ENABLE_5M",
  "ENABLE_15M",
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
}