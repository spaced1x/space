import type { FeedStats } from "../../core/feeds/types";
import type { TaskStatus } from "../../core/scheduler/scheduler.server";

// Scheduler + feed instrumentation. Diagnostics only — no configuration lives
// here; the Operations Desk owns every setting.
export function RuntimePanel({
  scheduler,
  feeds,
}: {
  scheduler: { running: boolean; tickMs: number; ticks: number; maxTickDriftMs: number; tasks: TaskStatus[] };
  feeds: { binance: FeedStats | null; chainlink: FeedStats | null };
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <article className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-card-foreground">Scheduler</h3>
          <span className="font-mono text-[11px] text-muted-foreground">
            {scheduler.running ? "running" : "stopped"} · {scheduler.tickMs}ms · drift{" "}
            {scheduler.maxTickDriftMs}ms
          </span>
        </div>
        <table className="mt-3 w-full text-left font-mono text-[11px]">
          <thead className="text-muted-foreground">
            <tr>
              <th className="pb-1 font-normal">task</th>
              <th className="pb-1 font-normal">every</th>
              <th className="pb-1 font-normal">runs</th>
              <th className="pb-1 font-normal">last</th>
              <th className="pb-1 text-right font-normal">fails</th>
            </tr>
          </thead>
          <tbody className="text-foreground">
            {scheduler.tasks.map((task) => (
              <tr key={task.name} className="border-t border-border">
                <td className="py-1 pr-2">{task.name}</td>
                <td className="py-1 pr-2">{task.intervalMs}ms</td>
                <td className="py-1 pr-2">{task.runs}</td>
                <td className="py-1 pr-2">
                  {task.lastDurationMs != null ? `${task.lastDurationMs}ms` : "—"}
                </td>
                <td
                  className={`py-1 text-right ${task.failures > 0 ? "text-fail" : "text-muted-foreground"}`}
                >
                  {task.failures}
                </td>
              </tr>
            ))}
            {scheduler.tasks.length === 0 && (
              <tr>
                <td colSpan={5} className="py-2 text-muted-foreground">
                  no tasks registered
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </article>

      <article className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-card-foreground">Feeds</h3>
        <div className="mt-3 space-y-3">
          <FeedRow name="Binance WS" stats={feeds.binance} />
          <FeedRow name="Chainlink RPC" stats={feeds.chainlink} />
        </div>
      </article>
    </div>
  );
}

function FeedRow({ name, stats }: { name: string; stats: FeedStats | null }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">{name}</p>
        <span
          className={`font-mono text-[10px] uppercase ${stats?.connected ? "text-ok" : "text-warn"}`}
        >
          {stats ? (stats.connected ? "connected" : "reconnecting") : "not started"}
        </span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        samples {stats?.samples ?? 0} · errors {stats?.errors ?? 0} · reconnects{" "}
        {stats?.reconnects ?? 0} · latency {stats?.latencyMs != null ? `${stats.latencyMs}ms` : "—"}
      </p>
      {stats?.lastError && <p className="mt-1 text-[11px] text-warn">{stats.lastError}</p>}
    </div>
  );
}