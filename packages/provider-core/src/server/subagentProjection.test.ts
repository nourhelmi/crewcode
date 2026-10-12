import { describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  OrchestrationV2AppThread,
  ThreadId,
  isProviderNativeSubagentThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { makeSubagentChildThread } from "./subagentProjection.ts";
import { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

const now = DateTime.makeUnsafe("2026-10-12T00:00:00.000Z");
const decodeRuntimePolicy = Schema.decodeSync(ProviderAdapterV2RuntimePolicy);
const parentThread = Schema.decodeSync(OrchestrationV2AppThread)({
  createdBy: "user",
  creationSource: "web",
  id: "parent",
  projectId: "project",
  title: "Parent",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "parent" },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  crew: { runId: "a-parent", home: "/tmp/crew" },
});
const input = {
  parentThread,
  childThreadId: ThreadId.make("child"),
  parentNodeId: NodeId.make("parent-node"),
  activeProviderThreadId: null,
  providerInstanceId: parentThread.providerInstanceId,
  modelSelection: parentThread.modelSelection,
  title: "Child",
  now,
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
};

describe("Crew native child ownership", () => {
  it("does not inherit Crew identity into ordinary or provider-native children", () => {
    expect(makeSubagentChildThread(input).crew).toBeUndefined();
    const native = makeSubagentChildThread({ ...input, creationSource: "provider" });
    expect(native.crew).toBeUndefined();
    expect(isProviderNativeSubagentThread(native)).toBe(true);
    expect(parentThread.crew?.runId).toBe("a-parent");
  });

  it("assigns only an explicit Crew binding and preserves an editable app-owned chat", () => {
    const crew = { runId: "b-child", home: "/tmp/crew", router: "off" as const };
    const child = makeSubagentChildThread({ ...input, crew });
    expect(child.crew).toEqual(crew);
    expect(isProviderNativeSubagentThread(child)).toBe(false);
    expect(child.lineage.parentThreadId).toBe(parentThread.id);
    expect(child.runtimeMode).toBe("approval-required");
    expect(
      decodeRuntimePolicy({
        runtimeMode: child.runtimeMode,
        interactionMode: child.interactionMode,
        cwd: "/tmp/work",
        crew,
      }).crew,
    ).toEqual(crew);
  });
});
