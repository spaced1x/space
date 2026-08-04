import { applyFailureScenario } from "../validation/failure-simulation.server";
import type { FaultTarget } from "../validation/failure-simulation.server";

// One HTTP boundary for every outbound dependency.
//
// Every external call goes through here so that fault injection, timeouts and
// latency measurement exist in exactly one place instead of being reimplemented
// (or forgotten) at each call site.

export interface SpaceFetchResult {
  response: Response;
  latencyMs: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function spaceFetch(
  target: FaultTarget,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<SpaceFetchResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...request } = init;
  const started = Date.now();

  const response = await applyFailureScenario(target, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...request, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  });

  return { response, latencyMs: Date.now() - started };
}
