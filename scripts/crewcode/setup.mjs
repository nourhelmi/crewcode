import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import {
  crewCodeProviderSettings,
  migrateCrewCodeSettings,
} from "../../apps/desktop/src/crewCodeBootstrap.ts";

export const repository = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

const providerInput = ({ home, crewBin }) => ({
  home,
  crewBin,
  executablePath: process.execPath,
  adapterPath: NodePath.join(repository, "scripts/crewcode/acp.mjs"),
});

export function providerSettings(input) {
  return crewCodeProviderSettings(providerInput(input));
}

export async function setup({
  home = process.env.CREWCODE_HOME || NodePath.join(repository, ".crewcode"),
  crewBin,
} = {}) {
  home = NodePath.resolve(home);
  const directory = NodePath.join(home, "userdata");
  const path = NodePath.join(directory, "settings.json");
  let contents;
  let existing;
  try {
    contents = await NodeFSP.readFile(path, "utf8");
    try {
      existing = JSON.parse(contents);
    } catch {
      // Preserve JSONC settings; the server owns parsing and validation.
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const savedCrew = existing?.providerInstances?.crew;
  crewBin ??=
    process.env.CREWCODE_CREW_BIN ||
    savedCrew?.environment?.find((entry) => entry.name === "CREWCODE_CREW_BIN")?.value ||
    "crew";
  if (crewBin.includes("/")) crewBin = await NodeFSP.realpath(NodePath.resolve(crewBin));
  const generated = providerSettings({ home, crewBin });
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  if (contents !== undefined) {
    const migrated = migrateCrewCodeSettings(contents, providerInput({ home, crewBin }));
    if (migrated) {
      const temporaryPath = `${path}.native-migration`;
      try {
        await NodeFSP.writeFile(temporaryPath, `${JSON.stringify(migrated, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        return { home, path, crewBin, settings: existing };
      }
      try {
        await NodeFSP.rename(temporaryPath, path);
        existing = migrated;
      } catch (error) {
        await NodeFSP.rm(temporaryPath, { force: true });
        throw error;
      }
    }
  } else {
    try {
      await NodeFSP.writeFile(path, `${JSON.stringify(generated, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      existing = generated;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  return { home, path, crewBin, settings: existing };
}

export function options(argv = process.argv.slice(2)) {
  return NodeUtil.parseArgs({
    args: argv,
    options: { home: { type: "string" }, crew: { type: "string" } },
    strict: true,
  }).values;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    const args = options();
    const configured = await setup({ home: args.home, crewBin: args.crew });
    console.log(`CrewCode configured: ${configured.path}\nStart with: pnpm crewcode`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
