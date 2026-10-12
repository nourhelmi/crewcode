// @effect-diagnostics nodeBuiltinImport:off -- These exercise the synchronous pre-Electron startup boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, assert, it } from "@effect/vitest";

import { crewCodeProviderSettings, initializeCrewCode } from "./crewCodeBootstrap.ts";

const directories: string[] = [];
const fixture = (env: NodeJS.ProcessEnv = {}) => {
  const homeDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "crewcode-bootstrap-"));
  directories.push(homeDirectory);
  return {
    env,
    homeDirectory,
    executablePath: "/Applications/CrewCode.app/Contents/MacOS/CrewCode",
    adapterPath: "/Applications/CrewCode.app/Contents/Resources/crewcode/acp.mjs",
  };
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("first launch enables native providers and keeps the bundled Crew adapter opt-in", () => {
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
  assert.equal(settings.defaultModelSelection, null);
  assert.equal(settings.providerInstances.codex.enabled, true);
  assert.equal(settings.providerInstances.claudeAgent.enabled, true);
  assert.equal(settings.providerInstances.crew.enabled, false);
  for (const provider of [
    settings.providerInstances.codex,
    settings.providerInstances.claudeAgent,
  ]) {
    assert.deepEqual(provider.environment, [
      { name: "CREWCODE_NATIVE_CREW", value: "1", sensitive: false },
      { name: "CREWCODE_CREW_BIN", value: crew, sensitive: false },
    ]);
  }
  assert.deepEqual(settings.providerInstances.crew.config, {
    source: "local",
    commandPath: input.executablePath,
    commandArgs: [input.adapterPath],
    customModels: ["crew-auto"],
  });
  assert.deepEqual(settings.providerInstances.crew.environment, [
    { name: "CREWCODE_HOME", value: result.home, sensitive: false },
    { name: "CREWCODE_CREW_BIN", value: crew, sensitive: false },
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
  assert.equal(settings.providerInstances.crew.environment[1].value, "/custom/crew");
  assert.isFalse(NodeFS.existsSync(NodePath.join(input.homeDirectory, ".crewcode")));
});

it("accepts CREWCODE_HOME and falls back to PATH when no local Crew exists", () => {
  const input = fixture();
  input.env.T3CODE_HOME = "   ";
  input.env.CREWCODE_HOME = NodePath.join(input.homeDirectory, "custom-crew-state");
  const result = initializeCrewCode(input);
  assert.equal(result.home, input.env.CREWCODE_HOME);
  const settings = JSON.parse(NodeFS.readFileSync(result.settingsPath, "utf8"));
  assert.equal(settings.providerInstances.crew.environment[1].value, "crew");
});

const legacyProfile = (input: ReturnType<typeof fixture>) => {
  const home = NodePath.join(input.homeDirectory, ".crewcode");
  const native = crewCodeProviderSettings({ ...input, home, crewBin: "crew", electron: true });
  return {
    ...native,
    defaultModelSelection: { instanceId: "crew", model: "crew-auto" },
    providerInstances: {
      codex: { driver: "codex", enabled: false },
      claudeAgent: { driver: "claudeAgent", enabled: false },
      crew: { ...native.providerInstances.crew, enabled: true },
    },
  };
};

it("migrates the old generated profile once while preserving unrelated settings and ACP sessions", () => {
  const input = fixture();
  const result = initializeCrewCode(input);
  const legacy = {
    ...legacyProfile(input),
    defaultRuntimeMode: "approval-required",
    customSetting: { preserve: true },
    providerInstances: {
      ...legacyProfile(input).providerInstances,
      custom: { driver: "codex", enabled: true, config: { customModels: ["my-model"] } },
    },
  };
  NodeFS.writeFileSync(result.settingsPath, JSON.stringify(legacy));
  initializeCrewCode(input);
  const contents = NodeFS.readFileSync(result.settingsPath, "utf8");
  const migrated = JSON.parse(contents);
  assert.equal(migrated.defaultModelSelection, null);
  assert.equal(migrated.providerInstances.codex.enabled, true);
  assert.equal(migrated.providerInstances.claudeAgent.enabled, true);
  assert.deepEqual(migrated.providerInstances.codex.environment, [
    { name: "CREWCODE_NATIVE_CREW", value: "1", sensitive: false },
    { name: "CREWCODE_CREW_BIN", value: "crew", sensitive: false },
  ]);
  assert.deepEqual(migrated.providerInstances.crew, legacy.providerInstances.crew);
  assert.equal(migrated.defaultRuntimeMode, legacy.defaultRuntimeMode);
  assert.deepEqual(migrated.customSetting, legacy.customSetting);
  assert.deepEqual(migrated.providerInstances.custom, legacy.providerInstances.custom);
  initializeCrewCode(input);
  assert.equal(NodeFS.readFileSync(result.settingsPath, "utf8"), contents);
});

it.each([
  [
    "chosen model",
    (settings: ReturnType<typeof legacyProfile>) => {
      settings.defaultModelSelection = { instanceId: "claudeAgent", model: "chosen-model" };
    },
  ],
  [
    "native provider",
    (settings: ReturnType<typeof legacyProfile>) => {
      settings.providerInstances.codex.enabled = true;
    },
  ],
  [
    "native environment",
    (settings: ReturnType<typeof legacyProfile>) => {
      Object.assign(settings.providerInstances.codex, {
        environment: [{ name: "CUSTOM_ENV", value: "keep", sensitive: false }],
      });
    },
  ],
  [
    "adapter model",
    (settings: ReturnType<typeof legacyProfile>) => {
      settings.providerInstances.crew.config.customModels.push("custom");
    },
  ],
  [
    "adapter name",
    (settings: ReturnType<typeof legacyProfile>) => {
      settings.providerInstances.crew.displayName = "My Crew";
    },
  ],
] as const)("preserves a customized %s instead of inferring a migration", (_, customize) => {
  const input = fixture();
  const result = initializeCrewCode(input);
  const settings = legacyProfile(input);
  customize(settings);
  const contents = `${JSON.stringify(settings, null, 4)}\n`;
  NodeFS.writeFileSync(result.settingsPath, contents);
  initializeCrewCode(input);
  assert.equal(NodeFS.readFileSync(result.settingsPath, "utf8"), contents);
});
