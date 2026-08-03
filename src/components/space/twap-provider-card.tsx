import type { TwapServiceSnapshot } from "../../core/twap/service.server";
import { EmptyState } from "./empty-state";
import { StatusDot } from "./status-dot";

function price(value: number | null): string {
  return value === null ? "—" : value.toFixed(4);
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

/**
 * The active TWAP provider and its standby peers. Every value is reported by
 * the runtime registry; nothing is invented when a provider is warming up.
 */
export function TwapProviderCard({ twap }: { twap: TwapServiceSnapshot }) {
  if (!twap.started) {
    return (
      <EmptyState
        subject="TWAP provider"
        status="Not started"
        reason="The TWAP service has not been started by the runtime yet"
        action="Start the runtime — the TWAP service boots during VALIDATING"
        blocksTrading
        recovery="Automatic — starts when the runtime lifecycle reaches VALIDATING"
      />
    );
  }

  const active = twap.active;

  return (
    <article className="rounded-lg border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot state={active?.state === "OK" ? "OK" : active?.state === "FAILED" ? "FAILED" : "DEGRADED"} />
        <h3 className="text-card-title font-semibold text-card-foreground">
          TWAP provider — {active?.label ?? twap.activeProviderId}
        </h3>
        <span className="ml-auto font-mono text-status uppercase text-muted-foreground">
          {active?.state.replace(/_/g, " ") ?? "unknown"}
        </span>
      </div>

      <p className="mt-2 text-body leading-relaxed text-muted-foreground">
        {active?.reason ?? "No active provider report available."}
      </p>

      <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="Active provider" value={active?.label ?? twap.activeProviderId} />
        <Field label="Settlement price" value={price(active?.latestPrice ?? null)} />
        <Field label="Latency" value={active?.latencyMs === null ? "—" : `${active.latencyMs} ms`} />
        <Field label="Samples" value={String(active?.samples ?? 0)} />
        <Field label="Published" value={String(twap.published)} />
        <Field label="Last publish" value={ago(twap.lastPublishedAt)} />
        <Field label="Window start" value={active?.windowStart ? new Date(active.windowStart).toLocaleTimeString() : "—"} />
        <Field label="Window end" value={active?.windowEnd ? new Date(active.windowEnd).toLocaleTimeString() : "—"} />
        <Field label="Standby providers" value={twap.providers.length <= 1 ? "none" : String(twap.providers.length - 1)} />
      </dl>

      {twap.providers.length > 1 && (
        <div className="mt-4 space-y-2">
          <h4 className="text-label font-semibold uppercase tracking-wide text-muted-foreground">Standby providers</h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {twap.providers
              .filter((provider) => provider.id !== twap.activeProviderId)
              .map((provider) => (
                <div
                  key={provider.id}
                  className="rounded-md border border-border bg-muted/40 p-3"
                >
                  <div className="flex items-center gap-2">
                    <StatusDot state={provider.state === "OK" ? "OK" : provider.state === "FAILED" ? "FAILED" : "DEGRADED"} />
                    <span className="font-medium text-foreground">{provider.label}</span>
                    <span className="ml-auto font-mono text-status uppercase">{provider.state.replace(/_/g, " ")}</span>
                  </div>
                  <p className="mt-1 text-status text-muted-foreground">{provider.reason}</p>
                </div>
              ))}
          </div>
        </div>
      )}
    </article>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-label text-muted-foreground">{label}</dt>
      <dd className="truncate text-value text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}
