import { createServerFn } from "@tanstack/react-start";

import { boot } from "../core/boot.server";
import { dispatchCommand } from "../core/bus/command-bus.server";
import { commandSchema } from "../core/bus/commands";
import { eventBus } from "../core/bus/events";
import { collectHealth } from "../core/health/registry";
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
