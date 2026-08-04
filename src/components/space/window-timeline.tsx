import type { StrategySnapshot, WindowState } from "../../core/strategy/types";

// Strategy timeline: every window, every transition. This is the surface that
// Replay will render from persisted evidence in a later milestone.

const STATE_TONE: Record<WindowState, string> = {
  WAITING: "border-border text-muted-foreground",
  OPEN: "border-primary/40 text-primary",
  ACTIVE: "border-primary text-primary",
  TRIGGERED: "border-ok/50 text-ok",
  COMPLETED: "border-ok/50 text-ok",
  EXPIRED: "border-warn/50 text-warn",
  NO_TRIGGER: "border-warn/50 text-warn",
  QUOTA_EXHAUSTED: "border-border text-muted-foreground",
  WINDOW_DISABLED: "border-border text-muted-foreground",
};

export function WindowTimeline({ strategy }: { strategy: StrategySnapshot }) {
  if (strategy.windows.length === 0) {
    return (
      <p className="rounded-md border border-border bg-card p-3 font-mono text-xs text-muted-foreground">
        no execution windows planned — waiting for an active BTC market with a settlement time
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {strategy.windows.map((window) => (
        <article key={window.id} className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-sm font-semibold text-foreground">
              {window.seconds}s
            </span>
            <span
              className={`rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${STATE_TONE[window.state]}`}
            >
              {window.state}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              buffer {window.buffer}
            </span>
            {window.frozen && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {window.frozen.direction} · trigger {window.frozen.frozenTrigger.toFixed(2)} · open
                TWAP {window.frozen.openingTwap.toFixed(2)}
              </span>
            )}
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {new Date(window.opensAt).toLocaleTimeString()} →{" "}
              {new Date(window.expiresAt).toLocaleTimeString()}
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{window.reason}</p>
          <ol className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-muted-foreground">
            {window.timeline.map((entry, index) => (
              <li key={`${window.id}-${index}-${entry.at}-${entry.state}`}>
                {index > 0 && <span className="mr-2 text-border">↓</span>}
                {entry.state}
              </li>
            ))}
            {window.intentId && (
              <li>
                <span className="mr-2 text-border">↓</span>
                <span className="text-ok">EXECUTION_INTENT_CREATED</span>
              </li>
            )}
          </ol>
        </article>
      ))}
    </div>
  );
}

export function IntentList({ strategy }: { strategy: StrategySnapshot }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
      {strategy.intents.map((intent) => (
        <li
          key={intent.id}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 font-mono text-xs"
        >
          <span className="text-muted-foreground">
            {new Date(intent.createdAt).toLocaleTimeString()}
          </span>
          <span className="text-primary">{intent.direction}</span>
          <span className="text-foreground">{intent.windowSeconds}s</span>
          <span className="text-muted-foreground">
            twap {intent.settlementTwap.toFixed(2)} · trigger {intent.frozenTrigger.toFixed(2)} ·
            ptb {intent.ptb.toFixed(2)}
          </span>
          <span className="ml-auto text-muted-foreground">{intent.id}</span>
        </li>
      ))}
      {strategy.intents.length === 0 && (
        <li className="p-3 font-mono text-xs text-muted-foreground">
          no execution intents yet — intents are produced only when a frozen trigger is satisfied
        </li>
      )}
    </ul>
  );
}
