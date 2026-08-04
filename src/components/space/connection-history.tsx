import type { ConnectionTimelineEntry } from "../../core/runtime/connections.server";
import { useRuntimeAgo } from "../../lib/use-runtime-now";
import { StatusDot } from "./status-dot";

function Ago({ iso }: { iso: string }) {
  const ago = useRuntimeAgo(iso);
  return <>{ago}</>;
}

/**
 * A rolling timeline of every connection state change observed by the runtime.
 * Each row is a real observation — no inferred or placeholder events.
 */
export function ConnectionHistory({ entries }: { entries: ConnectionTimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card p-5 text-body text-muted-foreground">
        No connection events yet — the runtime has not recorded any state changes since boot.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <table className="w-full text-left">
        <thead className="bg-muted/60 text-muted-foreground">
          <tr>
            <th className="px-5 py-3 text-status font-normal uppercase tracking-wide">Time</th>
            <th className="px-5 py-3 text-status font-normal uppercase tracking-wide">Connection</th>
            <th className="px-5 py-3 text-status font-normal uppercase tracking-wide">State</th>
            <th className="px-5 py-3 text-status font-normal uppercase tracking-wide">Message</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border text-body">
          {entries.map((entry) => (
            <tr key={`${entry.at}-${entry.id}`}>
              <td className="px-5 py-3 font-mono text-status whitespace-nowrap">
                {new Date(entry.at).toLocaleTimeString()}
                <span className="ml-2 text-muted-foreground">(<Ago iso={entry.at} />)</span>
              </td>
              <td className="px-5 py-3 font-medium text-card-foreground">{entry.label}</td>
              <td className="px-5 py-3">
                <div className="flex items-center gap-2">
                  <StatusDot state={projectHealth(entry.state)} />
                  <span className="font-mono text-status uppercase">{entry.state.replace(/_/g, " ")}</span>
                </div>
              </td>
              <td className="px-5 py-3 text-muted-foreground">{entry.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function projectHealth(state: ConnectionTimelineEntry["state"]): "OK" | "DEGRADED" | "FAILED" | "DISABLED" | "NOT_INITIALIZED" {
  switch (state) {
    case "CONNECTED":
      return "OK";
    case "FAILED":
      return "FAILED";
    case "NOT_CONFIGURED":
      return "DISABLED";
    case "NOT_STARTED":
      return "NOT_INITIALIZED";
    default:
      return "DEGRADED";
  }
}
