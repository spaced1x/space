import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { boot } from "../core/boot.server";
import { dispatchCommand } from "../core/bus/command-bus.server";
import { commandSchema } from "../core/bus/commands";
import { eventBus } from "../core/bus/events";
import { collectHealth } from "../core/health/registry";
import { backupRepository } from "../core/db/repositories/backup.repository";
import { telegramRepository } from "../core/db/repositories/telegram.repository";
import { engineRuntimeSnapshot } from "../core/engine/loop.server";
import { getRuntimeState } from "../core/state/store";

// Single read surface: Mission Control, Overview and Statistics all subscribe
// to this one snapshot so no two panels can disagree.
export const getSystemSnapshot = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return {
    runtime: getRuntimeState(),
    health: await collectHealth(),
    events: eventBus.recent(12),
    engine: engineRuntimeSnapshot(),
  };
});

export const sendCommand = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => commandSchema.parse(data))
  .handler(async ({ data }) => {
    await boot();
    return dispatchCommand(data, { actor: "operator", source: "dashboard" });
  });

export const getBackups = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return backupRepository.recent(20);
});

export const getTelegramOutbox = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return telegramRepository.recent(20);
});

const telegramBroadcastSchema = z.object({ message: z.string().min(1).max(4000) });

export const sendTelegramBroadcast = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => telegramBroadcastSchema.parse(data))
  .handler(async ({ data }) => {
    await boot();
    return dispatchCommand(
      { kind: "TELEGRAM_BROADCAST", message: data.message },
      { actor: "operator", source: "dashboard" },
    );
  });
