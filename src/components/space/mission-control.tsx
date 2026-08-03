import type { HealthReport } from "../../core/health/types";
import type { ExecutionSnapshot } from "../../core/execution/types";
import type { MarketState } from "../../core/market/types";
import type { RuntimeState } from "../../core/state/store";
import type { StrategySnapshot } from "../../core/strategy/types";
import { StatusDot, stateLabel } from "./status-dot";
import { WorkspaceNav } from "./workspace-nav";

// Permanent left-side panel. Read-only projection of one engine snapshot —
// Mission Control never derives trading state of its own.
export function MissionControl({
  runtime,
  health,
  market,
  strategy,
  execution,
  environment,
}: {
  runtime: RuntimeState;
  health: HealthReport;
  market: MarketState;
  strategy: StrategySnapshot;
  execution: ExecutionSnapshot;
  environment: { code: string; label: string; live: boolean };
}) {
  return (
    <aside className="flex w-full shrink-0 flex-col gap-6 border-r border-sidebar-border bg-sidebar p-5 lg:sticky lg:top-0 lg:h-screen lg:w-80 lg:overflow-y-auto">
      <div>
        <p className="font-mono text-heading font-semibold tracking-[0.35em] text-primary">
          S P A C E
        </p>
        <p className="mt-1 text-label text-muted-foreground">Mission Control</p>
        {/* The active environment is never implied — it is always stated, and
            carries the environment identity colour: V1 blue, V2 red. */}
        <div className="mt-3 flex flex-wrap gap-2">
          <EnvironmentBadge environment={environment} />
          <LifecycleBadge lifecycle={runtime.lifecycle} emergencyStop={runtime.emergencyStop} />
        </div>
      </div>

      <WorkspaceNav />

      <Section title="Operating cockpit">
        <Row label="Trading mode" value={runtime.mode === "MANUAL" ? "MANUAL" : "STRATEGY"} accent />
        <Row label="Engine" value={environment.live ? "LIVE" : "PAPER"} />
        <Row label="Environment" value={environment.code} />
        <Row label="Lifecycle" value={runtime.lifecycle} />
      </Section>

      <Section title="Market">
        <Row
          label="BTC (Binance)"
          value={market.binance ? market.binance.price.toFixed(2) : "—"}
          accent
        />
        <Row label="BTC (Chainlink)" value={market.chainlink ? market.chainlink.price.toFixed(2) : "—"} />
        <Row
          label="Settlement source"
          value={market.settlement ? market.settlement.providerLabel : "no provider price"}
        />
        <Row
          label="Settlement price"
          value={market.settlement ? market.settlement.price.toFixed(2) : "—"}
        />
        <Row label="5m market" value={market.markets.FIVE_MINUTE?.status ?? "none"} />
        <Row label="15m market" value={market.markets.FIFTEEN_MINUTE?.status ?? "none"} />
        <Row label="State ver." value={`v${market.version}`} />
      </Section>

      <Section title="Strategy">
        <Row label="Market" value={strategy.market.horizon ?? "—"} accent />
        <Row label="PTB" value={strategy.market.ptb?.toFixed(2) ?? "—"} />
        <Row label="Settlement TWAP" value={strategy.twap.value?.toFixed(2) ?? "—"} />
        <Row label="Direction" value={strategy.prediction.direction ?? "—"} />
        <Row label="Active window" value={strategy.activeWindowId?.split(":").pop() ?? "none"} />
        <Row
          label="Frozen trigger"
          value={strategy.prediction.frozenTrigger?.toFixed(2) ?? "—"}
        />
        <Row label="Buffer" value={strategy.prediction.buffer?.toString() ?? "—"} />
        <Row
          label="Quota left"
          value={`${strategy.quota.remaining}/${strategy.quota.tradesPerMarket}`}
        />
      </Section>

      <Section title="Execution">
        <Row label="Order mode" value={execution.config.mode} accent />
        <Row label="Wallet" value={execution.wallet.ready ? "ready" : "not ready"} />
        <Row label="Venue" value={execution.venue.ready ? "connected" : "offline"} />
        <Row label="Active orders" value={String(execution.counts.active)} />
        <Row label="Pending" value={String(execution.counts.pending)} />
        <Row label="Filled" value={String(execution.counts.filled)} />
        <Row label="Open positions" value={String(execution.counts.positions)} />
        <Row label="Risk" value={execution.lastRisk?.code ?? "—"} />
      </Section>

      <Section title="Session">
        <Row label="Started" value={new Date(runtime.sessionStartedAt).toLocaleTimeString()} />
        <Row label="Last change" value={new Date(runtime.lastTransitionAt).toLocaleTimeString()} />
        <Row label="Reason" value={runtime.lastTransitionReason} />
        <Row label="State ver." value={`#${runtime.version}`} />
      </Section>

      <Section title="Dependencies">
        <ul className="space-y-1.5">
          {health.components.map((entry) => (
            <li key={entry.component} className="flex items-center gap-2 text-status">
              <StatusDot state={entry.state} />
              <span className="flex-1 font-mono text-foreground">{entry.component}</span>
              <span className="text-muted-foreground">{stateLabel(entry.state)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <p className="mt-auto text-label leading-relaxed text-muted-foreground">
        Operational status only. PnL and statistics attach here in a later milestone;
        configuration always lives in the Operations Desk, never in this panel. Nothing here is
        simulated.
      </p>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-status font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-label">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${accent ? "text-primary" : "text-foreground"} text-right`}>
        {value}
      </span>
    </div>
  );
}

function EnvironmentBadge({
  environment,
}: {
  environment: { code: string; label: string; live: boolean };
}) {
  return (
    <span
      className={`inline-flex rounded-md border px-2 py-1 font-mono text-status font-semibold uppercase ${
        environment.live
          ? "border-env-v2 bg-env-v2-surface text-env-v2"
          : "border-env-v1 bg-env-v1-surface text-env-v1"
      }`}
    >
      {environment.label}
    </span>
  );
}

function LifecycleBadge({
  lifecycle,
  emergencyStop,
}: {
  lifecycle: string;
  emergencyStop: boolean;
}) {
  const tone = emergencyStop
    ? "border-fail bg-fail/10 text-fail"
    : lifecycle === "RUNNING"
      ? "border-ok bg-ok/10 text-ok"
      : lifecycle === "FAILED" || lifecycle === "STOPPED"
        ? "border-warn bg-warn/10 text-warn"
        : "border-primary bg-primary/10 text-primary";
  return (
    <span className={`inline-flex rounded-md border px-2 py-1 font-mono text-status font-semibold uppercase ${tone}`}>
      {emergencyStop ? "E-STOP" : lifecycle}
    </span>
  );
}
