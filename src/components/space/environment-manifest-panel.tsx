import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Panel } from "./console-shell";
import { getEnvironmentManifest } from "../../lib/diagnostics.functions";

/**
 * The environment contract as the running process sees it. Values arrive
 * already masked from the server: a secret is only ever reported as present or
 * absent, never printed.
 */
export function EnvironmentManifestPanel() {
  const fetchManifest = useServerFn(getEnvironmentManifest);
  const query = useQuery({
    queryKey: ["environment-manifest"],
    queryFn: () => fetchManifest(),
    refetchInterval: 60_000,
  });
  const data = query.data;

  if (!data) {
    return (
      <Panel title="Environment manifest">
        <p className="text-label text-muted-foreground">Reading the environment contract…</p>
      </Panel>
    );
  }

  const groups = [...new Set(data.variables.map((entry) => entry.group))];
  const missingForArm = data.variables.filter((entry) => entry.requiredForArmed && !entry.set);

  return (
    <Panel
      title="Environment manifest"
      hint={`${data.variables.length} variables · ${missingForArm.length} missing before ARM`}
    >
      {data.unknown.length > 0 && (
        <p className="mb-3 rounded-md border border-warn/40 bg-warn/10 p-3 font-mono text-xs text-warn">
          ignored, not part of the contract: {data.unknown.join(", ")}
        </p>
      )}
      <div className="space-y-4">
        {groups.map((group) => (
          <section key={group}>
            <h3 className="mb-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
              {group}
            </h3>
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
              {data.variables
                .filter((entry) => entry.group === group)
                .map((entry) => (
                  <li key={entry.name} className="p-3 font-mono text-xs">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-primary">{entry.name}</span>
                      {entry.secret && (
                        <span className="rounded border border-border px-1 text-[10px] uppercase text-muted-foreground">
                          secret
                        </span>
                      )}
                      {entry.requiredForArmed && (
                        <span
                          className={`rounded border px-1 text-[10px] uppercase ${
                            entry.set ? "border-ok/40 text-ok" : "border-fail/40 text-fail"
                          }`}
                        >
                          {entry.set ? "present" : "required before ARM"}
                        </span>
                      )}
                      <span className="ml-auto text-muted-foreground">
                        {entry.set ? (entry.secret ? entry.value : entry.value) : "using default"}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {entry.description}
                    </p>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </Panel>
  );
}
