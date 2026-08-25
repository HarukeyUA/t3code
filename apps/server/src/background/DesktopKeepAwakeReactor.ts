import type { OrchestrationEvent, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { eventThreadId } from "../orchestration/domainEvents.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { forkParked } from "../serverActivation.ts";

const RETRY_DELAY = "5 seconds";

/**
 * DesktopKeepAwakeReactor - Tells a hosting desktop app whether any thread is
 * actively working, over the desktop telemetry control channel.
 *
 * The desktop holds a system sleep blocker while any backend reports work, so
 * agents keep running behind a locked screen. Messages are edge-triggered: one
 * `setAgentsWorking` per flip of the "any thread working" aggregate. Every
 * edge is load-bearing, so a failed recompute or control write schedules a
 * delayed retry instead of waiting for the next lifecycle event. On servers
 * not hosted by the desktop app the control channel is absent and the send is
 * a no-op.
 */
export class DesktopKeepAwakeReactor extends Context.Service<
  DesktopKeepAwakeReactor,
  {
    readonly recomputeThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/background/DesktopKeepAwakeReactor") {}

/**
 * A thread counts as working while its provider session is spinning up or has
 * a turn in flight. This intentionally errs toward "working": a turn blocked
 * on an approval still holds the machine awake so a remote client can reach it
 * to respond.
 */
export function isThreadShellWorkingForKeepAwake(
  thread: Pick<OrchestrationThreadShell, "session" | "latestTurn">,
): boolean {
  return (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running"
  );
}

/**
 * The working aggregate can only flip on session/turn state transitions
 * (`session-set` is the single write path for session status) or when a
 * thread enters or leaves the active-shell projection (delete, archive,
 * unarchive — archive also dispatches an unconditional session stop). The
 * reactor re-reads a thread's shell on exactly these events and ignores the
 * high-frequency activity/message stream.
 */
export function isKeepAwakeRelevantEvent(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.session-set":
    case "thread.session-stop-requested":
    case "thread.turn-start-requested":
    case "thread.turn-interrupt-requested":
    case "thread.deleted":
    case "thread.archived":
    case "thread.unarchived":
      return true;
    default:
      return false;
  }
}

export const make = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const workingThreadsRef = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  // The desktop resets a backend's keep-awake contribution when its process
  // exits, so a fresh server is known to be "not working" and only flips to
  // working need announcing at startup.
  const lastSentRef = yield* Ref.make(false);
  // Assigned once the worker exists; retries re-enter the same queue.
  let scheduleRetry: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  const recomputeThreadUnsafe = Effect.fn("DesktopKeepAwakeReactor.recomputeThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* snapshotQuery.getThreadShellById(threadId);
    const working = Option.exists(thread, isThreadShellWorkingForKeepAwake);
    const anyWorking = yield* Ref.modify(workingThreadsRef, (current) => {
      if (current.has(threadId) === working) {
        return [current.size > 0, current] as const;
      }
      const next = new Set(current);
      if (working) {
        next.add(threadId);
      } else {
        next.delete(threadId);
      }
      return [next.size > 0, next] as const;
    });
    if ((yield* Ref.get(lastSentRef)) === anyWorking) {
      return;
    }
    // Advanced only after a successful send: a failed control write leaves
    // lastSent behind the aggregate so the retry (or any later lifecycle
    // event) re-compares and resends the lost edge.
    yield* receiver.setAgentsWorking(anyWorking);
    yield* Ref.set(lastSentRef, anyWorking);
  });

  // Sequential-only: the edge-trigger bookkeeping (workingThreads → lastSent →
  // send) is safe because every call runs through the worker queue. Do not
  // call this concurrently.
  const processThread = (threadId: ThreadId) =>
    recomputeThreadUnsafe(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("desktop keep-awake update failed; retry scheduled", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.andThen(scheduleRetry(threadId))),
      ),
    );

  const worker = yield* makeDrainableWorker(processThread);

  scheduleRetry = (threadId) =>
    Effect.forkDetach(
      Effect.sleep(RETRY_DELAY).pipe(
        Effect.andThen(worker.enqueue(threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("desktop keep-awake retry enqueue failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ).pipe(Effect.asVoid);

  const start: DesktopKeepAwakeReactor["Service"]["start"] = Effect.fn(
    "DesktopKeepAwakeReactor.start",
  )(function* () {
    // The stream fiber is forked before the snapshot reconcile to shrink the
    // boot window where an event lands after the snapshot read but before the
    // subscription registers. A missed event in that window self-heals on the
    // thread's next lifecycle event.
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (!isKeepAwakeRelevantEvent(event)) {
          return Effect.void;
        }
        const threadId = eventThreadId(event);
        return threadId === null ? Effect.void : worker.enqueue(threadId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("desktop keep-awake event stream stopped; keep-awake state is frozen", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );
    yield* forkParked(
      snapshotQuery.getShellSnapshot().pipe(
        Effect.retry({ times: 2 }),
        Effect.flatMap((snapshot) =>
          Effect.forEach(
            snapshot.threads.filter(isThreadShellWorkingForKeepAwake),
            (thread) => worker.enqueue(thread.id),
            { discard: true },
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("desktop keep-awake startup reconcile failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );
  });

  return DesktopKeepAwakeReactor.of({
    recomputeThread: worker.enqueue,
    start,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(DesktopKeepAwakeReactor, make);
