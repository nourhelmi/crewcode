import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/** CrewCode owns its profile; never import another app's credentials or browser databases. */
export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
  }) {
    const path = yield* Path.Path;
    return path.join(input.appDataDirectory, input.isDevelopment ? "crewcode-dev" : "crewcode");
  },
);
