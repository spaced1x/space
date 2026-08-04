import { getSystemSnapshot } from "./system.functions";
import type { RuntimeSnapshot } from "./use-runtime-snapshot";

export interface SnapshotTransport {
  fetch(): Promise<RuntimeSnapshot>;
}

class ServerFnTransport implements SnapshotTransport {
  constructor(private readonly fn: typeof getSystemSnapshot) {}

  async fetch(): Promise<RuntimeSnapshot> {
    return this.fn();
  }
}

class HttpTransport implements SnapshotTransport {
  constructor(private readonly url: string) {}

  async fetch(): Promise<RuntimeSnapshot> {
    const response = await fetch(this.url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`snapshot endpoint returned ${response.status}: ${await response.text()}`);
    }
    return response.json() as Promise<RuntimeSnapshot>;
  }
}

let transport: SnapshotTransport | undefined;

/**
 * Return the canonical snapshot transport. In a TanStack Start SSR context we
 * use the generated server function; in standalone or remote-dashboard mode we
 * fall back to the public HTTP endpoint so the dashboard can operate against a
 * remote VPS runtime exactly as it does against localhost.
 */
export function getSnapshotTransport(): SnapshotTransport {
  if (!transport) {
    const remote = import.meta.env["VITE_RUNTIME_SNAPSHOT_URL"] as string | undefined;
    transport = remote ? new HttpTransport(remote) : new ServerFnTransport(getSystemSnapshot);
  }
  return transport;
}

export function setSnapshotTransport(value: SnapshotTransport): void {
  transport = value;
}
