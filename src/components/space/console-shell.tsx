import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";

import { getSystemSnapshot } from "../../lib/system.functions";
import { MissionControl } from "./mission-control";

const NAV = [
  { to: "/", label: "Mission Control" },
  { to: "/operations", label: "Operations Desk" },
  { to: "/manual", label: "Manual Trading" },
  { to: "/stats", label: "Statistics" },
  { to: "/replay", label: "Replay" },
  { to: "/diagnostics", label: "Diagnostics" },
] as const;

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
        />
      ) : (
        <aside className="w-full shrink-0 border-r border-sidebar-border bg-sidebar p-5 lg:w-72">
          <p className="font-mono text-xs text-muted-foreground">connecting to SPACE runtime…</p>
        </aside>
      )}

      <main className="flex-1 space-y-8 p-6 lg:p-10">
        <ConsoleNav />
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </header>
        {children}
      </main>
    </div>
  );
}

export function ConsoleNav() {
  return (
    <nav className="flex flex-wrap gap-2">
      {NAV.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: item.to === "/" }}
          className="rounded-md border border-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[status=active]:border-primary/40 data-[status=active]:bg-accent data-[status=active]:text-accent-foreground"
        >
          {item.label}
        </Link>
      ))}
    </nav>
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
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          {title}
        </h2>
        {hint && <span className="font-mono text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}
