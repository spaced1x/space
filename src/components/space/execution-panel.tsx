import type { ExecutionSnapshot, OrderRecord } from "../../core/execution/types";

// Read-only projection of the execution engine snapshot. The dashboard never
// places, cancels or retries an order — it renders what the engine persisted.

function num(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? "—" : value.toFixed(digits);
}

function time(value: string | null): string {
  return value ? new Date(value).toLocaleTimeString() : "—";
}

const STATE_TONE: Record<string, string> = {
  FILLED: "text-ok",
  PARTIAL_FILL: "text-warn",
  LIMIT_SUBMITTED: "text-primary",
  MARKET_SUBMITTED: "text-primary",
  RISK_REJECTED: "text-fail",
  FAILED: "text-fail",
  CANCELLED: "text-muted-foreground",
  EXPIRED: "text-muted-foreground",
};

export function ExecutionPanel({ execution }: { execution: ExecutionSnapshot }) {
  const { counts, wallet, venue, config, lastRisk } = execution;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Card title="Order state">
        <Line label="Mode" value={config.mode} accent />
        <Line label="Active" value={String(counts.active)} />
        <Line label="Pending" value={String(counts.pending)} />
        <Line label="Filled" value={String(counts.filled)} />
        <Line label="Failed" value={String(counts.failed)} />
      </Card>

      <Card title="Positions">
        <Line label="Open" value={String(counts.positions)} accent />
        <Line label="Max" value={String(config.maxPositions)} />
        <Line label="Order size" value={String(config.size)} />
        <Line label="Intents seen" value={String(execution.intentsSeen)} />
      </Card>

      <Card title="Wallet">
        <Line label="Status" value={wallet.ready ? "READY" : "NOT READY"} accent />
        <Line label="Environment" value={wallet.environment} />
        <Line
          label="Address"
          value={wallet.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : "—"}
        />
        <Line label="API creds" value={wallet.hasApiCredentials ? "present" : "missing"} />
      </Card>

      <Card title="Risk / venue">
        <Line label="Last decision" value={lastRisk?.status ?? "—"} accent />
        <Line label="Code" value={lastRisk?.code ?? "—"} />
        <Line label="Rejections" value={String(counts.rejected)} />
        <Line label="Venue" value={venue.ready ? "CONNECTED" : "OFFLINE"} />
      </Card>
    </div>
  );
}

export function OrderTable({ orders }: { orders: OrderRecord[] }) {
  if (!orders.length) {
    return (
      <p className="rounded-md border border-border bg-card p-4 font-mono text-xs text-muted-foreground">
        no orders yet — every order originates from exactly one execution intent
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-card">
      <table className="w-full min-w-[720px] text-left font-mono text-xs">
        <thead className="border-b border-border text-[10px] uppercase tracking-widest text-muted-foreground">
          <tr>
            <th className="p-3">Intent</th>
            <th className="p-3">Dir</th>
            <th className="p-3">Kind</th>
            <th className="p-3">State</th>
            <th className="p-3">Price</th>
            <th className="p-3">Filled</th>
            <th className="p-3">Try</th>
            <th className="p-3">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {orders.slice(0, 20).map((order) => (
            <tr key={order.id}>
              <td className="p-3 text-muted-foreground">{order.intentId.slice(-12)}</td>
              <td className="p-3 text-foreground">{order.outcome}</td>
              <td className="p-3 text-muted-foreground">{order.kind}</td>
              <td className={`p-3 ${STATE_TONE[order.state] ?? "text-foreground"}`}>
                {order.state}
              </td>
              <td className="p-3 text-foreground">{num(order.limitPrice, 3)}</td>
              <td className="p-3 text-foreground">
                {num(order.filledSize, 2)}/{order.size}
              </td>
              <td className="p-3 text-muted-foreground">{order.attempt}</td>
              <td className="p-3 text-muted-foreground">{time(order.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PositionTable({ execution }: { execution: ExecutionSnapshot }) {
  const { positions } = execution;
  if (!positions.length) {
    return (
      <p className="rounded-md border border-border bg-card p-4 font-mono text-xs text-muted-foreground">
        no positions — positions are derived from immutable fills only
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-card">
      <table className="w-full min-w-[640px] text-left font-mono text-xs">
        <thead className="border-b border-border text-[10px] uppercase tracking-widest text-muted-foreground">
          <tr>
            <th className="p-3">Market</th>
            <th className="p-3">Outcome</th>
            <th className="p-3">Size</th>
            <th className="p-3">Avg price</th>
            <th className="p-3">Cost</th>
            <th className="p-3">Status</th>
            <th className="p-3">Last fill</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {positions.map((position) => (
            <tr key={`${position.conditionId}:${position.tokenId}`}>
              <td className="p-3 text-muted-foreground">{position.slug}</td>
              <td className="p-3 text-foreground">{position.outcome}</td>
              <td className="p-3 text-foreground">{num(position.size)}</td>
              <td className="p-3 text-foreground">{num(position.avgPrice, 3)}</td>
              <td className="p-3 text-muted-foreground">{num(position.cost)}</td>
              <td
                className={`p-3 ${position.status === "ACTIVE" ? "text-ok" : "text-muted-foreground"}`}
              >
                {position.status}
              </td>
              <td className="p-3 text-muted-foreground">{time(position.lastFillAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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