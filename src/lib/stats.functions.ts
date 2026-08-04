import { createServerFn } from "@tanstack/react-start";

import { executionSnapshot } from "../core/execution/execution.server";
import { statistics } from "../core/stats/statistics.server";

export const getStatistics = createServerFn({ method: "GET" }).handler(async () => {
  return { stats: await statistics(), execution: executionSnapshot() };
});
