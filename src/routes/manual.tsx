import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { ConsoleShell, Panel } from "../components/space/console-shell";
import { Button } from "../components/ui/button";
import { getManualDesk, submitManualOrder } from "../lib/manual.functions";
import { sendCommand } from "../lib/system.functions";

export const Route = createFileRoute("/manual")({
  head: () => ({
    meta: [
      { title: "Manual Trading — SPACE" },
      {
        name: "description",
        content:
          "Operator-driven BUY/SELL on the active BTC market. Manual mode disables strategy auto-execution and reuses the same Risk and Execution engines.",
      },
      { property: "og:title", content: "Manual Trading — SPACE" },
      {
        property: "og:description",
        content: "Isolated manual desk: limit or market orders through the same execution path.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ManualTrading,
});

type Horizon = "FIVE_MINUTE" | "FIFTEEN_MINUTE";

function ManualTrading() {
  const queryClient = useQueryClient();
  const fetchDesk = useServerFn(getManualDesk);
  const place = useServerFn(submitManualOrder);
  const dispatch = useServerFn(sendCommand);

  const [horizon, setHorizon] = useState<Horizon>("FIVE_MINUTE");
  const [kind, setKind] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [size, setSize] = useState(5);

  const desk = useQuery({
    queryKey: ["manual-desk", horizon],
    queryFn: () => fetchDesk({ data: { horizon } }),
    refetchInterval: 2000,
  });

  const order = useMutation({
    mutationFn: (direction: "UP" | "DOWN") =>
      place({ data: { horizon, direction, kind, size } }),
    onSuccess: (result) => {
      if (result.status === "ACCEPTED") toast.success(`Order accepted — ${result.reason}`);
      else toast.error(`Rejected — ${result.reason}`);
      void queryClient.invalidateQueries({ queryKey: ["system-snapshot"] });
      void queryClient.invalidateQueries({ queryKey: ["manual-desk"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const mode = useMutation({
    mutationFn: (next: "STRATEGY" | "MANUAL") =>
      dispatch({ data: { kind: "SET_MODE", mode: next } }),
    onSuccess: (verdict) => {
      if (verdict.status === "ACCEPTED") toast.success(verdict.reason);
      else toast.error(verdict.reason);
      void queryClient.invalidateQueries({ queryKey: ["system-snapshot"] });
      void queryClient.invalidateQueries({ queryKey: ["manual-desk"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const data = desk.data;
  // The Command Bus returns a verdict; the risk decision travels in details.
  const lastRisk = (order.data?.details as
    | { risk?: { status: string; reason: string; code: string; at: string } | null }
    | undefined)?.risk;

  return (
    <ConsoleShell
      title="Manual Trading"
      subtitle="Manual mode is isolated: while it is ON the strategy never submits an order. Manual orders still pass the Risk Engine and the Execution Engine unchanged."
    >
      <Panel title="Mode" hint={`engine mode: ${data?.mode ?? "—"}`}>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={mode.isPending} onClick={() => mode.mutate("MANUAL")}>
            Switch to MANUAL
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={mode.isPending}
            onClick={() => mode.mutate("STRATEGY")}
          >
            Switch to STRATEGY
          </Button>
        </div>
        {data && !data.enabled && (
          <p className="text-xs text-warn">
            Manual desk is locked. Enable manual trading on the Operations Desk and put the engine
            in MANUAL mode.
          </p>
        )}
      </Panel>

      <Panel title="Market">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Horizon">
            <select
              value={horizon}
              onChange={(event) => setHorizon(event.target.value as Horizon)}
              className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground"
            >
              <option value="FIVE_MINUTE">BTC 5 minute</option>
              <option value="FIFTEEN_MINUTE">BTC 15 minute</option>
            </select>
          </Metric>
          <Metric label="Market">{data?.market?.slug ?? "—"}</Metric>
          <Metric label="PTB">{data?.ptb?.toFixed(2) ?? "—"}</Metric>
          <Metric label="Settlement TWAP">{data?.settlementTwap?.toFixed(2) ?? "—"}</Metric>
          <Metric label="Difference">{data?.difference?.toFixed(2) ?? "—"}</Metric>
          <Metric label="Suggested">{data?.suggestedDirection ?? "—"}</Metric>
          <Metric label="Confidence">
            {data?.confidence != null ? `${Math.round(data.confidence * 100)}%` : "—"}
          </Metric>
          <Metric label="Trend">{data?.trend ?? "—"}</Metric>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Suggestion is advisory only. The manual desk never places an order by itself.
        </p>
      </Panel>

      <Panel title="Order ticket">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Order type">
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as "LIMIT" | "MARKET")}
              className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground"
            >
              <option value="LIMIT">Limit</option>
              <option value="MARKET">Market</option>
            </select>
          </Metric>
          <Metric label="Size (shares)">
            <input
              type="number"
              min={1}
              step={1}
              value={size}
              onChange={(event) => setSize(Number(event.target.value) || 0)}
              className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground"
            />
          </Metric>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={order.isPending || !data?.enabled || size <= 0}
            onClick={() => order.mutate("UP")}
          >
            Buy UP
          </Button>
          <Button
            variant="secondary"
            disabled={order.isPending || !data?.enabled || size <= 0}
            onClick={() => order.mutate("DOWN")}
          >
            Buy DOWN
          </Button>
        </div>
      </Panel>

      {lastRisk && (
        <Panel title="Last risk decision">
          <div className="rounded-lg border border-border bg-card p-4 font-mono text-[11px] text-muted-foreground">
            <p
              className={lastRisk.status === "APPROVED" ? "text-ok" : "text-fail"}
            >
              {lastRisk.status} — {lastRisk.reason}
            </p>
            <p className="mt-1">
              {lastRisk.code} · {new Date(lastRisk.at).toLocaleTimeString()}
            </p>
          </div>
        </Panel>
      )}
    </ConsoleShell>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 rounded-lg border border-border bg-card p-3">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <div className="font-mono text-xs text-foreground">{children}</div>
    </div>
  );
}
