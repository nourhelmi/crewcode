import {
  EnvironmentId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-v2");
const remoteEnvironmentId = EnvironmentId.make("remote-environment-v2");
const otherProjectId = ProjectId.make("other-project");

function makeHarness(environmentIds: ReadonlyArray<EnvironmentId> = [environmentId]) {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      environmentIds.map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  return {
    registry: AtomRegistry.make(),
    snapshotAtom,
    catalogValueAtom,
    threads: createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom }),
  };
}

describe("v2 thread shell lists", () => {
  it("preserves ordered reference arrays when a middle thread changes", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const snapshot = {
      ...v2ShellSnapshot,
      threads: ["a", "b", "c"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) })),
    };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.threadRefsAtom);
    const before = registry.get(threads.threadRefsAtom);
    registry.set(
      snapshotAtom(environmentId),
      applyShellStreamEvent(snapshot, {
        kind: "thread.updated",
        location: "active",
        sequence: 1,
        thread: { ...snapshot.threads[1]!, title: "Updated" },
      }),
    );
    expect(registry.get(threads.threadRefsAtom)).toBe(before);
    dispose();
    registry.dispose();
  });

  it("keeps navigation stable on hidden subagent updates and retains user forks", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("child"),
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const fork = {
      ...child,
      id: ThreadId.make("fork"),
      lineage: { ...child.lineage, relationshipToParent: "fork" as const },
    };
    const snapshot = { ...v2ShellSnapshot, threads: [root, child, fork] };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const before = registry.get(threads.navigationThreadShellsAtom);
    expect(before.map((thread) => thread.id)).toEqual([root.id, fork.id]);
    registry.set(snapshotAtom(environmentId), {
      ...snapshot,
      threads: [root, { ...child, title: "Child streaming" }, fork],
    });
    expect(registry.get(threads.navigationThreadShellsAtom)).toBe(before);
    expect(registry.get(threads.threadShellsAtom)).toHaveLength(3);
    dispose();
    registry.dispose();
  });

  it("leaves switched-off environments out of navigation", () => {
    const { registry, threads, catalogValueAtom } = makeHarness([
      environmentId,
      remoteEnvironmentId,
    ]);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const environmentsOf = () =>
      new Set(registry.get(threads.navigationThreadShellsAtom).map((t) => t.environmentId));
    expect(environmentsOf()).toEqual(new Set([environmentId, remoteEnvironmentId]));

    const setRemoteEnabled = (enabled: boolean) => {
      const catalog = registry.get(catalogValueAtom);
      const entries = new Map(catalog.entries);
      entries.set(remoteEnvironmentId, { ...entries.get(remoteEnvironmentId)!, enabled });
      registry.set(catalogValueAtom, { ...catalog, entries });
    };
    setRemoteEnabled(false);
    expect(environmentsOf()).toEqual(new Set([environmentId]));
    setRemoteEnabled(true);
    expect(environmentsOf()).toEqual(new Set([environmentId, remoteEnvironmentId]));
    dispose();
    registry.dispose();
  });

  it("shares point and list values without retaining an atom for every listed thread", () => {
    const harness = makeHarness();
    const snapshot = {
      ...v2ShellSnapshot,
      threads: Array.from({ length: 200 }, (_, index) => ({
        ...v2ThreadShell,
        id: ThreadId.make(`thread-${index}`),
      })),
    };
    harness.registry.set(harness.snapshotAtom(environmentId), snapshot);
    const listAtom = harness.threads.threadShellsAtom;
    const projectListAtom = harness.threads.threadShellsForProjectRefsAtom([
      { environmentId, projectId: v2ThreadShell.projectId },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    const disposeProjectList = harness.registry.mount(projectListAtom);
    try {
      const before = harness.registry.get(listAtom);
      expect(before).toHaveLength(200);
      expect(harness.registry.get(projectListAtom)).toEqual(before);
      expect(harness.registry.getNodes().size).toBeLessThan(20);
      const firstAtom = harness.threads.threadShellAtom({
        environmentId,
        threadId: snapshot.threads[0]!.id,
      });
      expect(harness.registry.get(firstAtom)).toBe(before[0]);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        snapshotSequence: 1,
        threads: snapshot.threads.map((thread, index) =>
          index === 199 ? { ...thread, title: "Updated last thread" } : thread,
        ),
      });
      const after = harness.registry.get(listAtom);
      expect(after[0]).toBe(before[0]);
      expect(after.at(-1)).not.toBe(before.at(-1));
      expect(after.at(-1)?.title).toBe("Updated last thread");
      expect(harness.registry.get(projectListAtom).at(-1)).toBe(after.at(-1));
      expect(harness.registry.get(firstAtom)).toBe(after[0]);
      expect(harness.registry.getNodes().size).toBeLessThan(20);
    } finally {
      disposeProjectList();
      disposeList();
      harness.registry.dispose();
    }
  });

  it("preserves project memberships on updates and keeps the same thread separate per environment", () => {
    const harness = makeHarness([environmentId, remoteEnvironmentId]);
    const otherThread = {
      ...v2ThreadShell,
      id: ThreadId.make("other-thread"),
      projectId: otherProjectId,
    };
    const snapshot = { ...v2ShellSnapshot, threads: [v2ThreadShell, otherThread] };
    harness.registry.set(harness.snapshotAtom(environmentId), snapshot);
    const membershipAtom = harness.threads.environmentThreadRefsByProjectAtom(environmentId);
    const listAtom = harness.threads.threadShellsForProjectRefsAtom([
      { environmentId: remoteEnvironmentId, projectId: v2ThreadShell.projectId },
      { environmentId, projectId: v2ThreadShell.projectId },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    try {
      const membership = harness.registry.get(membershipAtom);
      const before = harness.registry.get(listAtom);
      expect(before).toHaveLength(2);
      expect(before[0]).not.toBe(before[1]);
      expect(before.map((thread) => thread.environmentId)).toEqual([
        remoteEnvironmentId,
        environmentId,
      ]);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [v2ThreadShell, { ...otherThread, title: "Changed elsewhere" }],
      });
      expect(harness.registry.get(membershipAtom)).toBe(membership);
      expect(harness.registry.get(listAtom)).toBe(before);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [{ ...v2ThreadShell, projectId: otherProjectId }, otherThread],
      });
      expect(harness.registry.get(listAtom)).toEqual([before[0]]);
      harness.registry.set(harness.snapshotAtom(remoteEnvironmentId), {
        ...v2ShellSnapshot,
        threads: [],
      });
      expect(harness.registry.get(listAtom)).toEqual([]);
    } finally {
      disposeList();
      harness.registry.dispose();
    }
  });
});

describe("descendant thread attention", () => {
  const request = (
    kind: NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>["kind"],
  ) => ({
    id: RuntimeRequestId.make(`request-${kind}`),
    kind,
    createdAt: v2Now,
  });
  const child = (
    id: string,
    kind: NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>["kind"] | null,
    parentId = v2ThreadShell.id,
  ): OrchestrationV2ThreadShell => ({
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title: id,
    createdBy: "agent",
    creationSource: "mcp",
    lineage: {
      ...v2ThreadShell.lineage,
      parentThreadId: parentId,
      relationshipToParent: "subagent",
    },
    pendingRuntimeRequest: kind === null ? null : request(kind),
  });

  it("surfaces app-owned descendant approvals and questions without unrelated or read-only chats", () => {
    const { registry, threads, snapshotAtom } = makeHarness([environmentId, remoteEnvironmentId]);
    const direct = child("direct", "user_input");
    const nested = child("nested", "command", direct.id);
    const native = { ...child("native", "permission"), creationSource: "provider" as const };
    const fork = child("fork", "file-change");
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [
        { ...v2ThreadShell, pendingRuntimeRequest: request("permission") },
        direct,
        nested,
        native,
        { ...fork, lineage: { ...fork.lineage, relationshipToParent: "fork" } },
        child("auth", "auth_refresh"),
        child("idle", null),
        child("other-root", "command", ThreadId.make("unrelated")),
      ],
    });
    registry.set(snapshotAtom(remoteEnvironmentId), {
      ...v2ShellSnapshot,
      threads: [child("remote", "command")],
    });
    const attention = registry.get(
      threads.childThreadAttentionAtom({ environmentId, threadId: v2ThreadShell.id }),
    );
    expect(attention.map((thread) => thread.id)).toEqual([direct.id, nested.id]);
    expect(
      attention.map((thread) => [thread.hasPendingUserInput, thread.hasPendingApprovals]),
    ).toEqual([
      [true, false],
      [false, true],
    ]);
    registry.dispose();
  });

  it("updates the indicator on request-kind changes and resolution while ignoring unrelated updates", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const question = child("child", "user_input");
    const setChild = (value: OrchestrationV2ThreadShell) =>
      registry.set(snapshotAtom(environmentId), {
        ...v2ShellSnapshot,
        threads: [v2ThreadShell, value],
      });
    setChild(question);
    const atom = threads.childThreadAttentionAtom({ environmentId, threadId: v2ThreadShell.id });
    const dispose = registry.mount(atom);
    const initial = registry.get(atom);
    setChild({ ...question, itemCount: 100 });
    expect(registry.get(atom)).toBe(initial);
    const approval = { ...question, pendingRuntimeRequest: request("file-change") };
    setChild(approval);
    const changed = registry.get(atom);
    expect(changed).not.toBe(initial);
    expect(changed[0]?.hasPendingApprovals).toBe(true);
    expect(changed[0]?.hasPendingUserInput).toBe(false);
    setChild({ ...approval, title: "New title" });
    expect(registry.get(atom)[0]?.title).toBe("New title");
    setChild({ ...approval, pendingRuntimeRequest: null });
    expect(registry.get(atom)).toEqual([]);
    dispose();
    registry.dispose();
  });

  it("visits each descendant only once when malformed lineage contains a cycle", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const descendant = child("child", "permission");
    registry.set(snapshotAtom(environmentId), {
      ...v2ShellSnapshot,
      threads: [child(v2ThreadShell.id, "command", descendant.id), descendant],
    });
    expect(
      registry
        .get(threads.childThreadAttentionAtom({ environmentId, threadId: v2ThreadShell.id }))
        .map((thread) => thread.id),
    ).toEqual([descendant.id]);
    registry.dispose();
  });
});
