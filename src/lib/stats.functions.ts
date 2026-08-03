import { createServerFn } from "@tanstack/react-start";

import { boot } from "../core/boot.server";
import { executionSnapshot } from "../core/execution/execution.server";
import { statistics } from "../core/stats/statistics.server";

export const getStatistics = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return { stats: await statistics(), execution: executionSnapshot() };
});
