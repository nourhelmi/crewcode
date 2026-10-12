// @effect-diagnostics nodeBuiltinImport:off
// This runs synchronously before Electron readiness and before any Effect services exist.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

type CrewCodeProviderInput = {
  readonly home: string;
  readonly crewBin: string;
  readonly executablePath: string;
  readonly adapterPath: string;
  readonly electron?: boolean;
};

export function crewCodeProviderSettings(input: CrewCodeProviderInput) {
  const nativeEnvironment = [
    { name: "CREWCODE_NATIVE_CREW", value: "1", sensitive: false },
    { name: "CREWCODE_CREW_BIN", value: input.crewBin, sensitive: false },
  ];
  return {
    // T3 selects an available native provider and its live catalog default.
    defaultModelSelection: null,
    providerInstances: {
      codex: { driver: "codex", enabled: true, environment: nativeEnvironment },
      claudeAgent: { driver: "claudeAgent", enabled: true, environment: nativeEnvironment },
      crew: {
        driver: "acpRegistry",
        enabled: false,
        displayName: "Crew",
        environment: [
          { name: "CREWCODE_HOME", value: input.home, sensitive: false },
          { name: "CREWCODE_CREW_BIN", value: input.crewBin, sensitive: false },
          ...(input.electron
            ? [{ name: "ELECTRON_RUN_AS_NODE", value: "1", sensitive: false }]
            : []),
        ],
        config: {
          source: "local",
          commandPath: input.executablePath,
          commandArgs: [input.adapterPath],
          customModels: ["crew-auto"],
        },
      },
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only the old generated provider signature qualifies; user choices remain untouched. */
export function migrateCrewCodeSettings(contents: string, input: CrewCodeProviderInput) {
  let saved: unknown;
  try {
    saved = JSON.parse(contents);
  } catch {
    // JSONC and malformed settings belong to the normal settings loader.
    return undefined;
  }
  if (!isRecord(saved) || !isRecord(saved.providerInstances)) return undefined;
  const providers = saved.providerInstances;
  const native = crewCodeProviderSettings(input);
  if (
    !NodeUtil.isDeepStrictEqual(saved.defaultModelSelection, {
      instanceId: "crew",
      model: "crew-auto",
    }) ||
    !NodeUtil.isDeepStrictEqual(providers.codex, { driver: "codex", enabled: false }) ||
    !NodeUtil.isDeepStrictEqual(providers.claudeAgent, { driver: "claudeAgent", enabled: false }) ||
    !NodeUtil.isDeepStrictEqual(providers.crew, { ...native.providerInstances.crew, enabled: true })
  )
    return undefined;
  return {
    ...saved,
    defaultModelSelection: null,
    providerInstances: {
      ...providers,
      codex: native.providerInstances.codex,
      claudeAgent: native.providerInstances.claudeAgent,
      // Keep existing ACP conversations usable; only new profiles start with it disabled.
    },
  };
}

export function initializeCrewCode(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly executablePath: string;
  readonly adapterPath: string;
}) {
  const home = NodePath.resolve(
    input.env.T3CODE_HOME?.trim() ||
      input.env.CREWCODE_HOME?.trim() ||
      NodePath.join(input.homeDirectory, ".crewcode"),
  );
  input.env.T3CODE_HOME = home;
  const localCrew = NodePath.join(input.homeDirectory, ".local", "bin", "crew");
  const crewBin =
    input.env.CREWCODE_CREW_BIN?.trim() || (NodeFS.existsSync(localCrew) ? localCrew : "crew");
  const directory = NodePath.join(home, "userdata");
  const settingsPath = NodePath.join(directory, "settings.json");
  const providerInput = { ...input, home, crewBin, electron: true };
  const settings = crewCodeProviderSettings(providerInput);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    NodeFS.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const migrated = migrateCrewCodeSettings(
      NodeFS.readFileSync(settingsPath, "utf8"),
      providerInput,
    );
    if (migrated) {
      // Startup precedes the settings service; rename prevents a partially written profile.
      const temporaryPath = `${settingsPath}.native-migration`;
      try {
        NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(migrated, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        return { home, settingsPath };
      }
      try {
        NodeFS.renameSync(temporaryPath, settingsPath);
      } catch (renameError) {
        NodeFS.rmSync(temporaryPath, { force: true });
        throw renameError;
      }
    }
  }
  return { home, settingsPath };
}
