// @effect-diagnostics nodeBuiltinImport:off
// This runs synchronously before Electron readiness and before any Effect services exist.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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
  const settings = {
    defaultModelSelection: { instanceId: "crew", model: "crew-auto" },
    providerInstances: {
      codex: { driver: "codex", enabled: false },
      claudeAgent: { driver: "claudeAgent", enabled: false },
      crew: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Crew",
        environment: [
          { name: "CREWCODE_HOME", value: home, sensitive: false },
          { name: "CREWCODE_CREW_BIN", value: crewBin, sensitive: false },
          { name: "ELECTRON_RUN_AS_NODE", value: "1", sensitive: false },
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
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    NodeFS.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    // Provider settings belong to the user after the first launch, including JSONC edits.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { home, settingsPath };
}
