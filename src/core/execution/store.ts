import type {
  FillRecord,
  OrderEventRecord,
  OrderRecord,
  OrderTransitionRecord,
  PositionTransitionRecord,
  RiskDecision,
  SizingDecision,
} from "./types";

/**
 * One execution event: the current-state projection, the append-only event and
 * the append-only transition, committed together or not at all.
 */
export interface ExecutionCommit {
  order: OrderRecord;
  event: OrderEventRecord;
  transition: OrderTransitionRecord | null;
}

// Storage port used by the Execution Engine. The SQLite repository implements
// it in production; tests implement it in memory. The engine never writes SQL.
export interface ExecutionStore {
  /**
   * Opens the single order chain for an intent. Returns false when a chain
   * already exists — the storage-level duplicate guard.
   */
  createOrder(order: OrderRecord): Promise<boolean>;
  updateOrder(order: OrderRecord): Promise<void>;
  appendEvent(event: OrderEventRecord): Promise<void>;
  /**
   * Atomic: order projection + event + transition in one transaction. Partial
   * persistence is a runtime failure, never a silent divergence.
   */
  commit(commit: ExecutionCommit): Promise<void>;
  /** Returns false when the venue trade id was already recorded. */
  recordFill(fill: FillRecord): Promise<boolean>;
  recordRisk(decision: RiskDecision, attempt: number): Promise<void>;
  recordSizing(decision: SizingDecision): Promise<void>;
  /** Append-only, duplicate-safe: returns the number of new rows written. */
  recordPositionTransitions(rows: PositionTransitionRecord[]): Promise<number>;
  loadPositionTransitions(limit?: number): Promise<PositionTransitionRecord[]>;
  loadOrderTransitions(limit?: number): Promise<OrderTransitionRecord[]>;
  loadOrders(limit?: number): Promise<OrderRecord[]>;
  loadFills(limit?: number): Promise<FillRecord[]>;
}