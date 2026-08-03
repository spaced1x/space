import { createLogger } from "../logging/logger";
import { systemClock } from "../shared/clock";

// Envelope shape is fixed now so trading events added later are replayable
// without another format change.
import type { JsonObject } from "../shared/json";

export interface EventEnvelope<T extends JsonObject = JsonObject> {
  type: string;
  occurredAt: string;
  correlationId: string;
  source: string;
  payload: T;
}

export type EventHandler = (event: EventEnvelope) => void;

const log = createLogger("event-bus");
const handlers = new Map<string, Set<EventHandler>>();
const wildcard = new Set<EventHandler>();
const recent: EventEnvelope[] = [];
const RECENT_LIMIT = 200;

export const eventBus = {
  publish(event: Omit<EventEnvelope, "occurredAt"> & { occurredAt?: string }): EventEnvelope {
    const envelope: EventEnvelope = { ...event, occurredAt: event.occurredAt ?? systemClock.iso() };
    recent.push(envelope);
    if (recent.length > RECENT_LIMIT) recent.shift();
    for (const handler of [...(handlers.get(envelope.type) ?? []), ...wildcard]) {
      try {
        handler(envelope);
      } catch (error) {
        // A subscriber must never break the publisher.
        log.error("subscriber threw", {
          type: envelope.type,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return envelope;
  },

  subscribe(type: string, handler: EventHandler): () => void {
    const set = handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler);
    handlers.set(type, set);
    return () => set.delete(handler);
  },

  subscribeAll(handler: EventHandler): () => void {
    wildcard.add(handler);
    return () => wildcard.delete(handler);
  },

  recent(limit = 50): EventEnvelope[] {
    return recent.slice(-limit).reverse();
  },
};