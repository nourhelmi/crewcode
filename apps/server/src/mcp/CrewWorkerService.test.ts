import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  NodeId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CrewNativeControl from "../provider/CrewNativeControl.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as CrewWorker from "./CrewWorkerService.ts";

const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crew-worker-" });
  const parentId = ThreadId.make("thread:parent");
  const creationCommand = CommandId.make(
    `command:crew:start:${encodeURIComponent(parentId)}:worker`,
  );
  const childId = IdAllocator.derive.delegatedTaskThread({ commandId: creationCommand });
  const taskId = IdAllocator.derive.delegatedTaskNode({ commandId: creationCommand });
  const providerThreadId = ProviderThreadId.make("provider-thread:parent");
  const providerSessionId = ProviderSessionId.make("provider-session:parent");
  const parent = idleThreadProjection(liveThreadShell(parentId));
  const active = {
    id: RunId.make("run:parent"),
    ordinal: 1,
    rootNodeId: NodeId.make("node:parent"),
    status: "running",
    providerThreadId,
    providerInstanceId: parent.thread.providerInstanceId,
  } as const;
  let liveParent = {
    ...parent,
    thread: { ...parent.thread, activeProviderThreadId: providerThreadId },
    runs: [active],
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId,
        driver: "codex",
        nativeThreadRef: { nativeId: "native-parent" },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  let child: OrchestrationV2ThreadProjection | null = null;
  const commands: OrchestrationV2ServerCommand[] = [];
  const calls: string[] = [];
  let meta = {
    id: "worker",
    name: "worker",
    role: "builder",
    launcher: "t3",
    cwd: home,
    state: "running",
    parent: { mailbox: "codex-native-parent" },
    route: { host: "codex", model: "gpt-test", effort: "high" },
    launch: { env: { CREW_ROUTER: "off" } },
  };
  yield* fs.makeDirectory(path.join(home, "runs", "worker"), { recursive: true });
  const write = (patch = {}) => {
    meta = { ...meta, ...patch };
    return fs.writeFileString(path.join(home, "runs", "worker", "meta.json"), JSON.stringify(meta));
  };
  yield* write();
  yield* fs.writeFileString(
    path.join(home, "runs", "worker", "brief.md"),
    "Read the packet and run crew inbox before work.",
  );
  let afterStart: Effect.Effect<void, never> = Effect.void;
  let delayedStop = false;
  const quiet = () => {
    if (child) child = { ...child, runs: [], runtimeRequests: [], providerThreads: [] };
  };
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:test"),
    requestNamespace: "token:first",
    thread: {
      threadId: parentId,
      providerSessionId: "mcp-credential-separate-from-runtime",
      providerInstanceId: parent.thread.providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HostProcess.Environment, { CREW_HOME: home, CREW_ROUTER: "on" }),
    Layer.succeed(HostProcess.HomeDirectory, home),
    ServerSettings.layerTest(),
    Layer.mock(McpProviderSessions.McpProviderSessions)({
      read: () =>
        Effect.succeed({
          providerSessionId: "mcp-credential-separate-from-runtime",
          providerInstanceId: parent.thread.providerInstanceId,
        } as never),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome({ workspaceRoot: home } as never),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      capabilities: () =>
        Effect.succeed({
          providers: [
            {
              providerInstanceId: parent.thread.providerInstanceId,
              driverKind: "codex",
              canRunChildTask: true,
              runtimeModes: ["full-access"],
              models: [
                {
                  id: "gpt-test",
                  options: [{ id: "reasoningEffort", type: "select", options: [{ id: "high" }] }],
                },
              ],
            },
          ],
        } as never),
    }),
    Layer.mock(CrewNativeControl.CrewNativeControl)({
      confirmStopped: () =>
        Effect.sync(() => {
          calls.push("confirmed");
        }).pipe(Effect.andThen(write({ state: "stopped", t3Stopped: true })), Effect.orDie),
      retire: () => {
        calls.push("retire");
        return write({ state: "stopped" }).pipe(Effect.orDie);
      },
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: (id) => Effect.succeed(id === parentId ? liveParent : child!),
      getThreadShell: () =>
        Effect.succeed(child ? { ...liveThreadShell(child.thread.id), ...child.thread } : null),
      getThreadEventSequence: () => Effect.succeed(7),
      stopDelegatedTasks: () =>
        Effect.sync(() => {
          calls.push("cascade");
        }),
      streamStoredEventsFrom: () =>
        Stream.fromEffect(
          Effect.sync(() => {
            calls.push("persisted-stop");
            quiet();
            return {} as never;
          }),
        ),
      dispatch: (command) =>
        Effect.gen(function* () {
          commands.push(command);
          if (command.type === "delegated_task.request") {
            child = {
              ...idleThreadProjection(liveThreadShell(childId)),
              thread: {
                ...idleThreadProjection(liveThreadShell(childId)).thread,
                crew: command.crew,
                lineage: {
                  rootThreadId: parentId,
                  parentThreadId: parentId,
                  relationshipToParent: "subagent",
                },
              },
            };
            yield* afterStart;
          }
          if (command.type === "thread.stop") {
            calls.push("stop");
            if (!delayedStop) quiet();
          }
          return { sequence: 1, storedEvents: [] } as never;
        }),
    }),
  );
  const execute = (input: typeof CrewWorker.CrewWorkerInput.Type, caller = scope) =>
    Effect.flatMap(CrewWorker.CrewWorkerService, (service) => service.execute(caller, input)).pipe(
      Effect.provide(CrewWorker.layer.pipe(Layer.provide(dependencies))),
    );
  return {
    home,
    parentId,
    childId,
    taskId,
    scope,
    commands,
    calls,
    write,
    execute,
    onStart: (effect: Effect.Effect<void, never>) => {
      afterStart = effect;
    },
    corrupt: fs
      .writeFileString(path.join(home, "runs", "worker", "meta.json"), "{")
      .pipe(Effect.orDie),
    idleParent: () => {
      liveParent = { ...liveParent, runs: [] };
    },
    delayStop: () => {
      delayedStop = true;
      if (child) child = { ...child, runs: [{ ...active, id: RunId.make("run:child") }] as never };
    },
  };
});

describe("native Crew workers", () => {
  it.effect(
    "starts once across bridge credential rotation, preserving router, model, and permissions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const first = yield* f.execute({ action: "start", runId: "worker", requestId: "one" });
          const second = yield* f.execute(
            { action: "start", runId: "worker", requestId: "two" },
            { ...f.scope, requestNamespace: "token:rotated" },
          );
          assert.deepEqual(first, second);
          assert.strictEqual(f.commands.length, 1);
          const command = f.commands[0]!;
          assert.strictEqual(command.type, "delegated_task.request");
          if (command.type !== "delegated_task.request") return;
          assert.strictEqual(command.crew?.router, "off");
          assert.strictEqual(command.runtimeMode, "full-access");
          assert.strictEqual(command.completionWake, "none");
          assert.deepEqual(command.modelSelection.options, [
            { id: "reasoningEffort", value: "high" },
          ]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    ["foreign ownership", { parent: { mailbox: "codex-foreign" } }],
    ["foreign workspace", { cwd: "/private/tmp" }],
    ["unsupported model", { route: { host: "codex", model: "unknown", effort: "high" } }],
    ["stopped run", { state: "stopped" }],
  ] as const)("refuses %s before any native dispatch", ([_name, patch]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write(patch);
        const error = yield* f.execute({ action: "start", runId: "worker" }).pipe(Effect.flip);
        assert.strictEqual("code" in error && error.code, "invalid_request");
        assert.strictEqual(f.commands.length, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "uses the same resume identity after token rotation and requests atomic idle-only dispatch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.execute({ action: "start", runId: "worker" });
          yield* f.execute({ action: "resume", runId: "worker", requestId: "mail-1" });
          yield* f.execute(
            { action: "resume", runId: "worker", requestId: "mail-1" },
            { ...f.scope, requestNamespace: "rotated" },
          );
          assert.deepEqual(f.commands[1], f.commands[2]);
          assert.strictEqual(f.commands[1]?.type, "message.dispatch");
          if (f.commands[1]?.type === "message.dispatch")
            assert.strictEqual(f.commands[1].crewResume, true);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.each([false, true])(
    "cancels a native launch when metadata changes during dispatch (corrupt=%s)",
    (corruption) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          f.onStart(corruption ? f.corrupt : f.write({ state: "stopped" }).pipe(Effect.orDie));
          yield* f.execute({ action: "start", runId: "worker" }).pipe(Effect.flip);
          assert.deepEqual(f.calls, ["stop", "cascade", "stop"]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("does not report a metadata-only fence as confirmed native subtree shutdown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.execute({ action: "start", runId: "worker" });
        yield* f.write({ state: "stopped" });
        assert.notStrictEqual(
          (yield* f.execute({ action: "status", runId: "worker" })).state,
          "stopped",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("confirms persisted native shutdown before returning stopped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.execute({ action: "start", runId: "worker" });
        f.delayStop();
        const result = yield* f.execute({ action: "stop", runId: "worker" });
        assert.strictEqual(result.state, "stopped");
        assert.deepEqual(f.calls.slice(0, 3), ["retire", "stop", "cascade"]);
        assert.include(f.calls, "persisted-stop");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("supports retained status/resume/stop while the owning native thread is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.execute({ action: "start", runId: "worker" });
        f.idleParent();
        assert.strictEqual((yield* f.execute({ action: "status", runId: "worker" })).state, "idle");
        yield* f.execute({ action: "resume", runId: "worker", requestId: "idle-mail" });
        assert.strictEqual(
          (yield* f.execute({ action: "stop", runId: "worker" })).state,
          "stopped",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("refuses idle new delegation and stale MCP credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f
          .execute(
            { action: "start", runId: "worker" },
            { ...f.scope, thread: { ...f.scope.thread!, providerSessionId: "stale-credential" } },
          )
          .pipe(Effect.flip);
        f.idleParent();
        yield* f.execute({ action: "start", runId: "worker" }).pipe(Effect.flip);
        assert.strictEqual(f.commands.length, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("fences reserved workers that never created a native child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* f.execute({ action: "stop", runId: "worker" });
        assert.deepEqual(result, {
          runId: "worker",
          threadId: f.childId,
          taskId: f.taskId,
          state: "stopped",
        });
        assert.deepEqual(f.calls, ["retire", "confirmed"]);
        assert.strictEqual(f.commands.length, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
