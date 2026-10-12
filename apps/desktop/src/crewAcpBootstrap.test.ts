import { assert, it } from "@effect/vitest";
import { crewAcpProviderSettings, migrateCrewCodeToAcpSettings } from "./crewAcpBootstrap.ts";

const input = {
  crewBin: "/Users/test/.local/bin/crew",
  executablePath: "/Applications/CrewCode.app/Contents/MacOS/CrewCode",
  electron: true,
};
const legacy = () => ({
  defaultModelSelection: null,
  defaultRuntimeMode: "approval-required",
  providerInstances: {
    codex: {
      driver: "codex",
      enabled: true,
      environment: [
        { name: "CREWCODE_NATIVE_CREW", value: "1", sensitive: false },
        { name: "CREWCODE_CREW_BIN", value: input.crewBin, sensitive: false },
        { name: "USER_SETTING", value: "keep", sensitive: false },
      ],
    },
    claudeAgent: { driver: "claudeAgent", enabled: true },
    crew: {
      driver: "acpRegistry",
      enabled: false,
      displayName: "My Crew",
      environment: [{ name: "CREWCODE_CREW_BIN", value: input.crewBin, sensitive: false }],
      config: {
        source: "local",
        commandPath: input.executablePath,
        commandArgs: ["/resources/crewcode/acp.mjs"],
        customModels: ["crew-auto"],
      },
    },
  },
});

it("configures the generic CLI without a bundled protocol implementation", () => {
  const settings = crewAcpProviderSettings(input);
  assert.deepEqual(settings.defaultModelSelection, { instanceId: "crew", model: "default" });
  assert.deepEqual(settings.providerInstances.crew.config, {
    source: "local",
    commandPath: input.crewBin,
    commandArgs: ["acp"],
    customModels: [],
  });
  assert.deepEqual(settings.providerInstances.codex, { driver: "codex", enabled: true });
  assert.deepEqual(settings.providerInstances.claudeAgent, {
    driver: "claudeAgent",
    enabled: true,
  });
  assert.isFalse(JSON.stringify(settings).includes("CREWCODE_NATIVE_CREW"));
});

it("migrates the generated bridge and preserves unrelated environment and permission choices", () => {
  const result = migrateCrewCodeToAcpSettings(JSON.stringify(legacy()), input)!;
  const providers = result.providerInstances as ReturnType<typeof legacy>["providerInstances"];
  assert.deepEqual(result.defaultModelSelection, { instanceId: "crew", model: "default" });
  assert.equal(Reflect.get(result, "defaultRuntimeMode"), "approval-required");
  assert.equal(providers.crew.displayName, "My Crew");
  assert.deepEqual(providers.crew.config.commandArgs, ["acp"]);
  assert.isTrue(providers.crew.enabled);
  assert.deepEqual(providers.codex.environment, [
    { name: "USER_SETTING", value: "keep", sensitive: false },
  ]);
  assert.isUndefined(migrateCrewCodeToAcpSettings(JSON.stringify(result), input));
});

it("preserves a chosen lead and custom ACP commands, and leaves JSONC to its parser", () => {
  const profile = {
    ...legacy(),
    defaultModelSelection: { instanceId: "claudeAgent", model: "chosen" },
  };
  profile.providerInstances.crew.config.commandArgs = ["/custom/adapter.mjs"];
  const result = migrateCrewCodeToAcpSettings(JSON.stringify(profile), input)!;
  assert.deepEqual(result.defaultModelSelection, profile.defaultModelSelection);
  assert.deepEqual(result.providerInstances.crew, profile.providerInstances.crew);
  assert.isUndefined(migrateCrewCodeToAcpSettings("{ // user settings\n}", input));
});
