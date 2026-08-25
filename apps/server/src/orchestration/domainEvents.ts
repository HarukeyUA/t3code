import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";

/**
 * Resolve the thread a domain event belongs to, from its payload when
 * present, else from a thread-aggregate id. Used by reactors that key
 * per-thread work off the global event stream.
 */
export function eventThreadId(event: OrchestrationEvent): ThreadId | null {
  const payload = event.payload as { readonly threadId?: unknown };
  if (typeof payload.threadId === "string") {
    return payload.threadId as ThreadId;
  }
  if (event.aggregateKind === "thread" && typeof event.aggregateId === "string") {
    return event.aggregateId as ThreadId;
  }
  return null;
}
