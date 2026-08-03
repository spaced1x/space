import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { ConsoleShell, Panel } from "../components/space/console-shell";
import { getStatistics } from "../lib/stats.functions";

export const Route = createFileRoute("/stats")({
  head: () => ({
    meta: [
      { title: "Statistics — SPACE" },
      {
        name: "description",
        content:
          "Fill rate, win rate, submission and fill latencies, per-window performance and daily realized PnL for the SPACE trading engine.",
      },
      { property: "og:title", content: "Statistics — SPACE" },
      {
        property: "og:description",
        content: "Latencies, fill percentage and daily PnL computed from persisted execution evidence.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Statistics,
});

const money = (value: number) => `${value >= 0 ? "" : "-"}$${Math.abs(value).toFixed(2)}`;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const ms = (value: number | null) => (value != null ? `${Math.round(value)}ms` : "—");

function Statistics() {
  const fetchStats = useServerFn(getStatistics);
  const query = useQuery({
    queryKey: ["statistics"],
    queryFn: () => fetchStats(),
    refetchInterval: 10_000,
  });

  const stats = query.data?.stats;

  return (
    <ConsoleShell
      title="Statistics"
      subtitle="Every number here is a reduction over persisted orders, fills, intents and risk decisions — Statistics and Replay can never disagree."
    >
      {!stats ? (
        <p className="font-mono text-sm text-muted-foreground">computing…</p>
      ) : (
        <>
          <Panel title="Today" hint={stats.today.day}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Realized PnL" value={money(stats.today.realizedPnl)} accent />
              <Metric label="Trades" value={String(stats.today.trades)} />
              <Metric label="Filled" value={String(stats.today.filled)} />
              <Metric label="Cancelled" value={String(stats.today.cancelled)} />
              <Metric label="Rejected" value={String(stats.today.rejected)} />
              <Metric label="Session trades" value={String(stats.session.trades)} />
              <Metric label="Session filled" value={String(stats.session.filled)} />
              <Metric label="Session PnL" value={money(stats.session.realizedPnl)} />
            </div>
          </Panel>

          <Panel title="Rates and PnL">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Fill rate" value={pct(stats.rates.fillRate)} accent />
              <Metric label="Win rate" value={pct(stats.rates.winRate)} />
              <Metric label="Loss rate" value={pct(stats.rates.lossRate)} />
              <Metric label="Realized" value={money(stats.pnl.realized)} />
              <Metric label="Unrealized" value={money(stats.pnl.unrealized)} />
              <Metric label="Largest win" value={money(stats.pnl.largestWin)} />
              <Metric label="Largest loss" value={money(stats.pnl.largestLoss)} />
              <Metric
                label="Best window"
                value={stats.best.window != null ? `${stats.best.window}s` : "—"}
              />
            </div>
          </Panel>

          <Panel title="Latency">
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric label="Submit" value={ms(stats.latency.avgSubmitMs)} />
              <Metric label="Submit → fill" value={ms(stats.latency.avgFillMs)} />
              <Metric label="Trigger → fill" value={ms(stats.latency.avgTriggerToFillMs)} />
            </div>
          </Panel>

          <Panel title="Per-window performance">
            <Table
              head={["window", "buffer", "trades", "filled", "fill %", "pnl"]}
              rows={stats.windows.map((window) => [
                `${window.seconds}s`,
                window.buffer?.toString() ?? "—",
                String(window.trades),
                String(window.filled),
                pct(window.fillRate),
                money(window.realizedPnl),
              ])}
              empty="no window trades recorded yet"
            />
          </Panel>

          <Panel title="Daily PnL">
            <Table
              head={["day", "trades", "filled", "pnl"]}
              rows={stats.daily.map((day) => [
                day.day,
                String(day.trades),
                String(day.filled),
                money(day.realizedPnl),
              ])}
              empty="no trading days recorded yet"
            />
          </Panel>
        </>
      )}
    </ConsoleShell>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono text-sm ${accent ? "text-primary" : "text-foreground"}`}>
        {value}
      </p>
    </div>
  );
}

function Table({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: string[][];
  empty: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <table className="w-full text-left font-mono text-[11px]">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            {head.map((cell) => (
              <th key={cell} className="p-2 font-normal">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-foreground">
          {rows.map((row) => (
            <tr key={row.join("|")} className="border-t border-border">
              {row.map((cell, index) => (
                <td key={index} className="p-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={head.length} className="p-3 text-muted-foreground">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
