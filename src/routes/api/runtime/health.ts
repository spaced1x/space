import { createFileRoute } from "@tanstack/react-router";

import { bootTimes, getBootTrace } from "../../../core/boot.server";
import { collectHealth } from "../../../core/health/registry";
import { listConnections } from "../../../core/runtime/connections.server";
import { syncConnections } from "../../../core/runtime/connection-sync.server";
import { getRuntimeState } from "../../../core/state/store";
import { activeEnvironment } from "../../../core/runtime/peek.server";

/**
 * Machine-readable runtime health. Used by deployment verification and uptime
 * checks. Reports only real telemetry: never a hardcoded "ok". The runtime is
 * started by the process entry point, never by this endpoint.
 */
export const Route = createFileRoute("/api/runtime/health")({
  server: {
    handlers: {
      GET: async () => {
        try {
          await syncConnections();
          const health = await collectHealth();
          const runtime = getRuntimeState();
          const connections = listConnections();
          const times = bootTimes();
          // Runtime health answers "is the process serving correctly", not "is
          // trading allowed". Trading blockers are reported separately.
          const blockers = connections.filter(
            (connection) => connection.blocksTrading && connection.health === "FAILED",
          );
          const body = {
            status: health.state,
            tradingBlockedBy: blockers.map((connection) => ({
              id: connection.id,
              reason: connection.reason,
            })),
            environment: activeEnvironment(),
            lifecycle: runtime.lifecycle,
            mode: runtime.mode,
            emergencyStop: runtime.emergencyStop,
            bootStartedAt: times.startedAt,
            bootCompletedAt: times.completedAt,
            uptimeSeconds: Math.round(process.uptime()),
            checks: health.components,
            connections: connections.map((connection) => ({
              id: connection.id,
              state: connection.state,
              health: connection.health,
              reason: connection.reason,
              lastSuccessAt: connection.lastSuccessAt,
              lastError: connection.lastError,
            })),
            bootTrace: getBootTrace(),
          };
          return Response.json(body, {
            status: body.status === "FAILED" || body.status === "NOT_INITIALIZED" ? 503 : 200,
            headers: { "cache-control": "no-store" },
          });
        } catch (error) {
          return Response.json(
            {
              status: "FAILED",
              reason: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? (error.stack ?? null) : null,
            },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});