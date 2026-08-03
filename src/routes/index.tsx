import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { CommandDeck } from "../components/space/command-deck";
import { MissionControl } from "../components/space/mission-control";
import { MarketPanel } from "../components/space/market-panel";
import { RuntimePanel } from "../components/space/runtime-panel";
import { StatusDot, stateLabel } from "../components/space/status-dot";
import { BotPredictionPanel, StrategyPanel } from "../components/space/strategy-panel";
import { IntentList, WindowTimeline } from "../components/space/window-timeline";
import type { Command } from "../core/bus/commands";
import type { EventSeverity } from "../core/bus/events";
import { getSystemSnapshot, sendCommand } from "../lib/system.functions";

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
  const queryClient = useQueryClient();
  const fetchSnapshot = useServerFn(getSystemSnapshot);
  const dispatch = useServerFn(sendCommand);

  const snapshot = useQuery({
    queryKey: ["system-snapshot"],
    queryFn: () => fetchSnapshot(),
    refetchInterval: 5000,
  });

  const command = useMutation({
    mutationFn: (input: Command) => dispatch({ data: input }),
    onSuccess: (verdict) => {
      if (verdict.status === "ACCEPTED") toast.success(`${verdict.command}: ${verdict.reason}`);
      else toast.error(`${verdict.command} rejected — ${verdict.reason}`);
      void queryClient.invalidateQueries({ queryKey: ["system-snapshot"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (!snapshot.data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <p className="font-mono text-sm text-muted-foreground">
          {snapshot.isError ? "snapshot unavailable" : "connecting to SPACE runtime…"}
        </p>
      </main>
    );
  }

  const { runtime, health, events, engine } = snapshot.data;

  return (
    <div className="flex min-h-screen flex-col bg-background lg:flex-row">
      <MissionControl
        runtime={runtime}
        health={health}
        market={engine.market}
        strategy={engine.strategy}
      />

      <main className="flex-1 space-y-8 p-6 lg:p-10">
        <header className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Mission Control
            </h1>
            <span className="rounded border border-primary/30 bg-accent px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-accent-foreground">
              milestone 3 — frozen window strategy
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Settlement TWAP, frozen windows, buffers, triggers, quota and execution intents are
            live on top of the milestone 2 runtime. Nothing is executed: the strategy produces
            immutable execution intents only. Risk and order execution attach in later milestones.
          </p>
          <p className="text-xs text-muted-foreground">
            Engine boots into OBSERVE. ARMED is only ever reached by an explicit operator ARM
            command.
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Strategy
          </h2>
          <StrategyPanel strategy={engine.strategy} />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Bot prediction
          </h2>
          <BotPredictionPanel strategy={engine.strategy} />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Execution windows
          </h2>
          <WindowTimeline strategy={engine.strategy} />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Execution intents
          </h2>
          <IntentList strategy={engine.strategy} />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Unified market state
          </h2>
          <MarketPanel market={engine.market} />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Runtime
          </h2>
          <RuntimePanel scheduler={engine.scheduler} feeds={engine.feeds} />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Command bus
          </h2>
          <CommandDeck
            runtime={runtime}
            pending={command.isPending}
            onCommand={(input) => command.mutate(input)}
          />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Health registry
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {health.components.map((entry) => (
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
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Runtime event log
          </h2>
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
            {events.map((event) => (
              <li
                key={`${event.correlationId}-${event.occurredAt}-${event.type}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 font-mono text-xs"
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
            {events.length === 0 && (
              <li className="p-3 font-mono text-xs text-muted-foreground">no events yet</li>
            )}
          </ul>
        </section>
      </main>
    </div>
  );
}
