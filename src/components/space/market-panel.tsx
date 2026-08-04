import type { MarketState } from "../../core/market/types";

// Read-only projection of the unified market state. No provider is queried
// here; the panel renders exactly what the engine published.
export function MarketPanel({ market }: { market: MarketState }) {
  const rows = [
    { label: "BTC 5 minute", value: market.markets.FIVE_MINUTE },
    { label: "BTC 15 minute", value: market.markets.FIFTEEN_MINUTE },
  ] as const;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {rows.map(({ label, value }) => (
        <article key={label} className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-card-foreground">{label}</h3>
            <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-secondary-foreground">
              {value?.status ?? "no market"}
            </span>
          </div>
          <dl className="mt-3 space-y-1.5">
            <Field label="Condition" value={value ? shorten(value.conditionId) : "—"} />
            <Field label="PTB" value={value?.ptb != null ? usd(value.ptb) : "—"} />
            <Field label="Close" value={value?.closeAt ? time(value.closeAt) : "—"} />
            <Field
              label="Settlement"
              value={value?.settlementAt ? time(value.settlementAt) : "—"}
            />
          </dl>
          <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">
            {value?.question ?? "Discovery has not yet found an active official market."}
          </p>
        </article>
      ))}

      <article className="rounded-lg border border-border bg-card p-4 shadow-sm md:col-span-2">
        <h3 className="text-sm font-semibold text-card-foreground">Prices</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <PriceBlock
            title="Binance"
            price={market.binance?.price ?? null}
            latencyMs={market.binance?.latencyMs ?? null}
            at={market.binance?.observedAt ?? null}
          />
          <PriceBlock
            title="Chainlink"
            price={market.chainlink?.price ?? null}
            latencyMs={market.chainlink?.latencyMs ?? null}
            at={market.chainlink?.observedAt ?? null}
          />
        </div>
        <p className="mt-3 font-mono text-[11px] text-muted-foreground">
          market state v{market.version} · published {time(market.publishedAt)}
        </p>
      </article>
    </div>
  );
}

function PriceBlock({
  title,
  price,
  latencyMs,
  at,
}: {
  title: string;
  price: number | null;
  latencyMs: number | null;
  at: string | null;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="font-mono text-xl text-foreground">{price != null ? usd(price) : "—"}</p>
      <p className="font-mono text-[11px] text-muted-foreground">
        {latencyMs != null ? `${latencyMs} ms` : "no latency"} ·{" "}
        {at ? time(at) : "awaiting first sample"}
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-foreground">{value}</dd>
    </div>
  );
}

function usd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function shorten(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
