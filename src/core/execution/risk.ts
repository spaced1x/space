import type { ExecutionIntent } from "../strategy/types";
import type { RiskContext, RiskDecision } from "./types";

// The Risk Engine.
//
// Pure and deterministic: same intent + same context -> same verdict, always.
// Every Execution Intent passes through here; the Execution Engine consumes
// APPROVED verdicts only and nothing else may reach the venue.
//
// Check order is part of the contract: the first failing check wins, so a
// rejection reason is reproducible in Replay.
export function evaluateRisk(intent: ExecutionIntent, context: RiskContext): RiskDecision {
  const reject = (code: RiskDecision["code"], reason: string): RiskDecision => ({
    status: "REJECTED",
    code,
    reason,
    intentId: intent.id,
    at: context.at,
  });

  if (context.alreadyExecuted) {
    return reject("INTENT_ALREADY_EXECUTED", "an order chain already exists for this intent");
  }
  if (!context.engineArmed) {
    return reject("ENGINE_NOT_ARMED", "engine is not ARMED");
  }
  if (!context.strategyMode) {
    return reject("MODE_NOT_STRATEGY", "engine is not in STRATEGY mode");
  }
  if (!context.strategyEnabled) {
    return reject("STRATEGY_DISABLED", "strategy execution disabled in configuration");
  }
  if (!context.marketEnabled) {
    return reject("MARKET_DISABLED", "market execution disabled by operator");
  }
  if (!context.windowEnabled) {
    return reject("WINDOW_DISABLED", `${intent.windowSeconds}s window disabled by operator`);
  }
  if (!context.dailyTradingEnabled) {
    return reject("DAILY_TRADING_DISABLED", "daily trading switched off");
  }
  if (context.quotaRemaining <= 0) {
    return reject("QUOTA_EXHAUSTED", "trades per market already consumed");
  }
  if (context.openPositions >= context.maxPositions) {
    return reject(
      "MAX_POSITIONS",
      `max positions reached (${context.openPositions}/${context.maxPositions})`,
    );
  }
  if (!context.wallet.ready) {
    return reject("WALLET_NOT_READY", context.wallet.reason);
  }
  if (!context.marketActive) {
    return reject("MARKET_NOT_ACTIVE", "market is no longer active on the venue");
  }
  if (context.activeConditionId !== intent.conditionId) {
    return reject(
      "MARKET_MISMATCH",
      "intent references a market that is no longer the tracked market",
    );
  }
  if (!context.tokenId) {
    return reject("TOKEN_UNAVAILABLE", `no ${intent.direction} outcome token id for this market`);
  }
  if (!(context.size > 0)) {
    return reject("INVALID_ORDER_SIZE", "configured order size must be greater than zero");
  }

  return {
    status: "APPROVED",
    code: "OK",
    reason: `approved ${intent.direction} ${context.size} @ ${intent.windowSeconds}s window`,
    intentId: intent.id,
    at: context.at,
  };
}