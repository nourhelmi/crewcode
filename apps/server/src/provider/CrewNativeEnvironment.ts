import type { OrchestrationV2CrewBinding } from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";

/** Native sessions must never borrow the Crew identity or MCP credential of their host. */
export function crewProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  crew: OrchestrationV2CrewBinding | undefined,
): NodeJS.ProcessEnv {
  if (environment.CREWCODE_NATIVE_CREW !== "1" && crew === undefined) return environment;
  const result = { ...environment };
  for (const name of [
    "CREW_RUN",
    "CREW_MAILBOX",
    "CREW_T3_STOP_OWNED",
    "CREW_T3_STOP_CONFIRMED",
    "CREW_T3_AMEND_OWNED",
    "T3_CREW_THREAD_ID",
    "T3_ACP_MCP_NODE",
    "T3_ACP_MCP_ENTRYPOINT",
    "T3_ACP_MCP_ENDPOINT",
    "T3_ACP_MCP_AUTHORIZATION",
  ])
    delete result[name];
  if (crew) {
    result.CREWCODE_NATIVE_CREW = "1";
    result.CREW_RUN = crew.runId;
    result.CREW_HOME = crew.home;
    if (crew.configPath) result.CREW_CONFIG = crew.configPath;
    else delete result.CREW_CONFIG;
    if (crew.rosterPath) result.CREW_ROSTER = crew.rosterPath;
    else delete result.CREW_ROSTER;
    if (crew.router) result.CREW_ROUTER = crew.router;
    else delete result.CREW_ROUTER;
  }
  return result;
}

/** Shell tools invoke the existing MCP client with this thread's scoped credential. */
export function crewThreadEnvironment(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly crew?: OrchestrationV2CrewBinding | undefined;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly invocation: SelfInvocation;
}): Readonly<Record<string, string>> {
  if (input.environment.CREWCODE_NATIVE_CREW !== "1" && !input.crew) return {};
  // Empty values override inherited thread/fork settings without granting a fallback identity.
  const result: Record<string, string> = {
    CREWCODE_NATIVE_CREW: "1",
    CREW_RUN: input.crew?.runId ?? "",
    CREW_MAILBOX: "",
    CREW_T3_STOP_OWNED: "",
    CREW_T3_STOP_CONFIRMED: "",
    CREW_T3_AMEND_OWNED: "",
    T3_CREW_THREAD_ID: input.mcpSession?.threadId ?? "",
    T3_ACP_MCP_NODE: input.invocation.command,
    T3_ACP_MCP_ENTRYPOINT: input.invocation.entrypoint ?? "",
    T3_ACP_MCP_ENDPOINT: input.mcpSession?.endpoint ?? "",
    T3_ACP_MCP_AUTHORIZATION: input.mcpSession?.authorizationHeader ?? "",
  };
  if (input.crew) {
    result.CREW_HOME = input.crew.home;
    result.CREW_CONFIG = input.crew.configPath ?? "";
    result.CREW_ROSTER = input.crew.rosterPath ?? "";
    result.CREW_ROUTER = input.crew.router ?? "";
  }
  return result;
}
