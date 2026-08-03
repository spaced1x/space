import type { Command } from "../../core/bus/commands";
import type { RuntimeState } from "../../core/state/store";
import { Button } from "../ui/button";

// Every button routes through the command bus and receives an explicit verdict.
export function CommandDeck({
  runtime,
  pending,
  onCommand,
}: {
  runtime: RuntimeState;
  pending: boolean;
  onCommand: (command: Command) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={pending} onClick={() => onCommand({ kind: "ARM" })}>
        Arm
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => onCommand({ kind: "DISARM" })}
      >
        Disarm
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => onCommand({ kind: "PAUSE" })}
      >
        Pause
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => onCommand({ kind: "RESUME" })}
      >
        Resume
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => onCommand({ kind: "ENABLE_5M", enabled: !runtime.windows.fiveMinute })}
      >
        {runtime.windows.fiveMinute ? "Disable 5m" : "Enable 5m"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => onCommand({ kind: "ENABLE_15M", enabled: !runtime.windows.fifteenMinute })}
      >
        {runtime.windows.fifteenMinute ? "Disable 15m" : "Enable 15m"}
      </Button>
    </div>
  );
}