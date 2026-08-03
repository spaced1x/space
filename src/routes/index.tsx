import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { ConsoleShell, Panel } from "../components/space/console-shell";
import { ConnectionCard } from "../components/space/connection-card";
import { ConnectionHistory } from "../components/space/connection-history";
import { RuntimeBanner } from "../components/space/runtime-banner";
import { SummaryRow } from "../components/space/summary-row";
import { TradingTargetCard } from "../components/space/trading-target-card";
import { TwapProviderCard } from "../components/space/twap-provider-card";
import { ExecutionPanel, OrderTable, PositionTable } from "../components/space/execution-panel";
import { MarketPanel } from "../components/space/market-panel";
import { RuntimePanel } from "../components/space/runtime-panel";
import { StatusDot, stateLabel } from "../components/space/status-dot";
import { StrategyPanel } from "../components/space/strategy-panel";
import type { EventSeverity } from "../core/bus/events";
import { getSystemSnapshot } from "../lib/system.functions";

const SEVERITY_TONE: Record<EventSeverity, string> = {
  INFO: "text-muted-foreground",
  SUCCESS: "text-ok",
  WARNING: "text-warn",
  ERROR: "text-fail",
};

function severityTone(severity: EventSeverity): string {
  return SEVERITY_TONE[severity] ?? "text-muted-foreground";
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SPACE — Mission Control" },
      {
        name: "description",
        content:
          "SPACE Mission Control: engine status, market discovery, Binance and Chainlink feeds, scheduler tasks and dependency health for the single-process trading runtime.",
      },
      { property: "og:title", content: "SPACE — Mission Control" },
      {
        property: "og:description",
        content:
          "Engine status, unified market state, feeds and dependency health for the SPACE trading runtime.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OperatorConsole,
});

function OperatorConsole() {
  const fetchSnapshot = useServerFn(getSystemSnapshot);

  const snapshot = useQuery({
    queryKey: ["system-snapshot"],
    queryFn: () => fetchSnapshot(),
    refetchInterval: 5000,
  });

  return (
    <ConsoleShell
      title="Mission Control"
      subtitle="What is happening right now. Operational only — configuration lives in the Operations Desk, analysis in Statistics and Replay."
    >
      {!snapshot.data ? (
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="text-section-title font-semibold text-card-foreground">
            {snapshot.isError ? "Runtime snapshot unavailable" : "Reading runtime snapshot"}
          </p>
          <dl className="mt-4 grid gap-2">
            <EmptyLine term="What" detail="Mission Control is waiting for the first runtime snapshot" />
            <EmptyLine
              term="Why"
              detail={
                snapshot.isError
                  ? "The dashboard could not reach the SPACE process"
                  : "The engine boots before it answers; nothing is displayed until real values arrive"
              }
            />
            <EmptyLine
              term="Action"
              detail={
                snapshot.isError
                  ? "Check the process with pm2 status and review the logs"
                  : "Wait for the boot sequence to complete (STARTING → VALIDATING → READY)"
              }
            />
            <EmptyLine term="Blocked" detail="Dashboard only — trading is unaffected by this page" />
            <EmptyLine
              term="Recovery"
              detail="Automatic once the runtime reports; if it persists, inspect the boot trace in the logs"
            />
          </dl>
        </div>
      ) : (
        <>
          <RuntimeBanner
            environment={snapshot.data.environment}
            runtime={snapshot.data.runtime}
            connections={snapshot.data.connections}
          />

          <SummaryRow
            environment={snapshot.data.environment}
            runtime={snapshot.data.runtime}
            health={snapshot.data.health}
            connections={snapshot.data.connections}
          />

          <Panel title="Current trading target" hint="the market SPACE is pointed at right now">
            <TradingTargetCard
              market={
                snapshot.data.engine.market.markets.FIVE_MINUTE ??
                snapshot.data.engine.market.markets.FIFTEEN_MINUTE ??
                null
              }
            />
          </Panel>

          <Panel title="TWAP provider" hint="active settlement provider and standby peers">
            <TwapProviderCard twap={snapshot.data.engine.twap} />
          </Panel>

          <Panel title="Runtime connections" hint="every external dependency, as observed">
            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {snapshot.data.connections.map((record) => (
                <ConnectionCard key={record.id} record={record} />
              ))}
            </div>
          </Panel>

          <Panel title="Connection history" hint="last 300 state changes observed by the runtime">
            <ConnectionHistory entries={snapshot.data.timeline} />
          </Panel>

          <Panel title="Strategy" hint="PTB · settlement TWAP · active window · direction">
            <StrategyPanel strategy={snapshot.data.engine.strategy} />
          </Panel>

          <Panel title="Current market">
            <MarketPanel market={snapshot.data.engine.market} />
          </Panel>

          <Panel title="Execution & wallet">
            <ExecutionPanel execution={snapshot.data.engine.execution} />
          </Panel>

          <Panel title="Active orders">
            <OrderTable orders={snapshot.data.engine.execution.orders} />
          </Panel>

          <Panel title="Positions">
            <PositionTable execution={snapshot.data.engine.execution} />
          </Panel>

          <Panel title="Feeds & scheduler" hint="live task and feed telemetry">
            <RuntimePanel
              scheduler={snapshot.data.engine.scheduler}
              feeds={snapshot.data.engine.feeds}
            />
          </Panel>

          <Panel title="Health summary">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {snapshot.data.health.components.map((entry) => (
                <article
                  key={entry.component}
                  className="rounded-lg border border-border bg-card p-4 shadow-sm"
                >
                  <div className="flex items-center gap-2">
                    <StatusDot state={entry.state} />
                    <h3 className="font-mono text-card-title text-card-foreground">
                      {entry.component}
                    </h3>
                    <span className="ml-auto text-status uppercase text-muted-foreground">
                      {stateLabel(entry.state)}
                    </span>
                  </div>
                  <p className="mt-2 text-label leading-relaxed text-muted-foreground">
                    {entry.message}
                  </p>
                </article>
              ))}
            </div>
          </Panel>

          <Panel title="Recent events">
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
              {snapshot.data.events.map((event) => (
                <li
                  key={`${event.correlationId}-${event.occurredAt}-${event.type}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 font-mono text-table"
                >
                  <span className="text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleTimeString()}
                  </span>
                  <span className={`w-16 shrink-0 uppercase ${severityTone(event.severity)}`}>
                    {event.severity}
                  </span>
                  <span className="text-primary">{event.type}</span>
                  <span className="text-muted-foreground">{event.source}</span>
                  <span className="ml-auto text-muted-foreground">{event.correlationId}</span>
                </li>
              ))}
              {snapshot.data.events.length === 0 && (
                <li className="p-3 text-label text-muted-foreground">
                  No events yet — the bus is empty because the engine has not changed state since
                  boot. Events appear here as soon as anything happens.
                </li>
              )}
            </ul>
          </Panel>
        </>
      )}
    </ConsoleShell>
  );
}
