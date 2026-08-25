import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export type ElectronPowerSaveBlockerType = Parameters<Electron.PowerSaveBlocker["start"]>[0];

export class ElectronPowerSaveBlocker extends Context.Service<
  ElectronPowerSaveBlocker,
  {
    readonly start: (type: ElectronPowerSaveBlockerType) => Effect.Effect<number>;
    readonly stop: (id: number) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronPowerSaveBlocker") {}

export const make = ElectronPowerSaveBlocker.of({
  start: (type) => Effect.sync(() => Electron.powerSaveBlocker.start(type)),
  stop: (id) =>
    Effect.sync(() => {
      if (Electron.powerSaveBlocker.isStarted(id)) {
        Electron.powerSaveBlocker.stop(id);
      }
    }),
});

export const layer = Layer.succeed(ElectronPowerSaveBlocker, make);
