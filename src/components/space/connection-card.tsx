import type { ConnectionRecord, ConnectionState } from "../../core/runtime/connections.server";
import { StatusDot } from "./status-dot";

const TONE: Record<ConnectionState, string> = {
  CONNECTED: "text-ok",
  CONNECTING: "text-warn",
  WAITING: "text-warn",
  DEGRADED: "text-warn",
  DISCONNECTED: "text-fail",
  FAILED: "text-fail",
  NOT_CONFIGURED: "text-muted-foreground",
  NOT_STARTED: "text-muted-foreground",
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

function fmt(value: string | number | boolean | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  return value;
}

/**
 * One connection, as observed. Every field comes from the runtime registry;
 * nothing here is derived, defaulted or simulated.
 */
export function ConnectionCard({ record }: { record: ConnectionRecord }) {
  const detailEntries = Object.entries(record.details);

  return (
    <article className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot state={record.health} />
        <h3 className="text-card-title font-semibold text-card-foreground">{record.label}</h3>
        <span className={`ml-auto font-mono text-status uppercase ${TONE[record.state]}`}>
          {record.state.replace(/_/g, " ")}
        </span>
      </div>

      <p className="mt-2 text-label leading-relaxed text-muted-foreground">{record.reason}</p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
        <Field label="Environment" value={record.environment} />
        <Field label="Endpoint" value={record.endpoint ?? "—"} mono />
        <Field label="Latency" value={record.latencyMs === null ? "—" : `${record.latencyMs} ms`} />
        <Field label="Reconnects" value={String(record.reconnects)} />
        <Field label="Last success" value={ago(record.lastSuccessAt)} />
        <Field label="Last error" value={record.lastError ?? "none"} />
        {detailEntries.map(([key, value]) => (
          <Field key={key} label={humanize(key)} value={fmt(value)} />
        ))}
      </dl>

      {record.state !== "CONNECTED" && (
        <div className="mt-3 space-y-1 rounded-md bg-muted/60 p-3">
          <Line term="Action" detail={record.action ?? "None — monitor"} />
          <Line term="Trading" detail={record.blocksTrading ? "Blocked" : "Not blocked"} />
          <Line term="Recovery" detail={record.recovery} />
        </div>
      )}
    </article>
  );
}

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-label text-muted-foreground">{label}</dt>
      <dd className={`truncate text-value text-foreground ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

function Line({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="flex flex-wrap gap-x-3 text-label">
      <dt className="w-20 shrink-0 text-muted-foreground">{term}</dt>
      <dd className="flex-1 text-foreground">{detail}</dd>
    </div>
  );
}