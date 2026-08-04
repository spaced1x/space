import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getSnapshotTransport } from "./runtime-snapshot.transport";
import type { getSystemSnapshot } from "./system.functions";

export const SNAPSHOT_QUERY_KEY = ["system-snapshot"] as const;
const POLL_MS = 5_000;
/** A snapshot older than this is shown as STALE, but the last values stay on screen. */
const STALE_AFTER_MS = 15_000;
/** Reject snapshots whose schema version does not match what this dashboard expects. */
export const EXPECTED_SNAPSHOT_VERSION = 1;

export type SnapshotLifecycle = "CONNECTING" | "WAITING" | "LIVE" | "STALE" | "RECOVERING";

export type RuntimeSnapshot = Awaited<ReturnType<typeof getSystemSnapshot>>;

export interface RuntimeSnapshotView {
  data: RuntimeSnapshot | undefined;
  lifecycle: SnapshotLifecycle;
  /** Plain-language description of the connection to the runtime, never a spinner word. */
  reason: string;
  error: Error | null;
  sequence: number | null;
  updatedAt: number | null;
  ageMs: number | null;
  refresh: () => void;
}

/**
 * The single subscription to the frozen runtime snapshot. Every operator page
 * uses this hook so all panels read one consistent payload, one poller, and one
 * connection lifecycle. The dashboard recovers on its own: a failed poll keeps
 * the last known values on screen and marks them STALE until the next success.
 *
 * The transport is swappable so the same dashboard can read from a local
 * server function or a remote VPS runtime over HTTP without code changes.
 */
export function useRuntimeSnapshot(): RuntimeSnapshotView {
  const queryClient = useQueryClient();
  const transport = getSnapshotTransport();

  const query = useQuery({
    queryKey: SNAPSHOT_QUERY_KEY,
    queryFn: () => transport.fetch(),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    // Never blank the console on a failed poll: keep the last good snapshot.
    placeholderData: (previous) => previous,
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000),
    staleTime: 0,
  });

  const updatedAt = query.dataUpdatedAt || null;
  const ageMs = updatedAt ? Date.now() - updatedAt : null;
  const error = (query.error as Error | null) ?? null;

  let lifecycle: SnapshotLifecycle;
  let reason: string;
  if (!query.data) {
    if (error) {
      lifecycle = "RECOVERING";
      reason = `Runtime unreachable — retrying automatically (${error.message})`;
    } else {
      lifecycle = "CONNECTING";
      reason = "Opening the runtime snapshot channel";
    }
  } else if (error) {
    lifecycle = "RECOVERING";
    reason = `Last snapshot kept — retrying automatically (${error.message})`;
  } else if (ageMs !== null && ageMs > STALE_AFTER_MS) {
    lifecycle = "STALE";
    reason = `No fresh snapshot for ${Math.round(ageMs / 1000)}s — showing the last known values`;
  } else if (query.data.runtime.lifecycle === "STOPPED") {
    lifecycle = "WAITING";
    reason = "Runtime is stopped — telemetry reflects the last completed session";
  } else {
    lifecycle = "LIVE";
    reason = `Live · snapshot #${query.data.sequence}`;
  }

  return {
    data: query.data,
    lifecycle,
    reason,
    error,
    sequence: query.data?.sequence ?? null,
    updatedAt,
    ageMs,
    refresh: () => void queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY }),
  };
}
