import type { OrchestrationEvent, OrchestrationThreadShell } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as DesktopKeepAwakeReactor from "./DesktopKeepAwakeReactor.ts";

function shell(input: {
  readonly sessionStatus?: "idle" | "starting" | "running" | "ready" | "stopped" | "error";
  readonly latestTurnState?: "running" | "completed" | "interrupted" | "error";
}): OrchestrationThreadShell {
  return {
    session: input.sessionStatus === undefined ? null : { status: input.sessionStatus },
    latestTurn: input.latestTurnState === undefined ? null : { state: input.latestTurnState },
  } as unknown as OrchestrationThreadShell;
}

// The type parameter is compiler-checked against the contract event union, so
// a renamed event type fails this file instead of leaving the predicate and
// its test agreeing about a type that no longer exists.
function event(type: OrchestrationEvent["type"], threadId?: ThreadId): OrchestrationEvent {
  return {
    type,
    aggregateKind: "thread",
    aggregateId: threadId ?? "thread-x",
    payload: threadId === undefined ? {} : { threadId },
  } as unknown as OrchestrationEvent;
}

describe("isThreadShellWorkingForKeepAwake", () => {
  it("treats starting and running sessions as working", () => {
    expect(
      DesktopKeepAwakeReactor.isThreadShellWorkingForKeepAwake(
        shell({ sessionStatus: "starting" }),
      ),
    ).toBe(true);
    expect(
      DesktopKeepAwakeReactor.isThreadShellWorkingForKeepAwake(shell({ sessionStatus: "running" })),
    ).toBe(true);
  });

  it("treats a running latest turn as working even without a session", () => {
    expect(
      DesktopKeepAwakeReactor.isThreadShellWorkingForKeepAwake(
        shell({ latestTurnState: "running" }),
      ),
    ).toBe(true);
  });

  it("treats settled threads as idle", () => {
    expect(DesktopKeepAwakeReactor.isThreadShellWorkingForKeepAwake(shell({}))).toBe(false);
    expect(
      DesktopKeepAwakeReactor.isThreadShellWorkingForKeepAwake(
        shell({ sessionStatus: "ready", latestTurnState: "completed" }),
      ),
    ).toBe(false);
    expect(
      DesktopKeepAwakeReactor.isThreadShellWorkingForKeepAwake(shell({ sessionStatus: "error" })),
    ).toBe(false);
  });
});

describe("isKeepAwakeRelevantEvent", () => {
  it("selects session, turn, and projection-visibility events only", () => {
    expect(DesktopKeepAwakeReactor.isKeepAwakeRelevantEvent(event("thread.session-set"))).toBe(
      true,
    );
    expect(
      DesktopKeepAwakeReactor.isKeepAwakeRelevantEvent(event("thread.turn-start-requested")),
    ).toBe(true);
    expect(DesktopKeepAwakeReactor.isKeepAwakeRelevantEvent(event("thread.deleted"))).toBe(true);
    expect(DesktopKeepAwakeReactor.isKeepAwakeRelevantEvent(event("thread.archived"))).toBe(true);
    expect(DesktopKeepAwakeReactor.isKeepAwakeRelevantEvent(event("thread.unarchived"))).toBe(true);
    expect(
      DesktopKeepAwakeReactor.isKeepAwakeRelevantEvent(event("thread.activity-appended")),
    ).toBe(false);
    expect(DesktopKeepAwakeReactor.isKeepAwakeRelevantEvent(event("thread.message-sent"))).toBe(
      false,
    );
  });
});

const engineLayer = (events: Stream.Stream<OrchestrationEvent> = Stream.empty) =>
  Layer.succeed(OrchestrationEngineService, {
    readEvents: () => Stream.empty,
    dispatch: () => Effect.succeed({ sequence: 1 }),
    streamDomainEvents: events,
    latestSequence: Effect.succeed(0),
  } as unknown as OrchestrationEngineShape);

const snapshotQueryLayer = (shells: ReadonlyMap<string, OrchestrationThreadShell>) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [],
        threads: [...shells.entries()].map(([id, thread]) => ({ ...thread, id })),
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(shells.get(threadId))),
  } as unknown as ProjectionSnapshotQueryShape);

describe("DesktopKeepAwakeReactor", () => {
  it.effect("sends one edge-triggered message per flip of the aggregate", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const shells = new Map<string, OrchestrationThreadShell>();
      const layer = DesktopKeepAwakeReactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            engineLayer(),
            snapshotQueryLayer(shells),
            DesktopTelemetryReceiver.layerTest({
              setAgentsWorking: (working) => Ref.update(sent, (messages) => [...messages, working]),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* DesktopKeepAwakeReactor.DesktopKeepAwakeReactor;
        const threadA = ThreadId.make("thread-a");
        const threadB = ThreadId.make("thread-b");

        shells.set(threadA, shell({ sessionStatus: "running" }));
        yield* reactor.recomputeThread(threadA);
        yield* reactor.drain;
        expect(yield* Ref.get(sent)).toEqual([true]);

        shells.set(threadB, shell({ sessionStatus: "starting" }));
        yield* reactor.recomputeThread(threadB);
        yield* reactor.drain;
        expect(yield* Ref.get(sent)).toEqual([true]);

        shells.set(threadA, shell({ sessionStatus: "ready", latestTurnState: "completed" }));
        yield* reactor.recomputeThread(threadA);
        yield* reactor.drain;
        expect(yield* Ref.get(sent)).toEqual([true]);

        // A deleted thread disappears from the projection entirely.
        shells.delete(threadB);
        yield* reactor.recomputeThread(threadB);
        yield* reactor.drain;
        expect(yield* Ref.get(sent)).toEqual([true, false]);

        yield* reactor.recomputeThread(threadA);
        yield* reactor.drain;
        expect(yield* Ref.get(sent)).toEqual([true, false]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries a lost edge after a failed control write", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const delivered = yield* Deferred.make<boolean>();
      const threadA = ThreadId.make("thread-a");
      const shells = new Map<string, OrchestrationThreadShell>([
        [threadA, shell({ sessionStatus: "running" })],
      ]);
      const layer = DesktopKeepAwakeReactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            engineLayer(),
            snapshotQueryLayer(shells),
            DesktopTelemetryReceiver.layerTest({
              setAgentsWorking: (working) =>
                Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                  Effect.flatMap((count) =>
                    count === 1
                      ? Effect.fail(
                          new DesktopTelemetryReceiver.DesktopTelemetryControlFailed({
                            fd: 5,
                            operation: "write",
                            cause: "transient",
                          }),
                        )
                      : Deferred.succeed(delivered, working).pipe(Effect.asVoid),
                  ),
                ),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* DesktopKeepAwakeReactor.DesktopKeepAwakeReactor;
        yield* reactor.recomputeThread(threadA);
        yield* reactor.drain;
        // The first send failed; the edge must not be considered delivered.
        expect(yield* Ref.get(attempts)).toBe(1);
        yield* TestClock.adjust("5 seconds");
        expect(yield* Deferred.await(delivered)).toBe(true);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flips on lifecycle events from the domain stream", () =>
    Effect.gen(function* () {
      const observedWorking = yield* Deferred.make<boolean>();
      const threadA = ThreadId.make("thread-a");
      const shells = new Map<string, OrchestrationThreadShell>([
        [threadA, shell({ sessionStatus: "running" })],
      ]);
      const layer = DesktopKeepAwakeReactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            engineLayer(Stream.make(event("thread.session-set", threadA))),
            snapshotQueryLayer(shells),
            DesktopTelemetryReceiver.layerTest({
              setAgentsWorking: (working) =>
                Deferred.succeed(observedWorking, working).pipe(Effect.asVoid),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* DesktopKeepAwakeReactor.DesktopKeepAwakeReactor;
        yield* reactor.start();
        expect(yield* Deferred.await(observedWorking)).toBe(true);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reconciles already-working threads from the startup snapshot", () =>
    Effect.gen(function* () {
      const observedWorking = yield* Deferred.make<boolean>();
      const shells = new Map<string, OrchestrationThreadShell>([
        [ThreadId.make("thread-a"), shell({ sessionStatus: "running" })],
      ]);
      const layer = DesktopKeepAwakeReactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            engineLayer(),
            snapshotQueryLayer(shells),
            DesktopTelemetryReceiver.layerTest({
              setAgentsWorking: (working) =>
                Deferred.succeed(observedWorking, working).pipe(Effect.asVoid),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* DesktopKeepAwakeReactor.DesktopKeepAwakeReactor;
        yield* reactor.start();
        expect(yield* Deferred.await(observedWorking)).toBe(true);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
});
