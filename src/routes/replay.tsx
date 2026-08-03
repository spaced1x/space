import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { ConsoleShell, Panel } from "../components/space/console-shell";
import { getReplayMarket, getReplayMarkets } from "../lib/replay.functions";

export const Route = createFileRoute("/replay")({
  head: () => ({
    meta: [
      { title: "Replay — SPACE" },
      {
        name: "description",
        content:
          "Reconstruct any past BTC market from persisted evidence and see exactly why each execution window traded, skipped or failed.",
      },
      { property: "og:title", content: "Replay — SPACE" },
      {
        property: "og:description",
        content: "Every trade and every skip explained from the database alone.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Replay,
});

function Replay() {
  const fetchMarkets = useServerFn(getReplayMarkets);
  const fetchMarket = useServerFn(getReplayMarket);
  const [selected, setSelected] = useState<string | null>(null);

  const markets = useQuery({
    queryKey: ["replay-markets"],
    queryFn: () => fetchMarkets(),
    refetchInterval: 30_000,
  });

  const conditionId = selected ?? markets.data?.[0]?.conditionId ?? null;

  const market = useQuery({
    queryKey: ["replay-market", conditionId],
    queryFn: () => fetchMarket({ data: { conditionId: conditionId! } }),
    enabled: Boolean(conditionId),
  });

  return (
    <ConsoleShell
      title="Replay"
      subtitle="Replay reads persisted evidence only. A restarted process explains history exactly the same way it did before the restart."
    >
      <Panel title="Markets" hint={`${markets.data?.length ?? 0} reconstructed`}>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="p-2 font-normal">market</th>
                <th className="p-2 font-normal">horizon</th>
                <th className="p-2 font-normal">windows</th>
                <th className="p-2 font-normal">triggers</th>
                <th className="p-2 font-normal">orders</th>
                <th className="p-2 font-normal">fills</th>
              </tr>
            </thead>
            <tbody className="text-foreground">
              {(markets.data ?? []).map((entry) => (
                <tr
                  key={entry.conditionId}
                  onClick={() => setSelected(entry.conditionId)}
                  className={`cursor-pointer border-t border-border hover:bg-accent ${
                    entry.conditionId === conditionId ? "bg-accent" : ""
                  }`}
                >
                  <td className="p-2">{entry.slug || entry.conditionId.slice(0, 14)}</td>
                  <td className="p-2">{entry.horizon}</td>
                  <td className="p-2">{entry.windows}</td>
                  <td className="p-2">{entry.triggers}</td>
                  <td className="p-2">{entry.orders}</td>
                  <td className="p-2">{entry.fills}</td>
                </tr>
              ))}
              {(markets.data?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={6} className="p-3 text-muted-foreground">
                    no markets recorded yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {market.data && (
        <>
          <Panel title="Settlement" hint={market.data.market.slug}>
            <div className="rounded-lg border border-border bg-card p-4 font-mono text-[11px] text-muted-foreground">
              <p className="text-foreground">{market.data.settlement.note}</p>
              <p className="mt-1">
                status {market.data.settlement.status} · filled{" "}
                {market.data.settlement.filledSize} · cost $
                {market.data.settlement.cost.toFixed(2)} · avg{" "}
                {market.data.settlement.avgPrice?.toFixed(4) ?? "—"}
              </p>
            </div>
          </Panel>

          <Panel title="Windows" hint="every outcome explained">
            <div className="space-y-3">
              {market.data.windows.map((window) => (
                <article
                  key={window.id}
                  className="rounded-lg border border-border bg-card p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-baseline gap-3">
                    <h3 className="font-mono text-sm text-card-foreground">{window.seconds}s</h3>
                    <span className="font-mono text-[11px] uppercase text-primary">
                      {window.state}
                    </span>
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                      buffer {window.buffer} · {window.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-foreground">{window.outcome}</p>
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                    opening TWAP {window.openingTwap?.toFixed(2) ?? "—"} · PTB{" "}
                    {window.ptb?.toFixed(2) ?? "—"} · trigger{" "}
                    {window.frozenTrigger?.toFixed(2) ?? "—"} · direction{" "}
                    {window.direction ?? "—"}
                  </p>
                  {window.transitions.length > 0 && (
                    <ul className="mt-2 space-y-1 font-mono text-[10px] text-muted-foreground">
                      {window.transitions.map((transition) => (
                        <li key={`${transition.at}-${transition.state}`}>
                          {new Date(transition.at).toLocaleTimeString()} · {transition.state} ·{" "}
                          {transition.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                  {window.risk.length > 0 && (
                    <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                      risk:{" "}
                      {window.risk
                        .map((decision) => `${decision.status} — ${decision.reason}`)
                        .join(" | ")}
                    </p>
                  )}
                  {window.fills.length > 0 && (
                    <p className="mt-2 font-mono text-[10px] text-ok">
                      fills:{" "}
                      {window.fills
                        .map((fill) => `${fill.size} @ ${fill.price.toFixed(4)}`)
                        .join(", ")}
                    </p>
                  )}
                </article>
              ))}
              {market.data.windows.length === 0 && (
                <p className="font-mono text-xs text-muted-foreground">
                  no windows recorded for this market
                </p>
              )}
            </div>
          </Panel>
        </>
      )}
    </ConsoleShell>
  );
}
