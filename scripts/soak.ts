/**
 * Accelerated soak harness.
 *
 * Boots the real runtime in this process — the same boot sequence PM2 runs —
 * then drives it hard on the real system clock while the production stability
 * instrumentation samples it. There is no simulated clock and no mocked
 * subsystem: a soak on a fake clock would prove nothing about timers, sockets
 * or handles. Acceleration comes from compressing task cadence and from
 * repeatedly forcing the lifecycle events that a 24h run would produce a
 * handful of times (reconnects, TWAP rollover, discovery rollover).
 *
 *   bun run soak                       # 3 minutes, the release-gate default
 *   bun run soak:accelerated           # drills enabled, 5 minutes
 *   SOAK_MINUTES=45 bun run soak       # long local run
 *
 * A real 24–48h VPS soak remains the operational acceptance step; this harness
 * is the automated, repeatable evidence that the runtime is leak-free.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { boot } from "../src/core/boot.server";
import {
  clobMarketFeedStatus,
  startClobMarketFeed,
  stopClobMarketFeed,
} from "../src/core/market/clob-ws.server";
import { discoveryStats, refreshMarkets } from "../src/core/market/discovery.server";
import {
  countRuntimeResources,
  measureStability,
  type StabilityCounts,
  type StabilityReport,
} from "../src/core/metrics/stability.server";
import { listConnections } from "../src/core/runtime/connections.server";
import {
  compressTaskIntervals,
  restoreTaskIntervals,
  schedulerStatus,
} from "../src/core/scheduler/scheduler.server";
import { shutdown } from "../src/core/shutdown.server";
import {
  rtdsSocketStats,
  startRtdsSocket,
  stopRtdsSocket,
} from "../src/core/twap/rtds-socket.server";
import { twapResources } from "../src/core/twap/service.server";
import {
  activeProviderId,
  listProviders,
  setActiveProvider,
} from "../src/core/twap/registry.server";
import {
  clearFailureScenario,
  registerFailureScenario,
  type FaultTarget,
} from "../src/core/validation/failure-simulation.server";

const ACCELERATED = process.env["SOAK_ACCELERATED"] === "1";
const MINUTES = Number(process.env["SOAK_MINUTES"] ?? (ACCELERATED ? 5 : 3));
const SAMPLE_MS = Number(process.env["SOAK_SAMPLE_MS"] ?? 15_000);
const COMPRESSION = Number(process.env["SOAK_COMPRESSION"] ?? 10);
const STORM_CYCLES = Number(process.env["SOAK_STORM_CYCLES"] ?? 6);
const OUT_DIR = "docs/releases/v1.0.0";

interface DrillResult {
  name: string;
  ran: boolean;
  detail: string;
  countsBefore: StabilityCounts;
  countsAfter: StabilityCounts;
  leaked: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function leakDelta(before: StabilityCounts, after: StabilityCounts): string[] {
  const findings: string[] = [];
  for (const key of Object.keys(before) as (keyof StabilityCounts)[]) {
    const delta = after[key] - before[key];
    if (delta > 0) findings.push(`${key} +${delta}`);
  }
  return findings;
}

async function drill(
  name: string,
  body: () => Promise<string>,
  results: DrillResult[],
): Promise<void> {
  const countsBefore = countRuntimeResources();
  let detail = "";
  let ran = true;
  try {
    detail = await body();
  } catch (error) {
    ran = false;
    detail = error instanceof Error ? error.message : String(error);
  }
  // Let asynchronous teardown settle before counting handles again.
  await sleep(2_000);
  const countsAfter = countRuntimeResources();
  const leaked = leakDelta(countsBefore, countsAfter);
  results.push({ name, ran, detail, countsBefore, countsAfter, leaked });
  console.log(
    `soak drill: ${name} — ${ran ? "ran" : "errored"} — ${detail}` +
      (leaked.length ? ` — LEAK ${leaked.join(", ")}` : " — no handle growth"),
  );
}

async function reconnectStorm(): Promise<string> {
  // Each cycle tears the sockets down, blocks reconnection with an injected
  // fault so the production backoff path runs, then clears the fault and lets
  // them recover. This is exactly the code path a venue outage takes.
  const targets: FaultTarget[] = ["rtds", "clob_market_ws", "binance"];
  // Counters live on the socket instance, so they must be harvested before the
  // socket is replaced; otherwise a clean restart hides the retries it made.
  let observedReconnects = 0;
  const harvest = () => {
    observedReconnects += rtdsSocketStats().reconnects + (clobMarketFeedStatus().reconnects ?? 0);
  };
  for (let cycle = 0; cycle < STORM_CYCLES; cycle += 1) {
    for (const target of targets) {
      registerFailureScenario({
        name: target,
        active: true,
        kind: "throw",
        errorMessage: `soak reconnect storm cycle ${cycle + 1}`,
      });
    }
    harvest();
    stopRtdsSocket();
    stopClobMarketFeed();
    startRtdsSocket();
    startClobMarketFeed();
    await sleep(1_500);
    for (const target of targets) clearFailureScenario(target);
    await sleep(1_500);
  }
  harvest();
  const registry = listConnections().reduce((sum, entry) => sum + entry.reconnects, 0);
  return `${STORM_CYCLES} cycles, ${observedReconnects} socket reconnect attempts, registry total ${registry}`;
}

async function twapRollover(): Promise<string> {
  const providers = listProviders().map((provider) => provider.id);
  const start = activeProviderId();
  const outcomes: string[] = [];
  for (const id of providers) {
    const result = await setActiveProvider(id);
    outcomes.push(`${id}:${result.ok ? "promoted" : "refused"}`);
    await sleep(1_000);
  }
  const back = await setActiveProvider(start);
  outcomes.push(`${start}:${back.ok ? "restored" : "refused"}`);
  const resources = twapResources();
  return `${outcomes.join(" ")} | services=${resources.services} rtdsSockets=${resources.rtdsSockets}`;
}

async function discoveryRollover(): Promise<string> {
  for (let i = 0; i < 3; i += 1) {
    await refreshMarkets();
    await sleep(1_000);
  }
  const stats = discoveryStats();
  return `3 refreshes | ${JSON.stringify(stats).slice(0, 200)}`;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(
    `soak: booting runtime for ${MINUTES} minute(s), sampling every ${SAMPLE_MS}ms` +
      (ACCELERATED ? `, accelerated (compression x${COMPRESSION})` : ""),
  );
  await boot();

  const drills: DrillResult[] = [];
  let compressed: { task: string; intervalMs: number }[] = [];

  if (ACCELERATED) {
    compressed = compressTaskIntervals(COMPRESSION);
    console.log(`soak: compressed ${compressed.length} scheduler tasks by x${COMPRESSION}`);
  }

  const reports: StabilityReport[] = [];
  const deadline = Date.now() + MINUTES * 60_000;
  let drillsStarted = false;

  while (Date.now() < deadline) {
    await sleep(Math.min(SAMPLE_MS, Math.max(0, deadline - Date.now())));
    const report = measureStability();
    reports.push(report);
    console.log(
      `soak: t+${Math.round(report.sample.uptimeSeconds)}s ` +
        `heap=${(report.sample.heapUsedBytes / 1024 / 1024).toFixed(1)}MB ` +
        `rss=${(report.sample.rssBytes / 1024 / 1024).toFixed(1)}MB ` +
        `timers=${report.counts.timers} sockets=${report.counts.sockets} ` +
        `verdict=${report.verdict.state}`,
    );

    // Drills run once, after the first sample has established a baseline.
    if (ACCELERATED && !drillsStarted) {
      drillsStarted = true;
      await drill("reconnect storm", reconnectStorm, drills);
      await drill("TWAP provider rollover", twapRollover, drills);
      await drill("market discovery rollover", discoveryRollover, drills);
    }
  }

  if (ACCELERATED) restoreTaskIntervals();

  const final = reports.at(-1) ?? measureStability();
  const scheduler = schedulerStatus();
  const drillLeaks = drills.flatMap((entry) => entry.leaked.map((l) => `${entry.name}: ${l}`));

  let worst = reports.reduce<StabilityReport["verdict"]["state"]>((acc, report) => {
    if (acc === "FAIL" || report.verdict.state === "FAIL") return "FAIL";
    if (acc === "WARN" || report.verdict.state === "WARN") return "WARN";
    return "OK";
  }, "OK");

  const findings = [...final.verdict.findings];
  if (drillLeaks.length) {
    findings.push(...drillLeaks.map((entry) => `handle growth after drill — ${entry}`));
    worst = "FAIL";
  }
  if (scheduler.duplicateRegistrations > 0) {
    findings.push(`scheduler duplicate registrations: ${scheduler.duplicateRegistrations}`);
    worst = "FAIL";
  }

  const record = {
    kind: ACCELERATED ? ("accelerated" as const) : ("steady" as const),
    startedAt,
    finishedAt: new Date().toISOString(),
    minutes: MINUTES,
    compression: ACCELERATED ? COMPRESSION : 1,
    compressedTasks: compressed,
    samples: reports.length,
    verdict: worst,
    findings,
    heapGrowthBytesPerHour: final.heapGrowthBytesPerHour,
    rssGrowthBytesPerHour: final.rssGrowthBytesPerHour,
    countDrift: final.countDrift,
    scheduler: final.scheduler,
    schedulerTasks: scheduler.tasks.map((task) => ({
      name: task.name,
      runs: task.runs,
      failures: task.failures,
      maxJitterMs: task.maxJitterMs,
      missedRuns: task.missedRuns,
      overlaps: task.overlaps,
    })),
    snapshots: final.snapshots,
    reconnects: final.reconnects,
    totalReconnects: final.totalReconnects,
    finalCounts: final.counts,
    finalSample: final.sample,
    drills,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const path = `${OUT_DIR}/soak-${record.kind}-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(record, null, 2));
  writeFileSync(`${OUT_DIR}/SOAK_RESULTS.md`, renderMarkdown(record));

  await shutdown("soak harness finished");

  console.log(`\nsoak verdict: ${worst}`);
  for (const finding of findings) console.log(`  - ${finding}`);
  console.log(`soak record: ${path}`);
  process.exit(worst === "FAIL" ? 1 : 0);
}

function mb(value: number | null): string {
  return value === null ? "not measurable yet" : `${(value / 1024 / 1024).toFixed(2)} MB`;
}

interface SoakRecord {
  kind: string;
  startedAt: string;
  finishedAt: string;
  minutes: number;
  compression: number;
  samples: number;
  verdict: string;
  findings: string[];
  heapGrowthBytesPerHour: number | null;
  rssGrowthBytesPerHour: number | null;
  countDrift: Partial<Record<keyof StabilityCounts, number>>;
  scheduler: StabilityReport["scheduler"];
  snapshots: StabilityReport["snapshots"];
  reconnects: StabilityReport["reconnects"];
  totalReconnects: number;
  finalCounts: StabilityCounts;
  finalSample: StabilityReport["sample"];
  drills: DrillResult[];
}

function renderMarkdown(record: SoakRecord): string {
  const rows = Object.entries(record.finalCounts)
    .map(
      ([key, value]) =>
        `| ${key} | ${value} | ${record.countDrift[key as keyof StabilityCounts] ?? 0} |`,
    )
    .join("\n");
  const drillRows = record.drills
    .map(
      (entry) =>
        `| ${entry.name} | ${entry.ran ? "ran" : "errored"} | ${entry.leaked.length ? entry.leaked.join(", ") : "none"} | ${entry.detail.replace(/\|/g, "/")} |`,
    )
    .join("\n");
  return `# SPACE v1.0 — Accelerated Soak Results

Generated by \`bun run soak:accelerated\`. Every number below is measured by the
production stability instrumentation inside the booted runtime; nothing is
estimated and no clock is simulated.

- Verdict: **${record.verdict}**
- Kind: ${record.kind} (scheduler compression x${record.compression})
- Window: ${record.startedAt} → ${record.finishedAt} (${record.minutes} minutes, ${record.samples} samples)

${
  record.minutes < 10
    ? "> Growth figures are per-hour extrapolations from a " +
      `${record.minutes}-minute window, so they are dominated by GC timing noise. ` +
      "Handle drift and the drill results are the load-bearing evidence at this duration.\n"
    : ""
}
## Memory and CPU

| Metric | Value |
| --- | --- |
| Heap growth / hour | ${mb(record.heapGrowthBytesPerHour)} |
| RSS growth / hour | ${mb(record.rssGrowthBytesPerHour)} |
| CPU (user / system) | ${record.finalSample.cpuUserSeconds}s / ${record.finalSample.cpuSystemSeconds}s over ${record.finalSample.uptimeSeconds}s uptime |
| Final heap / RSS | ${(record.finalSample.heapUsedBytes / 1024 / 1024).toFixed(1)} MB / ${(record.finalSample.rssBytes / 1024 / 1024).toFixed(1)} MB |
| Snapshots generated | ${record.snapshots.generated} (no dashboard client attached during the harness) |
| Snapshot p50 / p95 | ${record.snapshots.p50DurationMs ?? "-"} ms / ${record.snapshots.p95DurationMs ?? "-"} ms |

## Handle counts (final vs first sample)

| Resource | Final | Drift |
| --- | --- | --- |
${rows}

## Scheduler

| Metric | Value |
| --- | --- |
| Ticks | ${record.scheduler.ticks} |
| Max tick drift | ${record.scheduler.maxTickDriftMs ?? "-"} ms |
| Max jitter | ${record.scheduler.maxJitterMs ?? "-"} ms |
| Overlaps | ${record.scheduler.overlaps} |
| Missed runs | ${record.scheduler.missedRuns} (expected under x${record.compression} compression) |
| Duplicate registrations | ${record.scheduler.duplicateRegistrations} |

## Reconnects

Total reconnects observed: ${record.totalReconnects}

${record.reconnects.map((entry) => `- ${entry.connection}: ${entry.reconnects} reconnects, ${entry.disconnects} disconnects`).join("\n") || "- none"}

## Drills

| Drill | Outcome | Handle growth | Detail |
| --- | --- | --- | --- |
${drillRows || "| none | - | - | drills run only with soak:accelerated |"}

## Findings

${record.findings.map((finding) => `- ${finding}`).join("\n") || "- none"}
`;
}

main().catch((error) => {
  console.error("soak harness failed:", error);
  process.exit(1);
});
