import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopKeepAwake from "./DesktopKeepAwake.ts";

interface BlockerCalls {
  readonly starts: number;
  readonly stoppedIds: ReadonlyArray<number>;
}

// `start` hands out incrementing ids so the tests catch a stale id being
// passed to `stop` across engage/release cycles.
const makeBlockerLayer = (onStop: Effect.Effect<unknown> = Effect.void) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<BlockerCalls>({ starts: 0, stoppedIds: [] });
    const layer = Layer.succeed(
      ElectronPowerSaveBlocker.ElectronPowerSaveBlocker,
      ElectronPowerSaveBlocker.ElectronPowerSaveBlocker.of({
        start: () =>
          Ref.modify(calls, (current) => [
            current.starts,
            { ...current, starts: current.starts + 1 },
          ]),
        stop: (id) =>
          Ref.update(calls, (current) => ({
            ...current,
            stoppedIds: [...current.stoppedIds, id],
          })).pipe(Effect.andThen(onStop), Effect.asVoid),
      }),
    );
    return { calls, layer };
  });

describe("DesktopKeepAwake", () => {
  it.effect("holds one blocker across overlapping sources and stops the current id", () =>
    Effect.gen(function* () {
      const blocker = yield* makeBlockerLayer();
      yield* Effect.gen(function* () {
        const keepAwake = yield* DesktopKeepAwake.DesktopKeepAwake;

        yield* keepAwake.setSourceWorking("backend-a", true);
        yield* keepAwake.setSourceWorking("backend-b", true);
        expect(yield* Ref.get(blocker.calls)).toEqual({ starts: 1, stoppedIds: [] });
        expect(yield* keepAwake.isHolding).toBe(true);

        yield* keepAwake.setSourceWorking("backend-a", false);
        expect(yield* Ref.get(blocker.calls)).toEqual({ starts: 1, stoppedIds: [] });

        // A backend process exit removes its source without a farewell message.
        yield* keepAwake.removeSource("backend-b");
        expect(yield* Ref.get(blocker.calls)).toEqual({ starts: 1, stoppedIds: [0] });
        expect(yield* keepAwake.isHolding).toBe(false);

        // Re-engage and release again: the second cycle must stop the second
        // id, not a stale one.
        yield* keepAwake.setSourceWorking("backend-a", true);
        expect(yield* Ref.get(blocker.calls)).toEqual({ starts: 2, stoppedIds: [0] });

        yield* keepAwake.setSourceWorking("backend-a", false);
        expect(yield* Ref.get(blocker.calls)).toEqual({ starts: 2, stoppedIds: [0, 1] });
      }).pipe(
        Effect.provide(
          DesktopKeepAwake.layer.pipe(
            Layer.provide(Layer.mergeAll(blocker.layer, DesktopClientSettings.layerTest())),
          ),
        ),
      );
    }),
  );

  it.effect("never holds while the setting is off", () =>
    Effect.gen(function* () {
      const blocker = yield* makeBlockerLayer();
      const settingsLayer = DesktopClientSettings.layerTest(
        Option.some({ ...DEFAULT_CLIENT_SETTINGS, keepAwakeWhileAgentsWork: false }),
      );
      yield* Effect.gen(function* () {
        const keepAwake = yield* DesktopKeepAwake.DesktopKeepAwake;
        yield* keepAwake.setSourceWorking("backend-a", true);
        expect(yield* Ref.get(blocker.calls)).toEqual({ starts: 0, stoppedIds: [] });
        expect(yield* keepAwake.isHolding).toBe(false);
      }).pipe(
        Effect.provide(
          DesktopKeepAwake.layer.pipe(Layer.provide(Layer.mergeAll(blocker.layer, settingsLayer))),
        ),
      );
    }),
  );

  it.effect("releases a held blocker when the setting is switched off", () =>
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<void>();
      const blocker = yield* makeBlockerLayer(Deferred.succeed(stopped, undefined));
      yield* Effect.gen(function* () {
        const keepAwake = yield* DesktopKeepAwake.DesktopKeepAwake;
        const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;

        yield* keepAwake.setSourceWorking("backend-a", true);
        expect(yield* keepAwake.isHolding).toBe(true);

        yield* clientSettings.set({ ...DEFAULT_CLIENT_SETTINGS, keepAwakeWhileAgentsWork: false });
        yield* Deferred.await(stopped);
        expect(yield* keepAwake.isHolding).toBe(false);
      }).pipe(
        Effect.provide(
          DesktopKeepAwake.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(blocker.layer, DesktopClientSettings.layerTest())),
          ),
        ),
      );
    }),
  );

  it.effect("stops a held blocker when its scope closes", () =>
    Effect.gen(function* () {
      const blocker = yield* makeBlockerLayer();
      yield* Effect.gen(function* () {
        const keepAwake = yield* DesktopKeepAwake.DesktopKeepAwake;
        yield* keepAwake.setSourceWorking("backend-a", true);
        expect(yield* Ref.get(blocker.calls)).toEqual({ starts: 1, stoppedIds: [] });
      }).pipe(
        Effect.provide(
          DesktopKeepAwake.layer.pipe(
            Layer.provide(Layer.mergeAll(blocker.layer, DesktopClientSettings.layerTest())),
          ),
        ),
      );
      // The layer scope closed with the provided effect; the finalizer must
      // have stopped the held blocker.
      expect(yield* Ref.get(blocker.calls)).toEqual({ starts: 1, stoppedIds: [0] });
    }),
  );
});
