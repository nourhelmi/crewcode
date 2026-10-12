// @effect-diagnostics nodeBuiltinImport:off
// Packaged app entry: choose the fork's state before any main-process services load.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { initializeCrewCode } from "./crewCodeBootstrap.ts";

initializeCrewCode({
  env: process.env,
  homeDirectory: NodeOS.homedir(),
  executablePath: process.execPath,
  adapterPath: NodeFS.realpathSync(
    process.defaultApp
      ? NodePath.resolve(__dirname, "../../../scripts/crewcode/acp.mjs")
      : NodePath.join(process.resourcesPath, "crewcode", "acp.mjs"),
  ),
});

// Enable the compile cache before loading the main bundle so it covers main.cjs too.
require("./compileCache.cjs");
require("./main.cjs");
