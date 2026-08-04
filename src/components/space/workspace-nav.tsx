import { Link } from "@tanstack/react-router";

export const WORKSPACES = [
  { to: "/", label: "Mission Control" },
  { to: "/operations", label: "Operations Desk" },
  { to: "/replay", label: "Replay" },
  { to: "/manual", label: "Manual Trading" },
  { to: "/stats", label: "Statistics" },
  { to: "/diagnostics", label: "Diagnostics" },
  { to: "/settings", label: "Settings" },
] as const;

/** Permanent sidebar navigation. Every operator function is its own workspace. */
export function WorkspaceNav() {
  return (
    <nav className="flex flex-col gap-1">
      {WORKSPACES.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: item.to === "/" }}
          className="rounded-md px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[status=active]:bg-accent data-[status=active]:text-accent-foreground"
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
