import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { manualDesk } from "../core/execution/manual.server";
import { dispatchCommand } from "../core/bus/command-bus.server";

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
    return manualDesk(data.horizon);
  });

// Manual orders reuse the Risk Engine and the Execution Engine, and travel the
// same audited, serialised Command Bus path as every other operator action.
export const submitManualOrder = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => requestSchema.parse(data))
  .handler(async ({ data }) => {
    return dispatchCommand(
      {
        kind: "MANUAL_ORDER",
        horizon: data.horizon,
        direction: data.direction,
        orderKind: data.kind,
        size: data.size,
      },
      { actor: "operator", source: "dashboard" },
    );
  });
