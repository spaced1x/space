import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { ConsoleShell, Panel } from "../components/space/console-shell";
import { Button } from "../components/ui/button";
import { getSystemInformation } from "../lib/settings.functions";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — SPACE" },
      {
        name: "description",
        content:
          "SPACE system settings: theme, operator timezone, database location, backup and restore procedure, version and environment information.",
      },
      { property: "og:title", content: "Settings — SPACE" },
      {
        property: "og:description",
        content: "Theme, timezone, database, backup/restore and environment information.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Settings,
});

function Settings() {
  const fetchInfo = useServerFn(getSystemInformation);
  const info = useQuery({
    queryKey: ["system-information"],
    queryFn: () => fetchInfo(),
    refetchInterval: 30_000,
  });

  const [dark, setDark] = useState(false);
  const [timezone, setTimezone] = useState("—");

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown");
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    window.localStorage.setItem("space-theme", next ? "dark" : "light");
    setDark(next);
  };

  const exportSnapshot = () => {
    if (!info.data) return;
    const blob = new Blob([JSON.stringify(info.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `space-system-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const details = (info.data?.database.details ?? {}) as Record<string, unknown>;

  return (
    <ConsoleShell
      title="Settings"
      subtitle="System-level preferences and environment facts. Trading configuration lives in the Operations Desk; secrets live only in .env."
    >
      <Panel title="Appearance">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4">
          <p className="font-mono text-xs text-muted-foreground">
            theme · {dark ? "dark" : "light (SPACE default)"}
          </p>
          <Button size="sm" variant="outline" onClick={toggleTheme}>
            Switch to {dark ? "light" : "dark"}
          </Button>
        </div>
      </Panel>

      <Panel title="Timezone">
        <Row label="Operator browser timezone" value={timezone} />
        <Row label="Engine clock" value="UTC — every persisted timestamp is ISO-8601 UTC" />
      </Panel>

      <Panel title="Database">
        <Row label="Engine" value={String(details["engine"] ?? "sqlite")} />
        <Row label="Journal mode" value={String(details["journalMode"] ?? "WAL")} />
        <Row label="Path" value={String(details["path"] ?? info.data?.environment.dbPath ?? "—")} />
        <Row label="Schema version" value={String(details["schemaVersion"] ?? "—")} />
        <Row label="Size (bytes)" value={String(details["sizeBytes"] ?? "—")} />
        <Row label="Status" value={info.data ? `${info.data.database.state} — ${info.data.database.message}` : "…"} />
      </Panel>

      <Panel title="Backup, export and restore">
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            SPACE is portable by clone → restore → run. Stop the process, copy the SQLite file
            (including <span className="font-mono">-wal</span> and{" "}
            <span className="font-mono">-shm</span> siblings) plus your <span className="font-mono">.env</span>,
            then start SPACE on the new host. No cloud service is involved.
          </p>
          <Button size="sm" variant="outline" onClick={exportSnapshot} disabled={!info.data}>
            Export system information (JSON)
          </Button>
        </div>
      </Panel>

      <Panel title="Environment">
        <Row label="SPACE environment" value={info.data?.environment.space ?? "—"} />
        <Row label="Node environment" value={info.data?.environment.node ?? "—"} />
        <Row label="Runtime" value={info.data?.environment.runtimeVersion ?? "—"} />
        <Row label="Port" value={String(info.data?.environment.port ?? "—")} />
        <Row label="Log level" value={info.data?.environment.logLevel ?? "—"} />
        <Row label="Log directory" value={info.data?.environment.logDir ?? "—"} />
        <Row
          label="Secrets missing for ARMED"
          value={
            info.data
              ? info.data.readiness.missingForArmed.length
                ? info.data.readiness.missingForArmed.join(", ")
                : "none"
              : "—"
          }
        />
      </Panel>
    </ConsoleShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border py-2 text-xs last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}