// @effect-diagnostics nodeBuiltinImport:off
// This runs synchronously before Electron readiness and the settings service.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { crewAcpProviderSettings, migrateCrewCodeToAcpSettings } from "./crewAcpBootstrap.ts";

export function initializeCrewCode(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly executablePath: string;
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
  const settings = crewAcpProviderSettings(providerInput);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    NodeFS.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const migrated = migrateCrewCodeToAcpSettings(
      NodeFS.readFileSync(settingsPath, "utf8"),
      providerInput,
    );
    if (migrated) {
      // Startup precedes the settings service; rename prevents a partially written profile.
      const temporaryPath = `${settingsPath}.acp-migration`;
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
