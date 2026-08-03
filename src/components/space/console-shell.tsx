import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";

import { getSystemSnapshot } from "../../lib/system.functions";
import { MissionControl } from "./mission-control";
import { WorkspaceNav } from "./workspace-nav";

/**
 * The permanent operator terminal frame: Mission Control on the left, page
 * content on the right. Mission Control is strictly operational — every page
 * projects the same engine snapshot, so no two screens can disagree.
 */
export function ConsoleShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  const fetchSnapshot = useServerFn(getSystemSnapshot);
  const snapshot = useQuery({
    queryKey: ["system-snapshot"],
    queryFn: () => fetchSnapshot(),
    refetchInterval: 5000,
  });

  return (
    <div className="flex min-h-screen flex-col bg-background lg:flex-row">
      {snapshot.data ? (
        <MissionControl
          runtime={snapshot.data.runtime}
          health={snapshot.data.health}
          market={snapshot.data.engine.market}
          strategy={snapshot.data.engine.strategy}
          execution={snapshot.data.engine.execution}
          environment={snapshot.data.environment}
        />
      ) : (
        <aside className="w-full shrink-0 border-r border-sidebar-border bg-sidebar p-5 lg:w-72">
          <p className="font-mono text-heading font-semibold tracking-[0.35em] text-primary">
            S P A C E
          </p>
          <div className="mt-6">
            <WorkspaceNav />
          </div>
          <p className="mt-6 font-mono text-status leading-relaxed text-muted-foreground">
            Reading the runtime snapshot — the terminal only renders values the engine has
            actually reported.
          </p>
        </aside>
      )}

      <main className="flex-1 space-y-8 p-6 lg:p-10">
        <header className="space-y-1">
          <h1 className="text-page-title font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="text-label text-muted-foreground">{subtitle}</p>
        </header>
        {children}
      </main>
    </div>
  );
}

export function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-status font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          {title}
        </h2>
        {hint && <span className="font-mono text-status text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}
