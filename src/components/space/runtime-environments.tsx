import type { RuntimeState } from "../../core/state/store";
import type { ConnectionRecord } from "../../core/runtime/connections.server";
import { otherEnvironment } from "../../core/runtime/peek.server";
import type { RuntimePeek } from "../../core/runtime/peek.server";
import type { RuntimeResourceAudit } from "../../core/runtime/resources.server";
import type { TwapServiceSnapshot } from "../../core/twap/service.server";
import { Button } from "../ui/button";
import { StatusDot } from "./status-dot";

// Both runtimes, always visible. The active one is live telemetry from this
// process; the inactive one is read from its own database. Neither panel ever
// shows a value that was not observed.

const LABELS: Record<string, { label: string; live: boolean }> = {
  V1_TESTNET: { label: "V1 TESTNET (Paper)", live: false },
  V2_MAINNET: { label: "V2 MAINNET (Live)", live: true },
};

function tone(live: boolean): string {
  return live
    ? "border-env-v2 bg-env-v2-surface text-env-v2"
    : "border-env-v1 bg-env-v1-surface text-env-v1";
}

export function RuntimeEnvironments({
  activeEnvironment,
  runtime,
  connections,
  twap,
  audit,
  inactive,
  pending,
  onStart,
  onStop,
}: {
  activeEnvironment: string;
  runtime: RuntimeState;
  connections: ConnectionRecord[];
  twap: TwapServiceSnapshot;
  audit: RuntimeResourceAudit | null;
  inactive: RuntimePeek | null;
  pending: boolean;
  onStart: (environment: string) => void;
  onStop: (environment: string) => void;
}) {
  const connected = connections.filter((record) => record.state === "CONNECTED").length;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <RuntimeCard
        environment={activeEnvironment}
        active
        lifecycle={runtime.lifecycle}
        rows={[
          ["Runtime", "ACTIVE in this process"],
          ["Lifecycle", runtime.lifecycle],
          ["Mode", runtime.mode],
          ["Emergency stop", runtime.emergencyStop ? `LATCHED — ${runtime.emergencyStopReason}` : "clear"],
          ["Connections", `${connected}/${connections.length} connected`],
          ["TWAP provider", twap.activeProviderId.toUpperCase()],
          ["Database", "attached to this environment"],
          ["Last change", new Date(runtime.lastTransitionAt).toLocaleTimeString()],
          ["Reason", runtime.lastTransitionReason],
          [
            "Resource audit",
            audit
              ? audit.passed
                ? `PASS (${audit.phase.toLowerCase()})`
                : `FAIL — ${audit.failures.join("; ")}`
              : "no transition audited yet",
          ],
        ]}
        pending={pending}
        onStart={() => onStart(activeEnvironment)}
        onStop={() => onStop(activeEnvironment)}
        canStop={runtime.lifecycle !== "STOPPED"}
      />

      {inactive ? (
        <RuntimeCard
          environment={inactive.environment}
          active={false}
          lifecycle="STOPPED"
          rows={[
            ["Runtime", "STOPPED — not running in this process"],
            ["Source", inactive.available ? "read-only peek into its database" : inactive.reason],
            ["Database", inactive.dbPath],
            [
              "Database size",
              inactive.sizeBytes === null ? "—" : `${(inactive.sizeBytes / 1024).toFixed(0)} KB`,
            ],
            ["Schema", inactive.schemaVersion === null ? "—" : `v${inactive.schemaVersion}`],
            ["Stamp", inactive.environmentStamp ?? "—"],
            ["Last mode", inactive.mode ?? "—"],
            [
              "Emergency stop",
              inactive.emergencyStop === null ? "—" : inactive.emergencyStop ? "LATCHED" : "clear",
            ],
            ["TWAP provider", inactive.twapProvider?.toUpperCase() ?? "—"],
            [
              "Orders / fills",
              inactive.counts.orders === null
                ? "—"
                : `${inactive.counts.orders} / ${inactive.counts.fills ?? 0}`,
            ],
            [
              "Last session",
              inactive.lastTransitionAt
                ? `${new Date(inactive.lastTransitionAt).toLocaleString()} — ${inactive.lastTransitionReason ?? ""}`
                : "never run on this host",
            ],
          ]}
          pending={pending}
          onStart={() => onStart(inactive.environment)}
          onStop={() => onStop(inactive.environment)}
          canStop={false}
        />
      ) : (
        <RuntimeCard
          environment={otherEnvironment(activeEnvironment as "V1_TESTNET" | "V2_MAINNET")}
          active={false}
          lifecycle="STOPPED"
          rows={[["Runtime", "STOPPED — peek not available yet"]]}
          pending={pending}
          onStart={() => {}}
          onStop={() => {}}
          canStop={false}
        />
      )}
    </div>
  );
}

function RuntimeCard({
  environment,
  active,
  lifecycle,
  rows,
  pending,
  onStart,
  onStop,
  canStop,
}: {
  environment: string;
  active: boolean;
  lifecycle: string;
  rows: [string, string][];
  pending: boolean;
  onStart: () => void;
  onStop: () => void;
  canStop: boolean;
}) {
  const identity = LABELS[environment] ?? { label: environment, live: false };
  return (
    <article
      className={`rounded-lg border bg-card p-4 shadow-sm ${
        active ? (identity.live ? "border-env-v2" : "border-env-v1") : "border-border"
      }`}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex rounded-md border px-2 py-1 font-mono text-status font-semibold uppercase ${tone(identity.live)}`}
        >
          {identity.label}
        </span>
        <span className="inline-flex items-center gap-2 font-mono text-status uppercase text-muted-foreground">
          <StatusDot state={active ? "OK" : "NOT_INITIALIZED"} />
          {active ? lifecycle : "STOPPED"}
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" disabled={pending || (active && canStop)} onClick={onStart}>
            {active ? "Start" : "Switch & start"}
          </Button>
          <Button size="sm" variant="secondary" disabled={pending || !canStop} onClick={onStop}>
            Stop
          </Button>
        </div>
      </header>

      <dl className="mt-4 grid gap-2">
        {rows.map(([term, value]) => (
          <div key={term} className="flex flex-wrap items-baseline gap-x-3 text-label">
            <dt className="w-36 shrink-0 text-muted-foreground">{term}</dt>
            <dd className="flex-1 break-words font-mono text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
