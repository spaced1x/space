import type { HealthReport } from "../../core/health/types";
import type { RuntimeState } from "../../core/state/store";
import { StatusDot, stateLabel } from "./status-dot";

// Permanent left-side panel. Read-only projection of one engine snapshot —
// Mission Control never derives trading state of its own.
export function MissionControl({
  runtime,
  health,
}: {
  runtime: RuntimeState;
  health: HealthReport;
}) {
  return (
    <aside className="flex w-full shrink-0 flex-col gap-6 border-r border-sidebar-border bg-sidebar p-5 lg:h-screen lg:w-72 lg:overflow-y-auto">
      <div>
        <p className="font-mono text-xs tracking-[0.35em] text-primary">S P A C E</p>
        <p className="mt-1 text-xs text-muted-foreground">Mission Control</p>
      </div>

      <Section title="Engine">
        <Row label="Status" value={runtime.engineStatus} accent />
        <Row label="Mode" value={runtime.mode} />
        <Row label="5m window" value={runtime.windows.fiveMinute ? "enabled" : "disabled"} />
        <Row label="15m window" value={runtime.windows.fifteenMinute ? "enabled" : "disabled"} />
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
            <li key={entry.component} className="flex items-center gap-2 text-xs">
              <StatusDot state={entry.state} />
              <span className="flex-1 font-mono text-foreground">{entry.component}</span>
              <span className="text-muted-foreground">{stateLabel(entry.state)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <p className="mt-auto text-[11px] leading-relaxed text-muted-foreground">
        Operational status only. Market data, TWAP, PnL and positions attach here in later
        milestones; configuration always lives in the Operations Desk, never in this panel. Nothing
        here is simulated.
      </p>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${accent ? "text-primary" : "text-foreground"} text-right`}>
        {value}
      </span>
    </div>
  );
}