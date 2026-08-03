import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { boot } from "../core/boot.server";
import { manualDesk, placeManualOrder } from "../core/execution/manual.server";

const requestSchema = z.object({
  horizon: z.enum(["FIVE_MINUTE", "FIFTEEN_MINUTE"]),
  direction: z.enum(["UP", "DOWN"]),
  kind: z.enum(["LIMIT", "MARKET"]),
  size: z.number().positive().max(100_000),
});

export const getManualDesk = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    z
      .object({ horizon: z.enum(["FIVE_MINUTE", "FIFTEEN_MINUTE"]).default("FIVE_MINUTE") })
      .parse(data ?? {}),
  )
  .handler(async ({ data }) => {
    await boot();
    return manualDesk(data.horizon);
  });

// Manual orders reuse the Risk Engine and the Execution Engine; this function
// only builds the request.
export const submitManualOrder = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => requestSchema.parse(data))
  .handler(async ({ data }) => {
    await boot();
    return placeManualOrder(data);
  });
