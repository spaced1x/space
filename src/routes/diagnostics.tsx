import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { ConsoleShell, Panel } from "../components/space/console-shell";
import { MarketPanel } from "../components/space/market-panel";
import { RuntimePanel } from "../components/space/runtime-panel";
import { StatusDot, stateLabel } from "../components/space/status-dot";
import type { EventSeverity } from "../core/bus/events";
import { getDiagnostics } from "../lib/diagnostics.functions";

export const Route = createFileRoute("/diagnostics")({
  head: () => ({
    meta: [
      { title: "Live Diagnostics — SPACE" },
      {
        name: "description",
        content:
          "Scheduler drift, feed connectivity, dependency health, recent errors and the full runtime event log for the SPACE trading runtime.",
      },
      { property: "og:title", content: "Live Diagnostics — SPACE" },
      {
        property: "og:description",
        content: "Read-only instrumentation for feeds, scheduler, health and the event log.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Diagnostics,
});

const SEVERITY_TONE: Record<EventSeverity, string> = {
  INFO: "text-muted-foreground",
  SUCCESS: "text-ok",
  WARNING: "text-warn",
  ERROR: "text-fail",
};

function Diagnostics() {
  const fetchDiagnostics = useServerFn(getDiagnostics);
  const query = useQuery({
    queryKey: ["diagnostics"],
    queryFn: () => fetchDiagnostics(),
    refetchInterval: 3000,
  });

  const data = query.data;

  return (
    <ConsoleShell
      title="Live Diagnostics"
      subtitle="Read-only instrumentation. Everything shown here comes from the running engine; this page owns nothing and changes nothing."
    >
      {!data ? (
        <p className="font-mono text-sm text-muted-foreground">connecting…</p>
      ) : (
        <>
          <Panel title="Runtime">
            <RuntimePanel scheduler={data.engine.scheduler} feeds={data.engine.feeds} />
          </Panel>

          <Panel title="Unified market state">
            <MarketPanel market={data.engine.market} />
          </Panel>

          <Panel title="Health registry" hint={`overall ${stateLabel(data.health.state)}`}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.health.components.map((entry) => (
                <article
                  key={entry.component}
                  className="rounded-lg border border-border bg-card p-4 shadow-sm"
                >
                  <div className="flex items-center gap-2">
                    <StatusDot state={entry.state} />
                    <h3 className="font-mono text-sm text-card-foreground">{entry.component}</h3>
                    <span className="ml-auto text-[11px] uppercase text-muted-foreground">
                      {stateLabel(entry.state)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {entry.message}
                  </p>
                </article>
              ))}
            </div>
          </Panel>

          <Panel title="Warnings and errors" hint={`${data.errors.length} recent`}>
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
              {data.errors.map((event) => (
                <li
                  key={`${event.correlationId}-${event.occurredAt}-${event.type}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 font-mono text-xs"
                >
                  <span className="text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleTimeString()}
                  </span>
                  <span className={`w-16 shrink-0 uppercase ${SEVERITY_TONE[event.severity]}`}>
                    {event.severity}
                  </span>
                  <span className="text-primary">{event.type}</span>
                  <span className="text-muted-foreground">{event.source}</span>
                </li>
              ))}
              {data.errors.length === 0 && (
                <li className="p-3 font-mono text-xs text-ok">no warnings or errors</li>
              )}
            </ul>
          </Panel>

          <Panel title="Runtime event log">
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
              {data.events.map((event) => (
                <li
                  key={`${event.correlationId}-${event.occurredAt}-${event.type}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 font-mono text-xs"
                >
                  <span className="text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleTimeString()}
                  </span>
                  <span className={`w-16 shrink-0 uppercase ${SEVERITY_TONE[event.severity]}`}>
                    {event.severity}
                  </span>
                  <span className="text-primary">{event.type}</span>
                  <span className="text-muted-foreground">{event.source}</span>
                  <span className="ml-auto text-muted-foreground">{event.correlationId}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </ConsoleShell>
  );
}
