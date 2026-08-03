import type { HealthState } from "../../core/health/types";
import { cn } from "../../lib/utils";

const TONE: Record<HealthState, string> = {
  OK: "bg-ok",
  DEGRADED: "bg-warn",
  FAILED: "bg-fail",
  DISABLED: "bg-off",
  NOT_INITIALIZED: "bg-idle",
};

export function StatusDot({ state, className }: { state: HealthState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", TONE[state], className)}
    />
  );
}

export function stateLabel(state: HealthState): string {
  return state.replace(/_/g, " ").toLowerCase();
}
