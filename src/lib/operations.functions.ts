import { createServerFn } from "@tanstack/react-start";

import { boot } from "../core/boot.server";
import {
  activeOperations,
  operationsPending,
  stagedOperations,
  stageOperations,
} from "../core/config/operations.server";

// Operations Desk read + stage surface. Configuration never reaches a market
// already in flight; the strategy host promotes the staged document only when
// a new market is discovered.
export const getOperations = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return {
    staged: stagedOperations(),
    active: activeOperations(),
    pending: operationsPending(),
  };
});

export const updateOperations = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => data)
  .handler(async ({ data }) => {
    await boot();
    return stageOperations(data);
  });
