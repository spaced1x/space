import { useEffect, useState } from "react";

import { useRuntimeSnapshot } from "./use-runtime-snapshot";

/**
 * Return the runtime's current time as a moving clock. The anchor is the
 * `serverNow` field from the latest snapshot; only the small elapsed interval
 * since the snapshot arrived is measured with the browser clock. This keeps
 * event ordering and durations consistent with the runtime while avoiding the
 * hydration mismatches that come from using `Date.now()` during render.
 */
export function useRuntimeNow(): number | null {
  const { data } = useRuntimeSnapshot();
  const serverNow = data?.serverNow ?? null;
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (serverNow === null) return;
    setElapsedMs(0);
    const interval = setInterval(
      () => setElapsedMs(Date.now() - new Date(data?.generatedAt ?? serverNow).getTime()),
      1000,
    );
    return () => clearInterval(interval);
  }, [serverNow, data?.generatedAt]);

  return serverNow === null ? null : serverNow + elapsedMs;
}

/**
 * Format a duration relative to the runtime clock. Returns a stable string
 * during SSR and the first client render, then updates live after hydration.
 */
export function useRuntimeAgo(iso: string | null | undefined): string {
  const now = useRuntimeNow();
  if (!iso) return "never";
  if (now === null) return new Date(iso).toLocaleTimeString();
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

/**
 * Format a countdown to a future runtime instant. Returns a stable string during
 * SSR and the first client render.
 */
export function useRuntimeCountdown(iso: string | null | undefined): string {
  const now = useRuntimeNow();
  if (!iso) return "—";
  if (now === null) return new Date(iso).toLocaleTimeString();
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "settled";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
