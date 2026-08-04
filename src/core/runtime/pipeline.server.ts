import { clock } from "../clock/clock.service";
import { executionSnapshot } from "../execution/execution.server";
import { parityStatus } from "../execution/parity.server";
import { discoveryStats, gammaBreakerStatus } from "../market/discovery.server";
import { getMarketState } from "../market/state";
import { schedulerStatus } from "../scheduler/scheduler.server";
import { strategySnapshot } from "../strategy/strategy.server";
import { twapServiceSnapshot } from "../twap/service.server";

// Trading pipeline observability.
//
// This module derives — it never computes trading state of its own and never
// polls. Every field is read from the module that already owns it, so the
// pipeline view can never disagree with the rest of the runtime. Unknown values
// stay null; nothing here is ever synthesised.

export type PipelineStageState = "OK" | "WAITING" | "DEGRADED" | "FAILED" | "DISABLED";

export interface PipelineStage {
  id: string;
  label: string;
  state: PipelineStageState;
  /** What the stage consumed on its last pass. */
  input: string;
  /** What the stage produced on its last pass. */
  output: string;
  latencyMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  /** Why the stage is not producing, in operator language. Null when OK. */
  waitingReason: string | null;
  /** How the stage recovers — automatic or the operator action required. */
  recovery: string;
}

/** Order lifecycle as one runtime-owned value. */
export type OrderLifecycle =
  | "NONE"
  | "CREATED"
  | "SUBMITTED"
  | "ACKNOWLEDGED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "EXPIRED"
  | "REJECTED"
  | "SETTLED";

export type PositionLifecycle =
  | "WAITING"
  | "OPENING"
  | "OPENED"
  | "PARTIALLY_CLOSED"
  | "CLOSED"
  | "SETTLED";

export type TwapLifecycle =
  | "PROVIDER_SELECTED"
  | "WARMING"
  | "COLLECTING"
  | "ACTIVE"
  | "STALE"
  | "RECOVERING";

export type VenueLifecycle =
  | "DISCONNECTED"
  | "CONNECTING"
  | "AUTHENTICATED"
  | "READY"
  | "DEGRADED"
  | "RECONNECTING";

export interface PipelineSnapshot {
  stages: PipelineStage[];
  /** The first stage that is blocking the pipeline, or null when it flows. */
  blockedAt: { id: string; label: string; reason: string } | null;
  lifecycles: {
    order: OrderLifecycle;
    position: PositionLifecycle;
    twap: TwapLifecycle;
    venue: VenueLifecycle;
  };
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function orderLifecycle(execution: ReturnType<typeof executionSnapshot>): OrderLifecycle {
  const latest = execution.orders.at(-1);
  if (!latest) return "NONE";
  switch (latest.state) {
    case "INTENT_CREATED":
    case "RISK_APPROVED":
    case "ORDER_BUILD":
      return "CREATED";
    case "LIMIT_SUBMITTED":
    case "MARKET_SUBMITTED":
      return latest.venueOrderId ? "ACKNOWLEDGED" : "SUBMITTED";
    case "PARTIAL_FILL":
      return "PARTIALLY_FILLED";
    case "FILLED":
      return "FILLED";
    case "LIMIT_CANCELLED":
    case "CANCELLED":
      return "CANCELLED";
    case "LIMIT_TIMEOUT":
    case "EXPIRED":
      return "EXPIRED";
    case "RISK_REJECTED":
    case "FAILED":
      return "REJECTED";
    default:
      return "NONE";
  }
}

function positionLifecycle(execution: ReturnType<typeof executionSnapshot>): PositionLifecycle {
  const positions = execution.positions;
  if (!positions.length) return "WAITING";
  const latest = positions.at(-1)!;
  if (latest.status === "CLOSED") {
    return latest.settledValue === null || latest.settledValue === undefined
      ? "CLOSED"
      : "SETTLED";
  }
  if (latest.status === "ACTIVE") {
    const opening = execution.activeOrders.some(
      (order) => order.conditionId === latest.conditionId,
    );
    return opening ? "OPENING" : "OPENED";
  }
  return "WAITING";
}

function twapLifecycle(twap: ReturnType<typeof twapServiceSnapshot>): TwapLifecycle {
  const active = twap.active;
  if (!active) return "PROVIDER_SELECTED";
  switch (active.state) {
    case "CONNECTED":
      return active.samples > 0 ? "ACTIVE" : "COLLECTING";
    case "STALE":
      return "STALE";
    case "RECONNECTING":
      return "RECOVERING";
    case "WAITING":
      return active.samples > 0 ? "COLLECTING" : "WARMING";
    default:
      return "PROVIDER_SELECTED";
  }
}

function venueLifecycle(execution: ReturnType<typeof executionSnapshot>): VenueLifecycle {
  const venue = execution.venue;
  if (venue.ready) return execution.wallet.ready ? "READY" : "AUTHENTICATED";
  if (execution.lastError) return "DEGRADED";
  return venue.host ? "CONNECTING" : "DISCONNECTED";
}

/**
 * Derive the full discovery -> dashboard pipeline. Every stage answers the same
 * six operator questions so a blocked pipeline names its own blocking stage.
 */
export function pipelineSnapshot(): PipelineSnapshot {
  const market = getMarketState();
  const discovery = discoveryStats();
  const breaker = gammaBreakerStatus();
  const twap = twapServiceSnapshot();
  const strategy = strategySnapshot();
  const execution = executionSnapshot();
  const scheduler = schedulerStatus();
  const parity = parityStatus();
  const now = clock().now();

  const selected = strategy.market.conditionId;
  const activeMarkets = Object.values(market.markets).filter(Boolean).length;
  const settlement = market.settlement;
  const reading = strategy.twap;
  const openWindow = strategy.windows.find((window) => window.id === strategy.activeWindowId);

  const stages: PipelineStage[] = [
    {
      id: "gamma_discovery",
      label: "Gamma discovery",
      state: breaker.open
        ? "DEGRADED"
        : discovery.lastSuccessAt
          ? "OK"
          : discovery.lastError
            ? "FAILED"
            : "WAITING",
      input: `Gamma REST · ${discovery.refreshes} refreshes`,
      output: `${discovery.candidatesSeen} candidates scanned, ${activeMarkets} BTC market(s) tracked`,
      latencyMs: discovery.latencyMs,
      lastSuccessAt: discovery.lastSuccessAt,
      lastFailureAt: discovery.lastError ? discovery.lastRefreshAt : null,
      lastError: discovery.lastError,
      waitingReason: breaker.open
        ? `Gamma circuit breaker open after ${breaker.consecutiveFailures} failures`
        : discovery.lastSuccessAt
          ? null
          : "awaiting the first successful Gamma refresh",
      recovery: "Automatic — the breaker probes Gamma again on its recovery interval",
    },
    {
      id: "market_selection",
      label: "Market selection",
      state: selected ? "OK" : "WAITING",
      input: `${activeMarkets} discovered BTC market(s)`,
      output: selected ? `${strategy.market.slug ?? selected}` : "no market selected",
      latencyMs: null,
      lastSuccessAt: discovery.lastSuccessAt,
      lastFailureAt: null,
      lastError: null,
      waitingReason: selected ? null : "no open BTC market inside the trading horizon",
      recovery: "Automatic — the next discovery pass selects the next active market",
    },
    {
      id: "twap_provider",
      label: "TWAP provider",
      state:
        twap.active?.state === "CONNECTED"
          ? "OK"
          : twap.active?.state === "FAILED"
            ? "FAILED"
            : twap.active?.state === "DISABLED" || twap.active?.state === "NOT_CONFIGURED"
              ? "DISABLED"
              : "WAITING",
      input: twap.active ? `${twap.active.transport} · ${twap.active.symbol}` : "no active provider",
      output: twap.active?.price === null || twap.active === null
        ? "no sample"
        : `${twap.active.price} (${twap.active.samples} samples)`,
      latencyMs: twap.active?.latencyMs ?? null,
      lastSuccessAt: twap.active?.lastSuccessAt ?? null,
      lastFailureAt: null,
      lastError: twap.active?.lastError ?? null,
      waitingReason: twap.active?.state === "CONNECTED" ? null : (twap.active?.reason ?? "no provider selected"),
      recovery: twap.active?.action ?? "Automatic — the shared RTDS socket reconnects and resubscribes",
    },
    {
      id: "twap_service",
      label: "TWAP service",
      state: settlement ? "OK" : "WAITING",
      input: twap.activeProviderId ?? "no provider",
      output: settlement
        ? `settlement sample ${settlement.price} @ ${settlement.observedAt}`
        : "no settlement sample published",
      latencyMs: settlement?.latencyMs ?? null,
      lastSuccessAt: twap.lastPublishedAt,
      lastFailureAt: null,
      lastError: null,
      waitingReason: settlement ? null : "the active provider has not produced a sample yet",
      recovery: "Automatic — publication resumes with the next provider sample",
    },
    {
      id: "strategy",
      label: "Strategy",
      state: reading.state === "OK" ? "OK" : reading.state === "STALE" ? "DEGRADED" : "WAITING",
      input: `settlement TWAP ${reading.samples} sample(s)`,
      output: openWindow
        ? `window ${openWindow.id} · ${strategy.prediction.direction ?? "no direction"}`
        : `no open window · ${reading.message}`,
      latencyMs: null,
      lastSuccessAt: reading.lastUpdateAt,
      lastFailureAt: null,
      lastError: null,
      waitingReason: reading.state === "OK" ? null : reading.message,
      recovery: "Automatic — the frozen window reopens on the next settlement cycle",
    },
    {
      id: "risk",
      label: "Risk",
      state:
        execution.lastRisk === null
          ? "WAITING"
          : execution.lastRisk.status === "APPROVED"
            ? "OK"
            : "DEGRADED",
      input: `${execution.intentsSeen} intent(s) seen`,
      output: execution.lastRisk
        ? `${execution.lastRisk.status} · ${execution.lastRisk.code}`
        : "no risk verdict yet",
      latencyMs: null,
      lastSuccessAt: execution.lastRisk?.at ?? null,
      lastFailureAt: execution.riskRejections.at(-1)?.at ?? null,
      lastError: execution.riskRejections.at(-1)?.reason ?? null,
      waitingReason: execution.lastRisk ? null : "no execution intent has reached risk yet",
      recovery: "Automatic — the next approved intent clears the block",
    },
    {
      id: "order_intent",
      label: "Order intent",
      state: strategy.intents.length ? "OK" : "WAITING",
      input: `strategy triggers`,
      output: `${strategy.intents.length} intent(s) persisted`,
      latencyMs: null,
      lastSuccessAt: strategy.intents.at(-1)?.createdAt ?? null,
      lastFailureAt: null,
      lastError: null,
      waitingReason: strategy.intents.length ? null : "no trigger has fired in the current window",
      recovery: "Automatic — a trigger inside the frozen window creates the next intent",
    },
    {
      id: "sizing",
      label: "Sizing",
      state: execution.lastSizing
        ? execution.lastSizing.appliedSize > 0
          ? "OK"
          : "DEGRADED"
        : "WAITING",
      input: execution.lastSizing
        ? `${execution.lastSizing.source} request ${execution.lastSizing.requestedSize}`
        : "no sizing request yet",
      output: execution.lastSizing
        ? `applied ${execution.lastSizing.appliedSize} (cap ${execution.lastSizing.cap}) · ${execution.lastSizing.reason}`
        : "no size decided",
      latencyMs: null,
      lastSuccessAt: execution.lastSizing?.at ?? null,
      lastFailureAt: null,
      lastError: null,
      waitingReason: execution.lastSizing
        ? execution.lastSizing.appliedSize > 0
          ? null
          : execution.lastSizing.reason
        : "no intent has requested a size yet",
      recovery: "Automatic — the next intent is sized by the same single sizing module",
    },
    {
      id: "venue",
      label: `Venue (${execution.venue.kind})`,
      state: execution.venue.ready ? "OK" : execution.lastError ? "FAILED" : "WAITING",
      input: execution.config.mode,
      output: `${execution.venue.host} · ${execution.venue.message}`,
      latencyMs: null,
      lastSuccessAt: execution.startedAt,
      lastFailureAt: null,
      lastError: execution.lastError,
      waitingReason: execution.venue.ready ? null : execution.venue.message,
      recovery: "Automatic — the venue adapter retries; check wallet configuration for V2",
    },
    {
      id: "position_manager",
      label: "Position manager",
      state: execution.counts.positions ? "OK" : "WAITING",
      input: `${execution.fills.length} fill(s)`,
      output: `${execution.counts.positions} active position(s)`,
      latencyMs: null,
      lastSuccessAt: execution.positions.at(-1)?.lastFillAt ?? null,
      lastFailureAt: null,
      lastError: null,
      waitingReason: execution.counts.positions ? null : "no position open",
      recovery: "Automatic — positions open as fills arrive",
    },
    {
      id: "scheduler",
      label: "Scheduler",
      state: scheduler.running
        ? scheduler.tasks.some((task) => task.lastError)
          ? "DEGRADED"
          : "OK"
        : "DISABLED",
      input: `${scheduler.tasks.length} registered task(s)`,
      output: `${scheduler.ticks} ticks · drift ${scheduler.maxTickDriftMs.toFixed(1)}ms`,
      latencyMs: Math.round(scheduler.maxTickDriftMs),
      lastSuccessAt: scheduler.startedAt,
      lastFailureAt: null,
      lastError: scheduler.tasks.find((task) => task.lastError)?.lastError ?? null,
      waitingReason: scheduler.running ? null : "scheduler is stopped",
      recovery: "Automatic — the scheduler catches up missed executions on the next tick",
    },
    {
      id: "runtime_snapshot",
      label: "Runtime snapshot",
      state: "OK",
      input: "every runtime module",
      output: `market state v${market.version} published ${market.publishedAt}`,
      latencyMs: null,
      lastSuccessAt: iso(now),
      lastFailureAt: null,
      lastError: null,
      waitingReason: null,
      recovery: "Automatic — the dashboard re-polls and recovers on its own",
    },
    {
      id: "parity",
      label: "V1/V2 parity",
      state: parity.comparedAt === null
        ? "WAITING"
        : parity.divergentPairs > 0
          ? "DEGRADED"
          : "OK",
      input: `${parity.environment} decisions vs the other environment's records`,
      output: parity.message,
      latencyMs: null,
      lastSuccessAt: parity.comparedAt,
      lastFailureAt: parity.failures.at(0)?.at ?? null,
      lastError: parity.failures.at(0)
        ? `${parity.failures[0]!.field}: V1 ${parity.failures[0]!.v1} vs V2 ${parity.failures[0]!.v2}`
        : null,
      waitingReason: parity.comparedAt === null ? "no parity comparison has run yet" : null,
      recovery:
        "Operator — run the same market window in both environments, then inspect the differing field",
    },
  ];

  const blocking = stages.find(
    (stage) => stage.state === "FAILED" || stage.state === "DEGRADED",
  ) ?? stages.find((stage) => stage.state === "WAITING");

  return {
    stages,
    blockedAt: blocking
      ? {
          id: blocking.id,
          label: blocking.label,
          reason: blocking.waitingReason ?? blocking.lastError ?? blocking.output,
        }
      : null,
    lifecycles: {
      order: orderLifecycle(execution),
      position: positionLifecycle(execution),
      twap: twapLifecycle(twap),
      venue: venueLifecycle(execution),
    },
  };
}