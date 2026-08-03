import type { DiscoveredMarket } from "../../core/market/types";
import { EmptyState } from "./empty-state";

function countdown(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "settled";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function price(value: number | null): string {
  return value === null ? "—" : value.toFixed(4);
}

/**
 * The market SPACE is currently pointed at. Every field is venue metadata that
 * was actually returned; unavailable fields read "—", never a stand-in value.
 */
export function TradingTargetCard({ market }: { market: DiscoveredMarket | null }) {
  if (!market) {
    return (
      <EmptyState
        subject="Current trading target"
        status="Waiting for market"
        reason="No official BTC up/down market is open right now"
        action="None — SPACE discovers the next BTC market automatically"
        blocksTrading
        recovery="Automatic — the next market is picked up within 20 seconds of opening"
      />
    );
  }

  return (
    <article className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-card-title font-semibold text-card-foreground">
          {market.question || market.slug}
        </h3>
        <span className="font-mono text-status uppercase text-primary">{market.horizon}</span>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="Market status" value={market.status} />
        <Field label="Settlement" value={market.settlementAt ? new Date(market.settlementAt).toLocaleTimeString() : "—"} />
        <Field label="Countdown" value={countdown(market.settlementAt)} accent />
        <Field label="Price to beat" value={market.ptb === null ? "—" : market.ptb.toFixed(2)} />
        <Field label="Probability (UP)" value={price(market.probability)} />
        <Field label="Best bid" value={price(market.bestBid)} />
        <Field label="Best ask" value={price(market.bestAsk)} />
        <Field label="Mid price" value={price(market.midPrice)} />
        <Field label="Spread" value={price(market.spread)} />
        <Field label="Minimum order size" value={market.minOrderSize === null ? "—" : String(market.minOrderSize)} />
        <Field label="Liquidity" value={money(market.liquidity)} />
        <Field label="Volume" value={money(market.volume)} />
        <Field label="Resolution source" value={market.resolutionSource ?? "official venue resolution"} />
        <Field label="Market ID" value={market.slug} mono />
        <Field label="Condition ID" value={market.conditionId} mono />
        <Field label="YES token" value={market.upTokenId ?? "—"} mono />
        <Field label="NO token" value={market.downTokenId ?? "—"} mono />
        <Field label="Discovered" value={new Date(market.discoveredAt).toLocaleTimeString()} />
      </dl>

      {market.bestBid === null && market.bestAsk === null && (
        <p className="mt-3 text-label text-muted-foreground">
          Waiting for book — the venue has not published bid/ask for this market yet.
        </p>
      )}
    </article>
  );
}

function Field({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-label text-muted-foreground">{label}</dt>
      <dd
        className={`truncate text-value ${accent ? "text-primary" : "text-foreground"} ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}