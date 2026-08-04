/**
 * Accelerated soak harness.
 *
 * Boots the real runtime in this process — the same boot sequence PM2 runs —
 * lets it live for a bounded period on the real system clock, and samples the
 * production stability instrumentation throughout. There is no simulated
 * clock and no mocked subsystem: a compressed soak that ran on a fake clock
 * would prove nothing about timers, sockets or handles.
 *
 *   bun run soak                 # 3 minutes, the release-gate default
 *   SOAK_MINUTES=45 bun run soak # long local run
 *
 * A real 24–48h VPS soak remains the operational acceptance step; this harness
 * is the automated, repeatable evidence that the runtime is leak-free.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { boot } from "../src/core/boot.server";
import { measureStability, type StabilityReport } from "../src/core/metrics/stability.server";
import { shutdown } from "../src/core/shutdown.server";

const MINUTES = Number(process.env["SOAK_MINUTES"] ?? 3);
const SAMPLE_MS = Number(process.env["SOAK_SAMPLE_MS"] ?? 15_000);
const OUT_DIR = "docs/releases/v1.0.0";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`soak: booting runtime for ${MINUTES} minute(s), sampling every ${SAMPLE_MS}ms`);
  await boot();

  const reports: StabilityReport[] = [];
  const deadline = Date.now() + MINUTES * 60_000;
  while (Date.now() < deadline) {
    await sleep(Math.min(SAMPLE_MS, Math.max(0, deadline - Date.now())));
    const report = measureStability();
    reports.push(report);
    console.log(
      `soak: t+${Math.round(report.sample.uptimeSeconds)}s ` +
        `heap=${(report.sample.heapUsedBytes / 1024 / 1024).toFixed(1)}MB ` +
        `timers=${report.counts.timers} sockets=${report.counts.sockets} ` +
        `verdict=${report.verdict.state}`,
    );
  }

  const final = reports.at(-1) ?? measureStability();
  const worst = reports.reduce<StabilityReport["verdict"]["state"]>((acc, report) => {
    if (acc === "FAIL" || report.verdict.state === "FAIL") return "FAIL";
    if (acc === "WARN" || report.verdict.state === "WARN") return "WARN";
    return "OK";
  }, "OK");

  const record = {
    kind: "accelerated" as const,
    startedAt,
    finishedAt: new Date().toISOString(),
    minutes: MINUTES,
    samples: reports.length,
    verdict: worst,
    findings: final.verdict.findings,
    heapGrowthBytesPerHour: final.heapGrowthBytesPerHour,
    rssGrowthBytesPerHour: final.rssGrowthBytesPerHour,
    countDrift: final.countDrift,
    scheduler: final.scheduler,
    snapshots: final.snapshots,
    totalReconnects: final.totalReconnects,
    finalCounts: final.counts,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const path = `${OUT_DIR}/soak-accelerated-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(record, null, 2));

  await shutdown("soak harness finished");

  console.log(`\nsoak verdict: ${worst}`);
  for (const finding of record.findings) console.log(`  - ${finding}`);
  console.log(`soak record: ${path}`);
  process.exit(worst === "FAIL" ? 1 : 0);
}

main().catch((error) => {
  console.error("soak harness failed:", error);
  process.exit(1);
});
