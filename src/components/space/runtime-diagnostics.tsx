import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getSystemSnapshot } from "../../lib/system.functions";
import { Panel } from "./console-shell";

/**
 * Connection history, environment resolution and boot trace. All three read
 * the same runtime snapshot the dashboard uses, so diagnostics can never
 * disagree with Mission Control.
 */
export function RuntimeDiagnostics() {
  const fetchSnapshot = useServerFn(getSystemSnapshot);
  const query = useQuery({
    queryKey: ["system-snapshot"],
    queryFn: () => fetchSnapshot(),
    refetchInterval: 5000,
  });
  const data = query.data;
  if (!data) return null;

  return (
    <>
      <Panel title="Runtime process" hint="build, schema and uptime of this process">
        <div className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-3 xl:grid-cols-5">
          <Fact label="Build version" value={data.process.buildVersion} />
          <Fact label="Git commit" value={data.process.gitCommit} />
          <Fact
            label="Schema version"
            value={data.process.schemaVersion === null ? "—" : String(data.process.schemaVersion)}
          />
          <Fact label="Uptime" value={`${data.process.uptimeSeconds}s`} />
          <Fact
            label="Boot completed"
            value={
              data.boot.completedAt ? new Date(data.boot.completedAt).toLocaleTimeString() : "—"
            }
          />
        </div>
      </Panel>

      <Panel title="Boot sequence" hint="deterministic order, measured">
        <table className="w-full overflow-hidden rounded-md border border-border bg-card text-table">
          <thead className="bg-muted/60 text-label text-muted-foreground">
            <tr>
              <Th>Stage</Th>
              <Th>Status</Th>
              <Th>Duration</Th>
              <Th>Detail</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.boot.trace.map((stage) => (
              <tr key={stage.stage}>
                <Td mono>{stage.stage}</Td>
                <Td
                  className={
                    stage.error ? "text-fail" : stage.completedAt ? "text-ok" : "text-warn"
                  }
                >
                  {stage.error ? "FAILED" : stage.completedAt ? "OK" : "RUNNING"}
                </Td>
                <Td mono>{stage.durationMs === undefined ? "—" : `${stage.durationMs} ms`}</Td>
                <Td>{stage.error ?? stage.nextStage ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Environment resolution" hint={data.envResolution.environment}>
        <table className="w-full overflow-hidden rounded-md border border-border bg-card text-table">
          <thead className="bg-muted/60 text-label text-muted-foreground">
            <tr>
              <Th>Subsystem</Th>
              <Th>Target</Th>
              <Th>Environment</Th>
              <Th>Conformant</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.envResolution.rows.map((row) => (
              <tr key={row.subsystem}>
                <Td mono>{row.subsystem}</Td>
                <Td mono>{row.target}</Td>
                <Td>{row.environment}</Td>
                <Td className={row.conformant ? "text-ok" : "text-fail"}>
                  {row.conformant ? "YES" : "NO"}
                </Td>
                <Td>{row.note}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Runtime resource audit"
        hint="every START, STOP and SWITCH must prove the previous runtime was destroyed"
      >
        {data.resourceAudits.length === 0 ? (
          <p className="rounded-md border border-border bg-card p-4 text-label text-muted-foreground">
            No runtime transition has been audited yet. An audit is recorded the moment the runtime
            is started, stopped or switched.
          </p>
        ) : (
          <table className="w-full overflow-hidden rounded-md border border-border bg-card text-table">
            <thead className="bg-muted/60 text-label text-muted-foreground">
              <tr>
                <Th>Time</Th>
                <Th>Phase</Th>
                <Th>Expected</Th>
                <Th>Verdict</Th>
                <Th>Counts</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.resourceAudits.map((audit, index) => (
                <tr key={`${audit.at}-${index}`}>
                  <Td mono>{new Date(audit.at).toLocaleTimeString()}</Td>
                  <Td mono>{audit.phase}</Td>
                  <Td mono>{audit.expectation}</Td>
                  <Td className={audit.passed ? "text-ok" : "text-fail"}>
                    {audit.passed ? "PASS" : `FAIL — ${audit.failures.join("; ")}`}
                  </Td>
                  <Td mono>
                    {audit.checks
                      .map((entry) => `${entry.resource}=${entry.observed}`)
                      .join("  ")}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Connection history" hint="every state change since process start">
        {data.timeline.length === 0 ? (
          <p className="rounded-md border border-border bg-card p-4 text-label text-muted-foreground">
            No connection changes recorded yet. Entries appear the moment any subsystem changes
            state.
          </p>
        ) : (
          <table className="w-full overflow-hidden rounded-md border border-border bg-card text-table">
            <thead className="bg-muted/60 text-label text-muted-foreground">
              <tr>
                <Th>Time</Th>
                <Th>Subsystem</Th>
                <Th>State</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.timeline.map((entry, index) => (
                <tr key={`${entry.at}-${entry.id}-${index}`}>
                  <Td mono>{new Date(entry.at).toLocaleTimeString()}</Td>
                  <Td>{entry.label}</Td>
                  <Td mono>{entry.state.replace(/_/g, " ")}</Td>
                  <Td>{entry.message}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-label text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-value text-foreground" title={value}>
        {value}
      </p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left font-medium uppercase tracking-wide">{children}</th>;
}

function Td({
  children,
  mono,
  className,
}: {
  children: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2 align-top ${mono ? "font-mono" : ""} ${className ?? ""}`}>
      {children}
    </td>
  );
}