import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeCrewAcpRouting } from "./crewAcp.ts";

const identity = {
  runId: "b-1",
  childSessionId: "worker-1",
  model: "codex/luna",
  state: "running",
  managed: true,
  task: "Check the parser",
  title: "Parser check",
};
describe("Crew ACP presentation", () => {
  it.effect(
    "requires a negotiated Crew capability instead of guessing from a binary or metadata",
    () =>
      Effect.gen(function* () {
        const routing = makeCrewAcpRouting();
        const notification = {
          sessionId: "root",
          update: {
            sessionUpdate: "agent_message_chunk" as const,
            content: { type: "text" as const, text: "worker output" },
            _meta: { crew: identity },
          },
        };
        assert.strictEqual(routing.normalizeSessionUpdate(notification), notification);
        yield* routing.onInitialized({
          protocolVersion: 1,
          agentInfo: { name: "other", version: "1" },
          agentCapabilities: { _meta: { crew: { version: 1 } } },
        });
        assert.strictEqual(routing.normalizeSessionUpdate(notification), notification);
        yield* routing.onInitialized({
          protocolVersion: 1,
          agentInfo: { name: "crew", version: "1" },
          agentCapabilities: { _meta: { crew: { version: 1 } } },
        });
        assert.equal(routing.normalizeSessionUpdate(notification).sessionId, "worker-1");
        assert.isTrue(routing.ownsWorkflow());
      }),
  );

  it.effect(
    "maps only lifecycle cards, preserves worker tools, and permits retained work to reopen",
    () =>
      Effect.gen(function* () {
        const routing = makeCrewAcpRouting();
        yield* routing.onInitialized({
          protocolVersion: 1,
          agentInfo: { name: "crew", version: "1" },
          agentCapabilities: { _meta: { crew: { version: 1 } } },
        });
        const tool = {
          toolCallId: "crew-worker:b-1",
          title: "worker",
          data: { meta: { crew: identity } },
        };
        assert.deepEqual(routing.extractSubagentUpdate(tool), {
          nativeTaskId: "b-1",
          childSessionId: "worker-1",
          prompt: "Check the parser",
          title: "Parser check",
          model: "codex/luna",
          status: "running",
          result: null,
          allowReopen: true,
        });
        assert.isUndefined(routing.extractSubagentUpdate({ ...tool, toolCallId: "b-1:exec-1" }));
        assert.equal(
          routing.extractSubagentUpdate({
            ...tool,
            data: { meta: { crew: { ...identity, state: "done" } } },
          })?.status,
          "completed",
        );
      }),
  );
});
