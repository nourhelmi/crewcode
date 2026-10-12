import { AcpRegistryOperationError, ProviderInstanceId } from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  acpRegistrySnapshotReadiness,
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
} from "./driver.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry_test",
};
const noSessionManagement = {
  canList: false,
  canLoad: false,
  canResume: false,
  canLogout: false,
  canDelete: false,
  canConfigureProviders: false,
} as const;

function catalogWithInspection(
  inspection: AcpRegistrySupport.AcpRegistryInspection,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

describe("acpRegistrySnapshotReadiness", () => {
  it("treats a live empty command advertisement as an authoritative replacement", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
        documentationUrl: "https://example.test/agent/setup",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "stale" }],
        skills: [{ name: "stale-skill", path: "stale", enabled: true }],
      },
    });

    const replaced = applyAcpRegistryAvailableCommands(
      provider,
      Option.some({ slashCommands: [], skills: [] }),
    );
    expect(replaced.slashCommands).toEqual([]);
    expect(replaced.skills).toEqual([]);
    expect(applyAcpRegistryAvailableCommands(provider, Option.none()).slashCommands).toEqual([
      { name: "stale" },
    ]);
    expect(provider.iconUrl).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/test-agent.svg",
    );
    expect(provider.setup).toMatchObject({
      canAuthenticate: false,
      documentationUrl: "https://example.test/agent/setup",
    });
  });

  it("keeps authentication unknown when an agent permits a discovery session before sign-in", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [{ id: "browser", name: "Browser", description: null, type: "agent" }],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.setup?.canAuthenticate).toBe(true);
    expect(
      applyAcpRegistryLiveConfiguration(
        snapshot,
        { models: [], currentModelId: null, configOptions: [] },
        [],
      ).auth.status,
    ).toBe("unknown");
  });

  it("overlays live configuration without dropping probe-owned session capabilities", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "probe-model", name: "Probe model", description: null }],
          currentModelId: "probe-model",
          configOptions: [],
          sessionManagement: {
            canList: true,
            canLoad: true,
            canResume: true,
            canLogout: true,
            canDelete: true,
            canConfigureProviders: true,
          },
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        {
          models: [{ id: "live-model", name: "Live model", description: null }],
          currentModelId: "live-model",
          configOptions: [],
        },
        [],
      ),
    ).toMatchObject({
      auth: { status: "unknown", canLogout: true },
      nativeSessions: { canList: true, canLoad: true, canResume: true },
      models: [{ slug: "live-model", isDefault: true }],
    });
  });

  it("keeps the discovered roster and default when a Crew session narrows to one host", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ source: "local", customModels: ["custom-model"] }),
      checkedAt: "2026-10-12T20:00:00.000Z",
      inspection: { status: "ready", version: "1", distribution: "local" },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [
            { id: "codex/sol", name: "Sol", description: null },
            { id: "claude/sonnet", name: "Sonnet", description: null },
          ],
          currentModelId: "codex/sol",
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    const scoped = applyAcpRegistryLiveConfiguration(
      provider,
      {
        modelCatalogScope: "session",
        models: [
          { id: "claude/sonnet", name: "Sonnet", description: null },
          { id: "claude/opus", name: "Opus", description: null },
        ],
        currentModelId: "claude/sonnet",
        configOptions: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            currentValue: "high",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
      ["custom-model"],
    );

    expect(scoped.models.map((model) => model.slug)).toEqual([
      "codex/sol",
      "claude/sonnet",
      "custom-model",
      "claude/opus",
    ]);
    expect(scoped.models.filter((model) => model.isDefault).map((model) => model.slug)).toEqual([
      "codex/sol",
    ]);
    expect(scoped.models[0]).toBe(provider.models[0]);
    expect(scoped.models[2]).toBe(provider.models[2]);
    expect(scoped.models[1]?.capabilities.optionDescriptors).toEqual([
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [{ id: "high", label: "High" }],
      },
    ]);
    const nextSession = applyAcpRegistryLiveConfiguration(
      scoped,
      {
        modelCatalogScope: "session",
        models: [{ id: "codex/sol", name: "Sol", description: null }],
        currentModelId: "codex/sol",
        configOptions: [],
      },
      ["custom-model"],
    );
    expect(nextSession.models.map((model) => model.slug)).toEqual(
      scoped.models.map((model) => model.slug),
    );
    expect(nextSession.models[1]).toBe(scoped.models[1]);
  });

  it("does not turn a live CoS/full-access selection into another draft's defaults", () => {
    const select = (id: string, currentValue: string, values: string[]) => ({
      id,
      label: id,
      type: "select" as const,
      currentValue,
      options: values.map((value) => ({ id: value, label: value })),
    });
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ source: "local" }),
      checkedAt: "2026-10-12T20:00:00.000Z",
      inspection: { status: "ready", version: "1", distribution: "local" },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "codex/sol", name: "Sol", description: null }],
          currentModelId: "codex/sol",
          configOptions: [
            { ...select("mode", "advisor", ["advisor", "cos"]), scope: "session" },
            select("access", "default", ["default", "full"]),
            select("effort", "high", ["high", "max"]),
            select("obsolete", "old", ["old"]),
          ],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    const updated = applyAcpRegistryLiveConfiguration(
      provider,
      {
        modelCatalogScope: "session",
        models: [
          { id: "codex/sol", name: "Sol", description: null },
          { id: "codex/new", name: "New", description: null },
        ],
        currentModelId: "codex/sol",
        configOptions: [
          { ...select("mode", "cos", ["advisor", "cos"]), scope: "session" },
          select("access", "full", ["default", "full"]),
          select("effort", "max", ["high", "max", "ultra"]),
          select("obsolete", "new", ["new"]),
          {
            ...select("new-setting", "on", ["on", "off"]),
            options: [{ id: "on", label: "On", isDefault: true }],
          },
          { id: "new-toggle", label: "New toggle", type: "boolean", currentValue: true },
        ],
      },
      [],
    );
    const caps = updated.models[0]!.capabilities;
    expect(caps.optionDescriptors?.find((option) => option.id === "mode")?.scope).toBe("session");
    expect(caps.optionDescriptors?.find((option) => option.id === "effort")).toMatchObject({
      currentValue: "high",
      options: [{ id: "high" }, { id: "max" }, { id: "ultra" }],
    });
    const draftOptions = buildProviderOptionSelectionsFromDescriptors(
      getProviderOptionDescriptors({
        caps,
        selections: [{ id: "effort", value: "ultra" }],
      }),
    );
    expect(draftOptions).toEqual([
      { id: "mode", value: "advisor" },
      { id: "access", value: "default" },
      { id: "effort", value: "ultra" },
    ]);
    expect(
      buildProviderOptionSelectionsFromDescriptors(
        updated.models[1]!.capabilities.optionDescriptors,
      ),
    ).toBeUndefined();
  });

  it("maps registry inspection status to provider readiness", () => {
    expect(
      acpRegistrySnapshotReadiness({
        status: "ready",
        agentId: "gemini-cli",
        version: "1.2.3",
        distribution: "npx",
      }),
    ).toEqual({ installed: true, version: "1.2.3", status: "ready" });

    expect(
      acpRegistrySnapshotReadiness({
        status: "missing_runner",
        agentId: "gemini-cli",
        version: "1.2.3",
        distribution: "npx",
        runner: "npx",
      }),
    ).toMatchObject({ installed: false, version: "1.2.3", status: "error" });

    expect(
      acpRegistrySnapshotReadiness({
        status: "missing_runner",
        version: null,
        distribution: "local",
      }),
    ).toEqual({
      installed: false,
      version: null,
      status: "error",
      message: "Local ACP executable is not available on this environment's PATH.",
    });

    expect(
      acpRegistrySnapshotReadiness({
        status: "unprepared",
        agentId: "zed-agent",
        version: "2.0.0",
        distribution: "binary",
      }),
    ).toMatchObject({ installed: false, version: "2.0.0", status: "warning" });

    expect(
      acpRegistrySnapshotReadiness({ status: "failed", message: "Registry unavailable." }),
    ).toEqual({
      installed: false,
      version: null,
      status: "error",
      message: "Registry unavailable.",
    });
  });

  it("projects discovery without claiming authentication when no login methods are advertised", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [" custom-model ", "gpt-discovered"],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "gpt-discovered", name: "GPT Discovered", description: null }],
          currentModelId: "gpt-discovered",
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "plan", description: "Create a plan", input: { hint: "topic" } }],
        skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
      },
    });

    expect(snapshot.auth).toEqual({ status: "unknown", canLogout: false });
    expect(snapshot.supportsTextGeneration).toBe(false);
    expect(
      snapshot.models.map(({ slug, name, isCustom, isDefault }) => ({
        slug,
        name,
        isCustom,
        isDefault,
      })),
    ).toEqual([
      {
        slug: "gpt-discovered",
        name: "GPT Discovered",
        isCustom: false,
        isDefault: true,
      },
      {
        slug: "custom-model",
        name: "custom-model",
        isCustom: true,
        isDefault: undefined,
      },
    ]);
    expect(snapshot.slashCommands).toEqual([
      { name: "plan", description: "Create a plan", input: { hint: "topic" } },
    ]);
    expect(snapshot.skills).toEqual([
      { name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true },
    ]);
  });

  it("keeps a default model only when the agent advertises none", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "uvx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    expect(snapshot.models[0]?.isDefault).toBe(true);
  });

  it.each(["registry", "local"] as const)(
    "reports failed authentication after successful %s inspection",
    (source) => {
      const snapshot = buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({
          source,
          ...(source === "local" ? { commandPath: "test-agent" } : { agentId: "test-agent" }),
          authMethodId: "grok-login",
        }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: {
          status: "ready",
          agentId: "test-agent",
          version: source === "local" ? null : "1.0.0",
          distribution: source === "local" ? "local" : "binary",
        },
        probeError: new AcpRegistryOperationError({
          reason: "authentication_failed",
          message: "Login required.",
          authMethods: [
            {
              id: "api-key",
              name: "API key",
              description: null,
              type: "env_var",
            },
            {
              id: "grok-login",
              name: "Log in with Grok",
              description: null,
              type: "agent",
            },
          ],
        }),
      });

      expect(snapshot).toMatchObject({
        installed: true,
        version: source === "local" ? null : "1.0.0",
        status: "warning",
        setup: { canAuthenticate: true },
        auth: {
          status: "unauthenticated",
          type: "agent",
          label: "Log in with Grok",
        },
        message: 'Sign in in provider settings using "Log in with Grok".',
      });
    },
  );

  it.effect("runs the disposable probe only after local inspection is ready", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "test-agent" });
      const environment = { PATH: "/provider/bin" };
      let receivedEnvironment: NodeJS.ProcessEnv | undefined;
      const snapshot = yield* checkAcpRegistryProviderStatus(
        {
          ...identity,
          settings,
          cwd: "/workspace",
          environment,
        },
        (input) =>
          Effect.sync(() => {
            receivedEnvironment = input.environment;
            return {
              probe: {
                instanceId: identity.instanceId,
                ready: true as const,
                icon: null,
                authMethods: [],
                models: [{ id: "agent-model", name: "Agent Model", description: null }],
                currentModelId: "agent-model",
                configOptions: [],
                sessionManagement: noSessionManagement,
              },
              slashCommands: [{ name: "review" }],
              skills: [],
            };
          }),
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(receivedEnvironment).toBe(environment);
      expect(snapshot).toMatchObject({
        auth: { status: "unknown" },
        models: [{ slug: "agent-model" }],
        slashCommands: [{ name: "review" }],
        skills: [],
      });
    }),
  );

  it.effect("publishes concrete local readiness before background ACP discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderReadiness({
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        environment: { PATH: "/provider/bin" },
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(snapshot).toMatchObject({
        installed: true,
        status: "ready",
        version: "1.0.0",
        auth: { status: "unknown" },
        message: "Checking ACP authentication, models, and commands in the background...",
      });
    }),
  );
});
