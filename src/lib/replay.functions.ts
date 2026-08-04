import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { listReplayMarkets, replayMarket } from "../core/replay/replay.server";

// Replay reads persisted evidence only. It never consults runtime memory, so a
// restarted process explains history identically.
export const getReplayMarkets = createServerFn({ method: "GET" }).handler(async () => {
  return listReplayMarkets(25);
});

export const getReplayMarket = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ conditionId: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    return replayMarket(data.conditionId);
  });
