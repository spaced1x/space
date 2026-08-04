import { type ReactNode, useEffect, useState } from "react";

/** A panel never waits forever: after this it reports why it has no data. */
const TIMEOUT_MS = 10_000;

export interface AsyncPanelProps<T> {
  /** What this panel is reading, used in every status line. */
  label: string;
  data: T | undefined | null;
  error?: Error | null;
  /** Set when the source answered successfully but has nothing to show yet. */
  emptyReason?: string | null;
  /** What the operator should do when the panel cannot render. */
  action?: string | null;
  children: (data: T) => ReactNode;
}

function Shell({ tone, children }: { tone: "muted" | "warn" | "fail"; children: ReactNode }) {
  const toneClass =
    tone === "fail" ? "text-fail" : tone === "warn" ? "text-warn" : "text-muted-foreground";
  return <div className={`space-y-1 text-body ${toneClass}`}>{children}</div>;
}

/**
 * Renders a panel's data, or an explicit reason it cannot. There is no generic
 * "loading..." state: before the timeout the panel names its source, after the
 * timeout it reports the timeout and the recovery path.
 */
export function AsyncPanel<T>({
  label,
  data,
  error,
  emptyReason,
  action,
  children,
}: AsyncPanelProps<T>) {
  const [timedOut, setTimedOut] = useState(false);
  const settled = data !== undefined && data !== null;

  useEffect(() => {
    if (settled || error) {
      setTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setTimedOut(true), TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [settled, error]);

  if (error) {
    return (
      <Shell tone="fail">
        <p>
          {label} could not be read — {error.message}
        </p>
        <p className="text-caption">
          {action ?? "SPACE keeps retrying automatically; no refresh is required."}
        </p>
      </Shell>
    );
  }

  if (!settled) {
    if (timedOut) {
      return (
        <Shell tone="fail">
          <p>{label} did not respond within 10s.</p>
          <p className="text-caption">
            {action ?? "The runtime is still being polled; check Diagnostics for the boot trace."}
          </p>
        </Shell>
      );
    }
    return (
      <Shell tone="warn">
        <p>Reading {label} from the runtime…</p>
      </Shell>
    );
  }

  if (emptyReason) {
    return (
      <Shell tone="muted">
        <p>{emptyReason}</p>
        {action ? <p className="text-caption">{action}</p> : null}
      </Shell>
    );
  }

  return <>{children(data)}</>;
}
