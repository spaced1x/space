import { createServerFn } from "@tanstack/react-start";

import { dispatchCommand } from "../core/bus/command-bus.server";
import {
  activeOperations,
  operationsPending,
  stagedOperations,
} from "../core/config/operations.server";

// Operations Desk read + stage surface. Configuration never reaches a market
// already in flight; the strategy host promotes the staged document only when
// a new market is discovered.
export const getOperations = createServerFn({ method: "GET" }).handler(async () => {
  return {
    staged: stagedOperations(),
    active: activeOperations(),
    pending: operationsPending(),
  };
});

export const updateOperations = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => data)
  .handler(async ({ data }) => {
    // Configuration edits are audited commands, not direct writes.
    const verdict = await dispatchCommand(
      { kind: "STAGE_OPERATIONS", document: data },
      { actor: "operator", source: "dashboard" },
    );
    return {
      status: verdict.status,
      reason: verdict.reason,
      staged: stagedOperations(),
      active: activeOperations(),
      pending: operationsPending(),
    };
  });
