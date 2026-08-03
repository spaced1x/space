import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Panel } from "./console-shell";
import { StatusDot } from "./status-dot";
import { Button } from "../ui/button";
import {
  getConfigSnapshots,
  getReleaseArtifact,
  getRuntimeMetrics,
  getStartupValidation,
  getTelegramInbound,
  runReleaseGate,
} from "../../lib/system.functions";

export function ProductionPanel() {
  const fetchValidation = useServerFn(getStartupValidation);
  const fetchMetrics = useServerFn(getRuntimeMetrics);
  const fetchRelease = useServerFn(getReleaseArtifact);
  const fetchInbound = useServerFn(getTelegramInbound);
  const fetchSnapshots = useServerFn(getConfigSnapshots);
  const runRelease = useServerFn(runReleaseGate);

  const validation = useQuery({
    queryKey: ["startup-validation"],
    queryFn: () => fetchValidation(),
    refetchInterval: 5000,
  });

  const metrics = useQuery({
    queryKey: ["runtime-metrics"],
    queryFn: () => fetchMetrics(),
    refetchInterval: 5000,
  });

  const release = useQuery({
    queryKey: ["release-artifact"],
    queryFn: () => fetchRelease(),
    refetchInterval: 30000,
  });

  const inbound = useQuery({
    queryKey: ["telegram-inbound"],
    queryFn: () => fetchInbound(),
    refetchInterval: 5000,
  });

  const snapshots = useQuery({
    queryKey: ["config-snapshots"],
    queryFn: () => fetchSnapshots(),
    refetchInterval: 30000,
  });

  const releaseMutation = useMutation({
    mutationFn: () => runRelease({ data: { version: "v1.0.0" } }),
    onSuccess: () => release.refetch(),
  });

  return (
    <>
      <Panel title="Pre-ARM validation gate">
        {validation.data ? (
          <div className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <StatusDot state={validation.data.valid ? "OK" : "FAILED"} />
              <span className="font-mono text-sm text-card-foreground">
                {validation.data.valid ? "READY TO ARM" : "BLOCKED"}
              </span>
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {validation.data.at}
              </span>
            </div>
            {validation.data.blockers.length > 0 && (
              <ul className="space-y-1">
                {validation.data.blockers.map((blocker) => (
                  <li key={blocker} className="font-mono text-xs text-fail">
                    {blocker}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="font-mono text-sm text-muted-foreground">loading…</p>
        )}
      </Panel>

      <Panel title="Runtime metrics" hint="30s sampling">
        {metrics.data?.latest ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="RSS" value={`${(metrics.data.latest.memory_rss_mb ?? 0).toFixed(1)} MB`} />
            <Metric label="Heap" value={`${(metrics.data.latest.memory_heap_mb ?? 0).toFixed(1)} MB`} />
            <Metric label="DB size" value={`${((metrics.data.latest.db_size_bytes ?? 0) / 1024 / 1024).toFixed(2)} MB`} />
            <Metric label="Tick drift" value={`${metrics.data.latest.scheduler_drift_ms ?? 0} ms`} />
          </div>
        ) : (
          <p className="font-mono text-sm text-muted-foreground">no samples yet</p>
        )}
      </Panel>

      <Panel title="Release gate" hint={`${release.data ? "artifact frozen" : "no artifact"}`}>
        <div className="space-y-3">
          {release.data ? (
            <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <StatusDot state={release.data.gate_passed ? "OK" : "FAILED"} />
                <span className="font-mono text-sm text-card-foreground">
                  {release.data.version}
                </span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {release.data.deployed_at}
                </span>
              </div>
              <p className="mt-2 font-mono text-xs text-muted-foreground">
                {release.data.reason ?? "no summary"}
              </p>
            </div>
          ) : (
            <p className="font-mono text-sm text-muted-foreground">no release artifact generated</p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => releaseMutation.mutate()}
            disabled={releaseMutation.isPending}
          >
            {releaseMutation.isPending ? "generating…" : "Generate v1.0.0 artifact"}
          </Button>
        </div>
      </Panel>

      <Panel title="Telegram inbound" hint="operator command log">
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
          {inbound.data?.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 font-mono text-xs"
            >
              <span className="text-muted-foreground">
                {new Date(entry.created_at).toLocaleTimeString()}
              </span>
              <span className="text-primary truncate max-w-[200px]">{entry.text}</span>
              <span className="text-muted-foreground">{entry.username}</span>
            </li>
          ))}
          {(!inbound.data || inbound.data.length === 0) && (
            <li className="p-3 font-mono text-xs text-muted-foreground">no inbound commands</li>
          )}
        </ul>
      </Panel>

      <Panel title="Configuration snapshots" hint="ARM / mode changes">
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
          {snapshots.data?.map((snap) => (
            <li
              key={snap.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 font-mono text-xs"
            >
              <span className="text-muted-foreground">
                {new Date(snap.active_at).toLocaleTimeString()}
              </span>
              <span className="text-primary">{snap.reason}</span>
              <span className="text-muted-foreground">v{snap.version}</span>
            </li>
          ))}
          {(!snapshots.data || snapshots.data.length === 0) && (
            <li className="p-3 font-mono text-xs text-muted-foreground">no snapshots yet</li>
          )}
        </ul>
      </Panel>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm text-card-foreground">{value}</p>
    </div>
  );
}
