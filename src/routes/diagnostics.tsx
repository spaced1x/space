import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { ConsoleShell, Panel } from "../components/space/console-shell";
import { MarketPanel } from "../components/space/market-panel";
import { ProductionPanel } from "../components/space/production-panel";
import { RuntimePanel } from "../components/space/runtime-panel";
import { RuntimeDiagnostics } from "../components/space/runtime-diagnostics";
import { StatusDot, stateLabel } from "../components/space/status-dot";
import { ExecutionPanel } from "../components/space/execution-panel";
import { BotPredictionPanel, StrategyPanel } from "../components/space/strategy-panel";
import { IntentList, WindowTimeline } from "../components/space/window-timeline";
import type { EventSeverity } from "../core/bus/events";
import { getDiagnostics, getFailureHarness, setFailureScenario } from "../lib/diagnostics.functions";

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

// Failure simulation harness. Available on non-production hosts only; the
// server refuses every mutation when NODE_ENV is production.
function FailureHarnessPanel() {
  const fetchHarness = useServerFn(getFailureHarness);
  const mutateHarness = useServerFn(setFailureScenario);
  const query = useQuery({
    queryKey: ["failure-harness"],
    queryFn: () => fetchHarness(),
    refetchInterval: 10_000,
  });
  const harness = query.data;

  async function send(action: "register" | "clear" | "clear-all", name?: string) {
    await mutateHarness({
      data: {
        action,
        ...(name ? { name } : {}),
        kind: "throw" as const,
        errorMessage: `simulated failure: ${name ?? "all"}`,
      },
    });
    await query.refetch();
  }

  return (
    <Panel
      title="Failure simulation"
      hint={harness?.enabled === false ? "disabled on production hosts" : "recovery-path harness"}
    >
      {!harness ? (
        <p className="font-mono text-xs text-muted-foreground">loading…</p>
      ) : !harness.enabled ? (
        <p className="font-mono text-xs text-muted-foreground">
          The harness is refused on production hosts. Exercise recovery paths on a staging host.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {["venue-submit", "chain-read", "gamma-discovery"].map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => void send("register", name)}
                className="rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-card-foreground hover:border-primary"
              >
                inject {name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void send("clear-all")}
              className="rounded-md border border-border bg-muted px-3 py-1.5 font-mono text-[11px] text-muted-foreground hover:border-primary"
            >
              clear all
            </button>
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
            {harness.scenarios.map((scenario) => (
              <li
                key={scenario.name}
                className="flex flex-wrap items-baseline gap-x-3 p-3 font-mono text-xs"
              >
                <span className="text-warn uppercase">{scenario.kind}</span>
                <span className="text-primary">{scenario.name}</span>
                <span className="text-muted-foreground">{scenario.errorMessage}</span>
                <button
                  type="button"
                  onClick={() => void send("clear", scenario.name)}
                  className="ml-auto text-[11px] text-muted-foreground underline hover:text-foreground"
                >
                  clear
                </button>
              </li>
            ))}
            {harness.scenarios.length === 0 && (
              <li className="p-3 font-mono text-xs text-ok">no scenarios injected</li>
            )}
          </ul>
        </div>
      )}
    </Panel>
  );
}

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
        <p className="text-label text-muted-foreground">
          Waiting for the first diagnostics snapshot from the engine process.
        </p>
      ) : (
        <>
          <RuntimeDiagnostics />

          <Panel title="Runtime">
            <RuntimePanel scheduler={data.engine.scheduler} feeds={data.engine.feeds} />
          </Panel>

          <Panel title="Unified market state">
            <MarketPanel market={data.engine.market} />
          </Panel>

          <Panel title="Strategy engine">
            <StrategyPanel strategy={data.engine.strategy} />
          </Panel>

          <Panel title="Bot prediction" hint="advisory only — never places an order">
            <BotPredictionPanel strategy={data.engine.strategy} />
          </Panel>

          <Panel title="Execution windows">
            <WindowTimeline strategy={data.engine.strategy} />
          </Panel>

          <Panel title="Execution intents">
            <IntentList strategy={data.engine.strategy} />
          </Panel>

          <Panel title="Risk and execution">
            <ExecutionPanel execution={data.execution} />
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

          <ProductionPanel />

          <FailureHarnessPanel />

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
