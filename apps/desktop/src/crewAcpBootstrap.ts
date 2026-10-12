// @effect-diagnostics nodeBuiltinImport:off
// Configuration only: the generic ACP implementation belongs to Crew.
export interface CrewAcpProviderInput {
  readonly crewBin: string;
  readonly executablePath: string;
  readonly electron?: boolean;
}

export function crewAcpProviderSettings(input: CrewAcpProviderInput) {
  return {
    defaultModelSelection: { instanceId: "crew", model: "default" },
    providerInstances: {
      codex: { driver: "codex", enabled: true },
      claudeAgent: { driver: "claudeAgent", enabled: true },
      crew: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Crew",
        environment: [
          { name: "CREW_NODE", value: input.executablePath, sensitive: false },
          ...(input.electron
            ? [{ name: "ELECTRON_RUN_AS_NODE", value: "1", sensitive: false }]
            : []),
        ],
        config: {
          source: "local",
          commandPath: input.crewBin,
          commandArgs: ["acp"],
          customModels: [],
        },
      },
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Preserve user provider choices while retiring generated bridge-only settings. */
export function migrateCrewCodeToAcpSettings(contents: string, input: CrewAcpProviderInput) {
  let saved: unknown;
  try {
    saved = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (!isRecord(saved) || !isRecord(saved.providerInstances)) return undefined;
  const providers = { ...saved.providerInstances };
  const generated = crewAcpProviderSettings(input);
  const crew = providers.crew;
  let migratedBridge = false;
  if (isRecord(crew) && crew.driver === "acpRegistry" && isRecord(crew.config)) {
    const args = crew.config.commandArgs;
    const models = crew.config.customModels;
    if (
      crew.config.source === "local" &&
      Array.isArray(args) &&
      args.length === 1 &&
      typeof args[0] === "string" &&
      /(?:^|[/\\])acp\.mjs$/.test(args[0]) &&
      Array.isArray(models) &&
      models.length === 1 &&
      models[0] === "crew-auto"
    ) {
      const environment = Array.isArray(crew.environment)
        ? crew.environment.filter(
            (entry) =>
              !isRecord(entry) ||
              !["CREWCODE_HOME", "CREWCODE_CREW_BIN", "ELECTRON_RUN_AS_NODE", "CREW_NODE"].includes(
                String(entry.name),
              ),
          )
        : [];
      providers.crew = {
        ...crew,
        enabled: true,
        environment: [...environment, ...generated.providerInstances.crew.environment],
        config: { ...crew.config, ...generated.providerInstances.crew.config },
      };
      migratedBridge = true;
    }
  }
  let changed = migratedBridge;
  for (const id of ["codex", "claudeAgent"]) {
    const provider = providers[id];
    if (!isRecord(provider) || !Array.isArray(provider.environment)) continue;
    const injected = provider.environment.some(
      (entry) => isRecord(entry) && entry.name === "CREWCODE_NATIVE_CREW" && entry.value === "1",
    );
    if (!injected) continue;
    const environment = provider.environment.filter(
      (entry) =>
        !isRecord(entry) ||
        !["CREWCODE_NATIVE_CREW", "CREWCODE_CREW_BIN"].includes(String(entry.name)),
    );
    providers[id] = { ...provider, environment };
    changed = true;
  }
  if (!changed) return undefined;
  const selection = saved.defaultModelSelection;
  const defaultModelSelection =
    migratedBridge &&
    (selection == null ||
      (isRecord(selection) && selection.instanceId === "crew" && selection.model === "crew-auto"))
      ? generated.defaultModelSelection
      : selection;
  return { ...saved, defaultModelSelection, providerInstances: providers };
}
