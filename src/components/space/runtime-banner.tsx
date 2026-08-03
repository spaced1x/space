import type { ConnectionRecord } from "../../core/runtime/connections.server";
import type { RuntimeState } from "../../core/state/store";

/**
 * The permanent top-of-cockpit banner. It answers, in one line, the four
 * questions an operator must never have to infer: which environment is active,
 * whether real capital is at risk, what the engine lifecycle is, and whether
 * trading can happen right now.
 *
 * V1 testnet reads blue, V2 mainnet reads red. Colour is identity, not status —
 * component health is expressed by the words, never by the banner tint.
 */
export function RuntimeBanner({
  environment,
  runtime,
  connections,
}: {
  environment: { code: string; label: string; live: boolean };
  runtime: RuntimeState;
  connections: ConnectionRecord[];
}) {
  const blockers = connections.filter((record) => record.blocksTrading);
  const live = environment.live;

  const tradingLine = runtime.emergencyStop
    ? `Trading halted — emergency stop latched (${runtime.emergencyStopReason ?? "no reason recorded"})`
    : blockers.length
      ? `Trading blocked by ${blockers.map((record) => record.label).join(", ")}`
      : runtime.lifecycle === "RUNNING"
        ? "Trading enabled — the engine may submit orders"
        : `Trading disabled — engine is ${runtime.lifecycle}, not RUNNING`;

  return (
    <section
      className={`rounded-lg border-2 p-5 shadow-sm ${
        live ? "border-env-v2 bg-env-v2-surface" : "border-env-v1 bg-env-v1-surface"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <p
          className={`font-mono text-page-title font-bold tracking-[0.18em] ${
            live ? "text-env-v2" : "text-env-v1"
          }`}
        >
          {environment.label}
        </p>
        <Cell label="Capital" value={live ? "REAL FUNDS AT RISK" : "PAPER — NO REAL FUNDS"} />
        <Cell label="Engine" value={environment.live ? "LIVE" : "PAPER"} />
        <Cell label="Lifecycle" value={runtime.lifecycle} />
        <Cell label="Trading mode" value={runtime.mode} />
        <Cell label="Emergency stop" value={runtime.emergencyStop ? "LATCHED" : "CLEAR"} />
      </div>
      <p className="mt-4 text-body leading-relaxed text-foreground">{tradingLine}</p>
    </section>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-label uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-mono text-value font-semibold text-foreground">{value}</p>
    </div>
  );
}
