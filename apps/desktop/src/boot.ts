// @effect-diagnostics nodeBuiltinImport:off
// Packaged app entry: choose the fork's state before any main-process services load.
import * as NodeOS from "node:os";
import { initializeCrewCode } from "./crewCodeBootstrap.ts";

initializeCrewCode({
  env: process.env,
  homeDirectory: NodeOS.homedir(),
  executablePath: process.execPath,
});

// Enable the compile cache before loading the main bundle so it covers main.cjs too.
require("./compileCache.cjs");
require("./main.cjs");
