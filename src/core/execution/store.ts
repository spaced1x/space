import type { FillRecord, OrderEventRecord, OrderRecord, RiskDecision } from "./types";

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
  /** Returns false when the venue trade id was already recorded. */
  recordFill(fill: FillRecord): Promise<boolean>;
  recordRisk(decision: RiskDecision, attempt: number): Promise<void>;
  loadOrders(limit?: number): Promise<OrderRecord[]>;
  loadFills(limit?: number): Promise<FillRecord[]>;
}