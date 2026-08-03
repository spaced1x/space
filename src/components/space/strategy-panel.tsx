import type { StrategySnapshot } from "../../core/strategy/types";

// Read-only projection of the strategy engine snapshot. Presentation only:
// no strategy maths lives in the dashboard.

function num(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? "—" : value.toFixed(digits);
}

export function StrategyPanel({ strategy }: { strategy: StrategySnapshot }) {
  const { market, twap, quota, prediction } = strategy;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Card title="Active market">
        <Line label="Horizon" value={market.horizon ?? "—"} accent />
        <Line label="Slug" value={market.slug ?? "—"} />
        <Line label="PTB" value={num(market.ptb)} />
        <Line
          label="Settlement"
          value={market.settlementAt ? new Date(market.settlementAt).toLocaleTimeString() : "—"}
        />
      </Card>

      <Card title={`Settlement TWAP (${twap.lengthSeconds || "—"}s)`}>
        <Line label="Value" value={num(twap.value)} accent />
        <Line label="State" value={twap.state} />
        <Line label="Samples" value={String(twap.samples)} />
        <Line
          label="Updated"
          value={twap.lastUpdateAt ? new Date(twap.lastUpdateAt).toLocaleTimeString() : "—"}
        />
      </Card>

      <Card title="Frozen trigger">
        <Line label="Direction" value={prediction.direction ?? "—"} accent />
        <Line label="Trigger" value={num(prediction.frozenTrigger)} />
        <Line label="Buffer" value={num(prediction.buffer, 3)} />
        <Line label="Active window" value={strategy.activeWindowId?.split(":").pop() ?? "none"} />
      </Card>

      <Card title="Trade quota">
        <Line label="Per market" value={String(quota.tradesPerMarket)} accent />
        <Line label="Used" value={String(quota.used)} />
        <Line label="Remaining" value={String(quota.remaining)} />
        <Line label="Intents" value={String(strategy.intents.length)} />
      </Card>
    </div>
  );
}

export function BotPredictionPanel({ strategy }: { strategy: StrategySnapshot }) {
  const { prediction } = strategy;
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Suggested
        </span>
        <span className="font-mono text-lg text-primary">{prediction.suggestion}</span>
        <span className="ml-auto rounded border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          advisory only
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Line label="Settlement TWAP" value={num(prediction.settlementTwap)} />
        <Line label="PTB" value={num(prediction.ptb)} />
        <Line label="Difference" value={num(prediction.difference)} />
        <Line label="Buffer" value={num(prediction.buffer, 3)} />
        <Line label="Frozen trigger" value={num(prediction.frozenTrigger)} />
        <Line label="Direction" value={prediction.direction ?? "—"} />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {prediction.note}. This panel never influences the trigger engine.
      </p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </h3>
      <div className="mt-2 space-y-1.5">{children}</div>
    </article>
  );
}

function Line({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${accent ? "text-primary" : "text-foreground"} text-right`}>
        {value}
      </span>
    </div>
  );
}
