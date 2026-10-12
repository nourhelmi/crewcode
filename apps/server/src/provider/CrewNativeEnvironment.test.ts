import { describe, it, expect } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { crewProcessEnvironment, crewThreadEnvironment } from "./CrewNativeEnvironment.ts";

const invocation = { command: "/app/electron", entrypoint: "/app/bin.mjs" };
const environment = {
  CREWCODE_NATIVE_CREW: "1",
  CREW_RUN: "inherited",
  CREW_MAILBOX: "foreign",
  T3_ACP_MCP_AUTHORIZATION: "foreign",
  PATH: "/bin",
};
const crew = { runId: "worker-a", home: "/private/crew-a", rosterPath: "/private/roster-a" };
const session = (id: string) => ({
  environmentId: EnvironmentId.make("test"),
  threadId: ThreadId.make(id),
  providerSessionId: id,
  providerInstanceId: ProviderInstanceId.make("codex"),
  endpoint: "http://localhost/mcp",
  authorizationHeader: `Bearer ${id}`,
  browserToolsAvailable: false,
});

describe("native Crew environment isolation", () => {
  it("clears inherited identity and credentials before sharing a Codex process", () => {
    const root = crewProcessEnvironment(environment, undefined);
    expect(root.CREW_RUN).toBeUndefined();
    expect(root.CREW_MAILBOX).toBeUndefined();
    expect(root.T3_ACP_MCP_AUTHORIZATION).toBeUndefined();
    expect(root.PATH).toBe("/bin");
    expect(environment.CREW_RUN).toBe("inherited");
    const child = crewProcessEnvironment(
      { ...environment, CREW_CONFIG: "/foreign/config", CREW_ROUTER: "on" },
      crew,
    );
    expect(child.CREW_RUN).toBe("worker-a");
    expect(child.CREW_HOME).toBe("/private/crew-a");
    expect(child.CREW_ROSTER).toBe("/private/roster-a");
    expect(child.CREW_CONFIG).toBeUndefined();
    expect(child.CREW_ROUTER).toBeUndefined();
    expect(child.T3_ACP_MCP_AUTHORIZATION).toBeUndefined();
  });

  it("binds each shell to its own thread and clears a forked worker identity", () => {
    const a = crewThreadEnvironment({ environment, crew, mcpSession: session("a"), invocation });
    const b = crewThreadEnvironment({ environment, mcpSession: session("b"), invocation });
    expect(a.T3_ACP_MCP_AUTHORIZATION).toBe("Bearer a");
    expect(b.T3_ACP_MCP_AUTHORIZATION).toBe("Bearer b");
    expect(a.CREW_RUN).toBe("worker-a");
    expect(b.CREW_RUN).toBe("");
    const unavailable = crewThreadEnvironment({
      environment,
      crew,
      mcpSession: undefined,
      invocation: { command: "/app/t3", entrypoint: undefined },
    });
    expect(unavailable.T3_ACP_MCP_AUTHORIZATION).toBe("");
    expect(unavailable.T3_ACP_MCP_ENDPOINT).toBe("");
    expect(unavailable.T3_ACP_MCP_ENTRYPOINT).toBe("");
  });

  it("does not change unconfigured providers", () => {
    expect(crewProcessEnvironment({ CUSTOM: "value" }, undefined)).toEqual({ CUSTOM: "value" });
    expect(
      crewThreadEnvironment({ environment: {}, mcpSession: session("a"), invocation }),
    ).toEqual({});
  });
});
