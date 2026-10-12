// @effect-diagnostics nodeBuiltinImport:off -- These exercise the synchronous pre-Electron startup boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, assert, it } from "@effect/vitest";

import { initializeCrewCode } from "./crewCodeBootstrap.ts";

const directories: string[] = [];
const fixture = (env: NodeJS.ProcessEnv = {}) => {
  const homeDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "crewcode-bootstrap-"));
  directories.push(homeDirectory);
  return {
    env,
    homeDirectory,
    executablePath: "/Applications/CrewCode.app/Contents/MacOS/CrewCode",
  };
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("first launch enables Crew ACP and native providers in its isolated app profile", () => {
  const input = fixture();
  const t3 = NodePath.join(input.homeDirectory, ".t3", "userdata");
  NodeFS.mkdirSync(t3, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(t3, "settings.json"), "unrelated T3 settings");
  const crew = NodePath.join(input.homeDirectory, ".local", "bin", "crew");
  NodeFS.mkdirSync(NodePath.dirname(crew), { recursive: true });
  NodeFS.writeFileSync(crew, "stub");

  const result = initializeCrewCode(input);
  assert.equal(result.home, NodePath.join(input.homeDirectory, ".crewcode"));
  assert.equal(input.env.T3CODE_HOME, result.home);
  const settings = JSON.parse(NodeFS.readFileSync(result.settingsPath, "utf8"));
  assert.deepEqual(settings.defaultModelSelection, { instanceId: "crew", model: "default" });
  assert.equal(settings.providerInstances.codex.enabled, true);
  assert.equal(settings.providerInstances.claudeAgent.enabled, true);
  assert.equal(settings.providerInstances.crew.enabled, true);
  assert.equal(settings.providerInstances.codex.environment, undefined);
  assert.equal(settings.providerInstances.claudeAgent.environment, undefined);
  assert.deepEqual(settings.providerInstances.crew.config, {
    source: "local",
    commandPath: crew,
    commandArgs: ["acp"],
    customModels: [],
  });
  assert.deepEqual(settings.providerInstances.crew.environment, [
    { name: "CREW_NODE", value: input.executablePath, sensitive: false },
    { name: "ELECTRON_RUN_AS_NODE", value: "1", sensitive: false },
  ]);
  assert.equal(
    NodeFS.readFileSync(NodePath.join(t3, "settings.json"), "utf8"),
    "unrelated T3 settings",
  );
  if (HostProcess.Platform.defaultValue() !== "win32") {
    assert.equal(NodeFS.statSync(result.settingsPath).mode & 0o777, 0o600);
    assert.equal(NodeFS.statSync(NodePath.dirname(result.settingsPath)).mode & 0o777, 0o700);
  }
});

it("preserves user settings byte for byte across relaunches", () => {
  const input = fixture();
  const result = initializeCrewCode(input);
  const customized = '{\n  // User configuration may be JSONC.\n  "providerInstances": {}\n}\n';
  NodeFS.writeFileSync(result.settingsPath, customized);
  initializeCrewCode({ ...input, executablePath: "/Applications/Another location/CrewCode" });
  assert.equal(NodeFS.readFileSync(result.settingsPath, "utf8"), customized);
});

it("honors the explicit backend home and Crew executable", () => {
  const input = fixture();
  const override = NodePath.join(input.homeDirectory, "custom-state");
  input.env.T3CODE_HOME = ` ${override} `;
  input.env.CREWCODE_HOME = NodePath.join(input.homeDirectory, "lower-priority-home");
  input.env.CREWCODE_CREW_BIN = "/custom/crew";
  const result = initializeCrewCode(input);
  assert.equal(result.home, override);
  assert.equal(input.env.T3CODE_HOME, override);
  const settings = JSON.parse(NodeFS.readFileSync(result.settingsPath, "utf8"));
  assert.equal(settings.providerInstances.crew.config.commandPath, "/custom/crew");
  assert.isFalse(NodeFS.existsSync(NodePath.join(input.homeDirectory, ".crewcode")));
});

it("accepts CREWCODE_HOME and falls back to PATH when no local Crew exists", () => {
  const input = fixture();
  input.env.T3CODE_HOME = "   ";
  input.env.CREWCODE_HOME = NodePath.join(input.homeDirectory, "custom-crew-state");
  const result = initializeCrewCode(input);
  assert.equal(result.home, input.env.CREWCODE_HOME);
  const settings = JSON.parse(NodeFS.readFileSync(result.settingsPath, "utf8"));
  assert.equal(settings.providerInstances.crew.config.commandPath, "crew");
});
