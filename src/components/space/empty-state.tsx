// One empty-state rule for the whole terminal: Status, Reason, Action,
// Trading Impact, Expected Recovery. Never "loading…", never a placeholder
// number — an operator must always know what SPACE is waiting for.
export function EmptyState({
  subject,
  status,
  reason,
  action,
  blocksTrading,
  recovery,
}: {
  subject: string;
  status: string;
  reason: string;
  action?: string | null;
  blocksTrading: boolean;
  recovery: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-card-title font-semibold text-card-foreground">{subject}</h3>
        <span className="font-mono text-status uppercase text-warn">{status}</span>
      </div>
      <dl className="mt-4 grid gap-2">
        <Line term="What" detail={subject} />
        <Line term="Why" detail={reason} />
        <Line term="Action" detail={action ?? "None — monitor"} />
        <Line term="Blocked" detail={blocksTrading ? "Trading is blocked" : "Trading is not blocked"} />
        <Line term="Recovery" detail={recovery} />
      </dl>
    </div>
  );
}

function Line({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="flex flex-wrap gap-x-3 text-label">
      <dt className="w-24 shrink-0 text-muted-foreground">{term}</dt>
      <dd className="flex-1 text-foreground">{detail}</dd>
    </div>
  );
}