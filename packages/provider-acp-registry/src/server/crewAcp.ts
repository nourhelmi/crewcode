import * as Effect from "effect/Effect";
import type * as AcpSchema from "effect-acp/compat";
import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function worker(meta: unknown) {
  const value = record(record(meta)?.crew);
  if (
    typeof value?.runId !== "string" ||
    !value.runId ||
    typeof value.childSessionId !== "string" ||
    !value.childSessionId
  )
    return undefined;
  return value as Record<string, unknown> & { runId: string; childSessionId: string };
}

/** Optional presentation only. Crew still speaks standard root-session ACP to other clients. */
export function makeCrewAcpRouting() {
  let enabled = false;
  return {
    onInitialized: (result: AcpSchema.InitializeResponse) =>
      Effect.sync(() => {
        enabled =
          result.agentInfo?.name === "crew" &&
          record(record(result.agentCapabilities?._meta)?.crew)?.version === 1;
      }),
    ownsWorkflow: () => enabled,
    normalizeSessionUpdate: (
      notification: AcpSchema.SessionNotification,
    ): AcpSchema.SessionNotification => {
      if (!enabled) return notification;
      const update = notification.update;
      const identity = worker("_meta" in update ? update._meta : undefined);
      if (identity === undefined) return notification;
      // Lifecycle cards belong to the parent. Native text/tools belong to the
      // existing read-only child, without introducing an ACP child prompt.
      if (
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
        update.toolCallId === `crew-worker:${identity.runId}`
      )
        return notification;
      return {
        ...notification,
        sessionId: identity.childSessionId,
        update:
          (update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "agent_thought_chunk") &&
          typeof identity.eventId === "string"
            ? { ...update, messageId: identity.eventId }
            : update,
      };
    },
    extractSubagentUpdate: (tool: AcpToolCallState): AcpAdapterV2SubagentUpdate | undefined => {
      if (!enabled) return undefined;
      const identity = worker(tool.data.meta);
      if (identity === undefined || tool.toolCallId !== `crew-worker:${identity.runId}`)
        return undefined;
      const state = identity.state;
      return {
        nativeTaskId: identity.runId,
        childSessionId: identity.childSessionId,
        prompt: typeof identity.task === "string" ? identity.task : "",
        title: typeof identity.title === "string" ? identity.title : (tool.title ?? identity.runId),
        model: typeof identity.model === "string" ? identity.model : null,
        status:
          state === "done" || state === "idle"
            ? "completed"
            : state === "stopped"
              ? "interrupted"
              : state === "failed"
                ? "failed"
                : "running",
        result: null,
        allowReopen: identity.managed === true,
      };
    },
  };
}
