import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";

/**
 * DesktopKeepAwake - Holds a system sleep blocker while any locally hosted
 * backend reports working agent threads.
 *
 * Each backend instance is a source; the blocker is held while at least one
 * source reports work and the `keepAwakeWhileAgentsWork` client setting is on.
 * `prevent-app-suspension` blocks idle system sleep only — the display still
 * sleeps and locks, and a closed lid still suspends the machine.
 */
export class DesktopKeepAwake extends Context.Service<
  DesktopKeepAwake,
  {
    readonly setSourceWorking: (sourceId: string, working: boolean) => Effect.Effect<void>;
    readonly removeSource: (sourceId: string) => Effect.Effect<void>;
    readonly isHolding: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/power/DesktopKeepAwake") {}

export const make = Effect.gen(function* () {
  const powerSaveBlocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const workingSourcesRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const blockerIdRef = yield* Ref.make(Option.none<number>());
  const evaluateMutex = yield* Semaphore.make(1);

  // The blocker-start/ref-set and ref-clear/blocker-stop pairs must not be
  // split by an interrupt (e.g. when a backend control-stream fiber running
  // this dies mid-evaluate), or the id is lost and the blocker leaks until app
  // quit. Failures are contained here so callers on the backend lifecycle
  // path stay fire-and-forget.
  const evaluate = evaluateMutex
    .withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const settings = yield* clientSettings.get;
          const enabled = Option.match(settings, {
            onNone: () => DEFAULT_CLIENT_SETTINGS.keepAwakeWhileAgentsWork,
            onSome: (current) => current.keepAwakeWhileAgentsWork,
          });
          const workingSources = yield* Ref.get(workingSourcesRef);
          const shouldHold = enabled && workingSources.size > 0;
          const blockerId = yield* Ref.get(blockerIdRef);
          if (shouldHold && Option.isNone(blockerId)) {
            const id = yield* powerSaveBlocker.start("prevent-app-suspension");
            yield* Ref.set(blockerIdRef, Option.some(id));
            yield* Effect.logInfo("keep-awake engaged; agents are working");
          } else if (!shouldHold && Option.isSome(blockerId)) {
            yield* Ref.set(blockerIdRef, Option.none());
            yield* powerSaveBlocker.stop(blockerId.value);
            yield* Effect.logInfo("keep-awake released");
          }
        }),
      ),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logError("keep-awake evaluation failed", { cause: Cause.pretty(cause) }),
      ),
    );

  const updateSources = (update: (sources: Set<string>) => void) =>
    Ref.update(workingSourcesRef, (sources) => {
      const next = new Set(sources);
      update(next);
      return next;
    }).pipe(Effect.andThen(evaluate));

  // Registered before the settings subscriber is forked: finalizers run in
  // reverse order, so the subscriber is interrupted first and cannot start a
  // fresh blocker after this release. Takes the mutex so it cannot interleave
  // with an in-flight evaluate.
  yield* Effect.addFinalizer(() =>
    evaluateMutex
      .withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const blockerId = yield* Ref.get(blockerIdRef);
            if (Option.isSome(blockerId)) {
              yield* Ref.set(blockerIdRef, Option.none());
              yield* powerSaveBlocker.stop(blockerId.value);
            }
          }),
        ),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("keep-awake release on shutdown failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
  );

  // React to the settings toggle so switching it off releases a held blocker
  // immediately instead of at the end of the current run of work.
  const settingsChanges = yield* clientSettings.subscribeChanges;
  yield* settingsChanges.pipe(
    Stream.runForEach(() => evaluate),
    Effect.forkScoped,
  );

  return DesktopKeepAwake.of({
    setSourceWorking: (sourceId, working) =>
      updateSources((sources) => {
        if (working) {
          sources.add(sourceId);
        } else {
          sources.delete(sourceId);
        }
      }),
    removeSource: (sourceId) =>
      updateSources((sources) => {
        sources.delete(sourceId);
      }),
    isHolding: Ref.get(blockerIdRef).pipe(Effect.map(Option.isSome)),
  });
});

export const layer = Layer.effect(DesktopKeepAwake, make);
