import type { HealthReport } from "../../core/health/types";
import type { ConnectionRecord } from "../../core/runtime/connections.server";
import type { RuntimeState } from "../../core/state/store";

// One glance: the nine facts an operator needs before anything else. Every cell
// is derived from live runtime state; a cell with no data reads WAITING.
export function SummaryRow({
  environment,
  runtime,
  health,
  connections,
}: {
  environment: { code: string; label: string; live: boolean };
  runtime: RuntimeState;
  health: HealthReport;
  connections: ConnectionRecord[];
}) {
  const byId = new Map(connections.map((record) => [record.id, record]));
  const twap = byId.get("twap_provider");
  const market = byId.get("market_discovery");
  const clob = byId.get("clob");

  const component = (name: string) =>
    health.components.find((entry) => entry.component === name)?.state ?? "NOT_INITIALIZED";

  const scored = health.components.filter((entry) => entry.state !== "NOT_INITIALIZED");
  const healthy = scored.filter((entry) => entry.state === "OK" || entry.state === "DISABLED");
  const healthPercent = scored.length
    ? `${Math.round((healthy.length / scored.length) * 100)}%`
    : "WAITING";

  const tradingBlockers = connections.filter((record) => record.blocksTrading);
  const trading =
    runtime.lifecycle === "RUNNING"
      ? tradingBlockers.length
        ? `BLOCKED BY ${tradingBlockers[0]!.label.toUpperCase()}`
        : "RUNNING"
      : market?.state === "CONNECTED"
        ? `${runtime.lifecycle} — NOT RUNNING`
        : "WAITING FOR MARKET";

  const cells: Array<{ label: string; value: string; tone?: "accent" | "ok" | "warn" }> = [
    { label: "Environment", value: environment.label, tone: environment.live ? "warn" : "accent" },
    { label: "Engine", value: environment.live ? "LIVE" : "PAPER" },
    { label: "Lifecycle", value: runtime.lifecycle },
    { label: "TWAP", value: twap ? stateWord(twap.state) : "WAITING" },
    { label: "Market", value: market ? stateWord(market.state) : "WAITING" },
    { label: "Strategy", value: readiness(component("strategy")) },
    { label: "Risk", value: readiness(component("risk")) },
    { label: "Execution", value: clob ? stateWord(clob.state) : readiness(component("execution")) },
    { label: "Health", value: healthPercent },
    { label: "Trading", value: trading, tone: runtime.lifecycle === "RUNNING" ? "ok" : "warn" },
  ];

  return (
    <section className="rounded-lg border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <span className="font-mono text-section-title font-semibold tracking-[0.3em] text-primary">
          SPACE
        </span>
        {cells.map((cell) => (
          <div key={cell.label} className="min-w-0">
            <p className="text-label uppercase tracking-wide text-muted-foreground">{cell.label}</p>
            <p
              className={`font-mono text-value font-semibold ${
                cell.tone === "accent"
                  ? "text-primary"
                  : cell.tone === "ok"
                    ? "text-ok"
                    : cell.tone === "warn"
                      ? "text-warn"
                      : "text-foreground"
              }`}
            >
              {cell.value}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function stateWord(state: string): string {
  return state.replace(/_/g, " ");
}

function readiness(state: string): string {
  if (state === "OK") return "READY";
  if (state === "DISABLED") return "OFF";
  if (state === "NOT_INITIALIZED") return "WAITING";
  return state;
}