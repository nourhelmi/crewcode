import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["darwin", "win32", "linux"] as const)(
  "keeps the %s profile separate from existing T3 Code state without migration",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "crewcode-profile-" });
      for (const name of ["t3code", "t3code-v2", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
        yield* fs.makeDirectory(path.join(directory, name));
        yield* fs.writeFileString(path.join(directory, name, "Local State"), "unrelated keys");
      }
      for (const isDevelopment of [false, true]) {
        const destination = yield* resolveUserDataPath({
          appDataDirectory: directory,
          isDevelopment,
          platform,
        });
        assert.equal(
          destination,
          path.join(directory, isDevelopment ? "crewcode-dev" : "crewcode"),
        );
        assert.isFalse(yield* fs.exists(destination));
      }
      assert.equal(
        yield* fs.readFileString(path.join(directory, "T3 Code (Alpha)", "Local State")),
        "unrelated keys",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
