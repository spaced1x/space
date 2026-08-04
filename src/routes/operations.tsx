import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ConsoleShell, Panel } from "../components/space/console-shell";
import { CommandDeck } from "../components/space/command-deck";
import { Button } from "../components/ui/button";
import type { OperationsConfig } from "../core/config/operations";
import type { Command } from "../core/bus/commands";
import { getOperations, updateOperations } from "../lib/operations.functions";
import { sendCommand } from "../lib/system.functions";
import { useRuntimeSnapshot } from "../lib/use-runtime-snapshot";
import { AsyncPanel } from "../components/space/async-panel";

export const Route = createFileRoute("/operations")({
  head: () => ({
    meta: [
      { title: "Operations Desk — SPACE" },
      {
        name: "description",
        content:
          "Configure SPACE execution windows, buffers, trade size, quota, retries and order fallback. Changes apply to the next market, never to a market in flight.",
      },
      { property: "og:title", content: "Operations Desk — SPACE" },
      {
        property: "og:description",
        content: "The single configuration host for windows, sizing, retries and order mode.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OperationsDesk,
});

const ORDER_MODES = ["LIMIT_ONLY", "MARKET_ONLY", "LIMIT_THEN_MARKET"] as const;

function OperationsDesk() {
  const queryClient = useQueryClient();
  const fetchOperations = useServerFn(getOperations);
  const stage = useServerFn(updateOperations);
  const dispatch = useServerFn(sendCommand);
  const [draft, setDraft] = useState<OperationsConfig | null>(null);

  const snapshot = useRuntimeSnapshot();

  const command = useMutation({
    mutationFn: (input: Command) => dispatch({ data: input }),
    onSuccess: (verdict) => {
      if (verdict.status === "ACCEPTED") toast.success(`${verdict.command}: ${verdict.reason}`);
      else toast.error(`${verdict.command} rejected — ${verdict.reason}`);
      void queryClient.invalidateQueries({ queryKey: ["system-snapshot"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const operations = useQuery({
    queryKey: ["operations"],
    queryFn: () => fetchOperations(),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (operations.data && !draft) setDraft(operations.data.staged);
  }, [operations.data, draft]);

  const save = useMutation({
    mutationFn: (config: OperationsConfig) =>
      stage({
        data: {
          strategyEnabled: config.strategyEnabled,
          manualEnabled: config.manualEnabled,
          dailyTradingEnabled: config.dailyTradingEnabled,
          markets: config.markets,
          windows: config.windows,
          tradesPerMarket: config.tradesPerMarket,
          maxPositions: config.maxPositions,
          orderMode: config.orderMode,
          retryCount: config.retryCount,
          retryDelayMs: config.retryDelayMs,
          limitTimeoutMs: config.limitTimeoutMs,
        },
      }),
    onSuccess: (result) => {
      toast.success(result.pending ? "Staged — applies to the next market" : "Configuration saved");
      setDraft(result.staged);
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const patch = (next: Partial<OperationsConfig>) =>
    setDraft((current) => (current ? { ...current, ...next } : current));

  return (
    <ConsoleShell
      title="Operations Desk"
      subtitle="The one place operational settings live. Secrets stay in .env; everything here is stored in SPACE and promoted to the engine when the next market is discovered."
    >
      {!draft || !operations.data ? (
        <AsyncPanel
          label="the operations configuration document"
          data={operations.data && draft ? draft : undefined}
          error={(operations.error as Error | null) ?? null}
          action="The configuration lives in SPACE's database — check Diagnostics for the database card, then retry. SPACE keeps polling automatically."
        >
          {() => null}
        </AsyncPanel>
      ) : (
        <>
          {snapshot.data && (
            <Panel title="Engine" hint="ARMED is only ever reached by an explicit operator command">
              <CommandDeck
                runtime={snapshot.data.runtime}
                pending={command.isPending}
                onCommand={(input) => command.mutate(input)}
              />
            </Panel>
          )}

          <Panel
            title="Configuration version"
            hint={`staged v${draft.version} · active v${operations.data.active.version}`}
          >
            <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
              {operations.data.pending
                ? "Staged changes are waiting. They apply the moment a new market is discovered — a market already in flight keeps the configuration it started with."
                : "Staged and active configuration match. The engine is trading exactly what is shown below."}
            </div>
          </Panel>

          <Panel title="Switches">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Toggle
                label="Strategy auto-execution"
                value={draft.strategyEnabled}
                onChange={(value) => patch({ strategyEnabled: value })}
              />
              <Toggle
                label="Manual trading"
                value={draft.manualEnabled}
                onChange={(value) => patch({ manualEnabled: value })}
              />
              <Toggle
                label="Daily trading"
                value={draft.dailyTradingEnabled}
                onChange={(value) => patch({ dailyTradingEnabled: value })}
              />
              <Toggle
                label="BTC 5 minute market"
                value={draft.markets.fiveMinute}
                onChange={(value) => patch({ markets: { ...draft.markets, fiveMinute: value } })}
              />
              <Toggle
                label="BTC 15 minute market"
                value={draft.markets.fifteenMinute}
                onChange={(value) => patch({ markets: { ...draft.markets, fifteenMinute: value } })}
              />
            </div>
          </Panel>

          <Panel title="Execution windows" hint="quota is consumed 15s → 10s → 7s → 5s → 3s">
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <table className="w-full text-left font-mono text-[11px]">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="p-2 font-normal">window</th>
                    <th className="p-2 font-normal">enabled</th>
                    <th className="p-2 font-normal">buffer</th>
                    <th className="p-2 font-normal">size</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.windows.map((window, index) => (
                    <tr key={window.seconds} className="border-t border-border">
                      <td className="p-2 text-foreground">{window.seconds}s</td>
                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={window.enabled}
                          onChange={(event) => {
                            const windows = [...draft.windows];
                            windows[index] = { ...window, enabled: event.target.checked };
                            patch({ windows });
                          }}
                        />
                      </td>
                      <td className="p-2">
                        <NumberInput
                          value={window.buffer}
                          step={0.5}
                          onChange={(value) => {
                            const windows = [...draft.windows];
                            windows[index] = { ...window, buffer: value };
                            patch({ windows });
                          }}
                        />
                      </td>
                      <td className="p-2">
                        <NumberInput
                          value={window.size}
                          step={1}
                          onChange={(value) => {
                            const windows = [...draft.windows];
                            windows[index] = { ...window, size: value };
                            patch({ windows });
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Orders and limits">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Field label="Trades per market">
                <NumberInput
                  value={draft.tradesPerMarket}
                  step={1}
                  onChange={(value) => patch({ tradesPerMarket: Math.round(value) })}
                />
              </Field>
              <Field label="Max open positions">
                <NumberInput
                  value={draft.maxPositions}
                  step={1}
                  onChange={(value) => patch({ maxPositions: Math.round(value) })}
                />
              </Field>
              <Field label="Order mode">
                <select
                  value={draft.orderMode}
                  onChange={(event) =>
                    patch({ orderMode: event.target.value as OperationsConfig["orderMode"] })
                  }
                  className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground"
                >
                  {ORDER_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Retry count">
                <NumberInput
                  value={draft.retryCount}
                  step={1}
                  onChange={(value) => patch({ retryCount: Math.round(value) })}
                />
              </Field>
              <Field label="Retry delay (ms)">
                <NumberInput
                  value={draft.retryDelayMs}
                  step={100}
                  onChange={(value) => patch({ retryDelayMs: Math.round(value) })}
                />
              </Field>
              <Field label="Limit timeout before fallback (ms)">
                <NumberInput
                  value={draft.limitTimeoutMs}
                  step={100}
                  onChange={(value) => patch({ limitTimeoutMs: Math.round(value) })}
                />
              </Field>
            </div>
          </Panel>

          <div className="flex gap-2">
            <Button disabled={save.isPending} onClick={() => save.mutate(draft)}>
              Save configuration
            </Button>
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => setDraft(operations.data.staged)}
            >
              Discard edits
            </Button>
          </div>
        </>
      )}
    </ConsoleShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1 rounded-lg border border-border bg-card p-3">
      <span className="block text-[11px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 text-xs text-foreground">
      <span>{label}</span>
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function NumberInput({
  value,
  step,
  onChange,
}: {
  value: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="number"
      step={step}
      value={value}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      }}
      className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground"
    />
  );
}
