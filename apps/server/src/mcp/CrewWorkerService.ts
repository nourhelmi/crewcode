import {
  CommandId,
  MessageId,
  NodeId,
  OrchestratorMcpFailure,
  type OrchestrationV2CrewBinding,
  type ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as CrewNativeControl from "../provider/CrewNativeControl.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { requireThreadScope, type McpInvocationScope } from "./McpInvocationContext.ts";
import { assertTargetWithinLimits, dispatchFailure, unavailable } from "./threadAccess.ts";

const CrewRunId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,160}$/));
export const CrewWorkerInput = Schema.Struct({
  action: Schema.Literals(["start", "status", "resume", "stop"]),
  runId: CrewRunId,
  requestId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
});
export const CrewWorkerResult = Schema.Struct({
  runId: CrewRunId,
  threadId: ThreadId,
  taskId: NodeId,
  state: Schema.Literals([
    "starting",
    "running",
    "waiting",
    "idle",
    "interrupted",
    "failed",
    "stopped",
  ]),
  nativeSessionId: Schema.optional(Schema.String),
});
const CrewRun = Schema.Struct({
  id: CrewRunId,
  name: Schema.String,
  role: Schema.String,
  launcher: Schema.Literal("t3"),
  cwd: Schema.String,
  state: Schema.String,
  turn: Schema.optional(Schema.Number),
  t3Stopped: Schema.optional(Schema.Boolean),
  parent: Schema.Struct({ mailbox: Schema.String }),
  route: Schema.Struct({
    host: Schema.Literals(["codex", "claude"]),
    model: Schema.String,
    effort: Schema.String,
  }),
  t3: Schema.optional(Schema.Struct({ threadId: ThreadId, taskId: NodeId })),
  launch: Schema.optional(Schema.Struct({ env: Schema.Record(Schema.String, Schema.String) })),
});
type CrewRun = typeof CrewRun.Type;
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(CrewRun));

export class CrewWorkerService extends Context.Service<
  CrewWorkerService,
  {
    readonly execute: (
      scope: McpInvocationScope,
      input: typeof CrewWorkerInput.Type,
    ) => Effect.Effect<typeof CrewWorkerResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/mcp/CrewWorkerService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const hash = (value: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(value))
      .pipe(Effect.map(Hex.encode), Effect.mapError(unavailable));
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const userHome = yield* HostProcess.HomeDirectory;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const orchestration = yield* OrchestratorMcpService.OrchestratorMcpService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const crewControl = yield* CrewNativeControl.CrewNativeControl;
  const refusal = (message: string) =>
    new OrchestratorMcpFailure({ code: "invalid_request", message });
  const commandFor = (parent: ThreadId, runId: string) =>
    CommandId.make(`command:crew:start:${encodeURIComponent(parent)}:${runId}`);
  const readRun = (home: string, id: string) =>
    fs.readFileString(path.join(home, "runs", id, "meta.json")).pipe(
      Effect.flatMap(decodeRun),
      Effect.mapError(() =>
        refusal("Crew worker metadata is missing, invalid, or not a T3-managed run."),
      ),
      Effect.flatMap((run) =>
        run.id === id
          ? Effect.succeed(run)
          : Effect.fail(refusal("Crew worker identity does not match its directory.")),
      ),
    );
  const records = (id: ThreadId) =>
    threads
      .getThreadRecords(id, ["runs", "providerThreads", "runtimeRequests", "subagents"])
      .pipe(Effect.mapError(unavailable));
  type Records = Effect.Success<ReturnType<typeof records>>;
  const response = (run: CrewRun, child: Records, taskId: NodeId): typeof CrewWorkerResult.Type => {
    const active = ThreadManagement.latestActiveRun(child);
    const latest = ThreadManagement.latestRun(child);
    const native =
      child.providerThreads.find((row) => row.id === child.thread.activeProviderThreadId) ??
      child.providerThreads.at(-1);
    const pending = child.runtimeRequests.some((row) => row.status === "pending");
    const state = pending
      ? "waiting"
      : active
        ? active.status === "queued"
          ? "starting"
          : "running"
        : child.providerThreads.some((row) => (row.pendingBackgroundTasks?.length ?? 0) > 0)
          ? "running"
          : run.state === "stopped" && run.t3Stopped === true
            ? "stopped"
            : latest?.status === "failed"
              ? "failed"
              : latest?.status === "interrupted" || latest?.status === "cancelled"
                ? "interrupted"
                : "idle";
    return {
      runId: run.id,
      threadId: child.thread.id,
      taskId,
      state,
      ...(native?.nativeThreadRef?.nativeId
        ? { nativeSessionId: native.nativeThreadRef.nativeId }
        : {}),
    };
  };
  const stopNative = Effect.fnUntraced(function* (
    threadId: ThreadId,
    commandId: CommandId,
    reason: string,
  ) {
    const afterSequence = yield* threads
      .getThreadEventSequence(threadId)
      .pipe(Effect.mapError(unavailable));
    yield* threads
      .dispatch({ type: "thread.stop", commandId, threadId: threadId, reason: reason })
      .pipe(Effect.mapError(dispatchFailure));
    yield* threads
      .stopDelegatedTasks({ threadId: threadId, commandId, reason: reason })
      .pipe(Effect.mapError(dispatchFailure));
    const ownedThreads = new Set<ThreadId>();
    const inspect = (id: ThreadId): Effect.Effect<boolean, OrchestratorMcpFailure> =>
      Effect.gen(function* () {
        if (ownedThreads.has(id)) return true;
        if (ownedThreads.size >= 128)
          return yield* refusal("Crew native ownership tree exceeds the cancellation limit.");
        ownedThreads.add(id);
        const current = yield* records(id);
        let quiet =
          !ThreadManagement.latestActiveRun(current) &&
          !current.runtimeRequests.some((row) => row.status === "pending") &&
          !current.providerThreads.some((row) => (row.pendingBackgroundTasks?.length ?? 0) > 0);
        for (const task of current.subagents)
          if (task.origin === "app_owned" && task.childThreadId)
            quiet = (yield* inspect(task.childThreadId)) && quiet;
        return quiet;
      });
    const isQuiet = Effect.suspend(() => {
      ownedThreads.clear();
      return inspect(threadId);
    });
    if (!(yield* isQuiet)) {
      yield* Stream.mergeAll(
        [...ownedThreads].flatMap((threadId) =>
          (["run.updated", "provider-thread.updated", "runtime-request.updated"] as const).map(
            (eventType) => threads.streamStoredEventsFrom({ threadId, eventType, afterSequence }),
          ),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(unavailable),
        Stream.mapEffect(() => isQuiet),
        Stream.filter(Boolean),
        Stream.runHead,
        Effect.timeout("35 seconds"),
        Effect.mapError(unavailable),
      );
    }
    if (!(yield* isQuiet)) return yield* unavailable();
    // A final idempotent Stop closes retained idle runtimes only after terminal
    // events have landed; closing active sessions earlier can hide interruption.
    for (const ownedId of ownedThreads)
      yield* threads
        .dispatch({
          type: "thread.stop",
          threadId: ownedId,
          commandId: CommandId.make(`${commandId}:quiescent:${ownedId}`),
          reason,
        })
        .pipe(Effect.mapError(dispatchFailure));
  });
  const verifyAfterDispatch = Effect.fnUntraced(function* (
    home: string,
    runId: string,
    threadId: ThreadId,
    commandId: CommandId,
  ) {
    const fresh = yield* readRun(home, runId).pipe(Effect.result);
    if (fresh._tag === "Failure" || fresh.success.state === "stopped") {
      yield* stopNative(
        threadId,
        CommandId.make(`command:crew:cancel:${yield* hash(commandId)}`),
        "Crew cancellation or invalid metadata won native startup.",
      );
      return yield* fresh._tag === "Failure"
        ? fresh.failure
        : refusal("Crew cancelled this worker while its native turn was starting.");
    }
    return fresh.success;
  });
  return CrewWorkerService.of({
    execute: Effect.fn("CrewWorkerService.execute")(function* (callerScope, input) {
      const scope = yield* requireThreadScope(callerScope, "crew_worker");
      if (!scope.capabilities.has("orchestration"))
        return yield* refusal("Crew workers require orchestration access.");
      const parent = yield* records(scope.thread.threadId);
      const active = ThreadManagement.latestActiveRun(parent);
      const native = parent.providerThreads.find(
        (row) => row.id === (active?.providerThreadId ?? parent.thread.activeProviderThreadId),
      );
      const credential = yield* mcpSessions.read(parent.thread.id);
      if (
        !native ||
        credential?.providerSessionId !== scope.thread.providerSessionId ||
        credential.providerInstanceId !== scope.thread.providerInstanceId ||
        parent.thread.providerInstanceId !== scope.thread.providerInstanceId ||
        parent.thread.archivedAt !== null ||
        parent.thread.deletedAt !== null
      )
        return yield* refusal("The Crew caller no longer owns this native provider credential.");
      const providerEnvironment =
        (yield* settings.getSettings.pipe(Effect.mapError(unavailable))).providerInstances[
          scope.thread.providerInstanceId
        ]?.environment ?? [];
      const env = {
        ...environment,
        ...Object.fromEntries(providerEnvironment.map((entry) => [entry.name, entry.value])),
      };
      const inherited = parent.thread.crew;
      const home = inherited?.home ?? env.CREW_HOME ?? path.join(userHome, ".crew");
      if (!path.isAbsolute(home))
        return yield* refusal("Crew home must be an absolute configured path.");
      let run = yield* readRun(home, input.runId);
      const recordedHome = run.launch?.env.CREW_HOME;
      if (recordedHome && path.resolve(recordedHome) !== path.resolve(home))
        return yield* refusal("Crew worker metadata points to a different Crew home.");
      const configPath = run.launch?.env.CREW_CONFIG ?? inherited?.configPath ?? env.CREW_CONFIG;
      const rosterPath = run.launch?.env.CREW_ROSTER ?? inherited?.rosterPath ?? env.CREW_ROSTER;
      if (
        [configPath, rosterPath].some(
          (value) => value !== undefined && (!value.trim() || !path.isAbsolute(value)),
        )
      )
        return yield* refusal("Crew config and roster overrides must be absolute paths.");
      const router = run.launch?.env.CREW_ROUTER ?? inherited?.router ?? env.CREW_ROUTER;
      const binding: OrchestrationV2CrewBinding = {
        runId: input.runId,
        home,
        ...(configPath ? { configPath } : {}),
        ...(rosterPath ? { rosterPath } : {}),
        ...(router === "on" ? { router: "on" } : router === "off" ? { router: "off" } : {}),
      };
      const mailbox =
        inherited?.runId ??
        (native.nativeThreadRef && (native.driver === "codex" || native.driver === "claudeAgent")
          ? `${native.driver === "codex" ? "codex" : "claude"}-${native.nativeThreadRef.nativeId}`
          : undefined);
      if (!mailbox) return yield* refusal("Crew workers require a native Codex or Claude caller.");
      let ancestor = run.parent.mailbox;
      const seen = new Set([run.id]);
      while (ancestor !== mailbox) {
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(ancestor) || seen.has(ancestor) || seen.size >= 128)
          return yield* refusal("This Crew worker is not owned by the calling thread.");
        seen.add(ancestor);
        ancestor = (yield* readRun(home, ancestor)).parent.mailbox;
      }
      const creationCommand = commandFor(scope.thread.threadId, run.id);
      const mappedId =
        run.t3?.threadId ?? IdAllocator.derive.delegatedTaskThread({ commandId: creationCommand });
      let shell = yield* threads.getThreadShell(mappedId).pipe(Effect.mapError(unavailable));
      if (input.action === "start" && shell === null) {
        if (!active?.rootNodeId)
          return yield* refusal(
            "Starting a new Crew worker requires an active native parent turn.",
          );
        if (run.parent.mailbox !== mailbox)
          return yield* refusal("Only a Crew worker's immediate parent may start it.");
        if (run.state === "stopped")
          return yield* refusal("Stopped Crew workers cannot start or resume.");
        const project = yield* projects
          .getById(parent.thread.projectId)
          .pipe(Effect.mapError(unavailable));
        const workspace =
          parent.thread.worktreePath ??
          (Option.isSome(project) ? project.value.workspaceRoot : undefined);
        if (!workspace) return yield* refusal("The parent workspace is unavailable.");
        const [approved, requested] = yield* Effect.all([
          fs.realPath(workspace),
          fs.realPath(run.cwd),
        ]).pipe(Effect.mapError(unavailable));
        if (requested !== approved)
          return yield* refusal(
            "Crew native workers must use their parent's approved workspace. Create a T3 worktree thread before delegating elsewhere.",
          );
        const capabilities = yield* orchestration.capabilities(scope);
        const driver = run.route.host === "codex" ? "codex" : "claudeAgent";
        const candidates = capabilities.providers.filter(
          (provider) => provider.driverKind === driver && provider.canRunChildTask,
        );
        const selected =
          candidates.find(
            (provider) =>
              provider.providerInstanceId === parent.thread.providerInstanceId &&
              provider.models.some((model) => model.id === run.route.model),
          ) ??
          candidates.find((provider) =>
            provider.models.some((model) => model.id === run.route.model),
          );
        if (!selected)
          return yield* refusal(
            "The routed Crew model is not available on an enabled native provider. Refresh the provider catalog or update the Crew roster.",
          );
        const model = selected.models.find((entry) => entry.id === run.route.model)!;
        const optionId = driver === "codex" ? "reasoningEffort" : "effort";
        const effort = model.options?.find((entry) => entry.id === optionId);
        if (
          run.route.effort &&
          (!effort ||
            effort.type !== "select" ||
            !effort.options.some((entry) => entry.id === run.route.effort))
        )
          return yield* refusal(
            "The routed Crew effort is not supported by this native model. Update the Crew roster; T3 will not silently change the effort.",
          );
        const modelSelection: ModelSelection = {
          instanceId: selected.providerInstanceId,
          model: model.id,
          ...(run.route.effort ? { options: [{ id: optionId, value: run.route.effort }] } : {}),
        };
        const runtimeMode = yield* OrchestratorMcpService.resolveRuntimeMode(
          parent.thread.runtimeMode,
          parent.thread.runtimeMode,
          { modelSelection, supportedRuntimeModes: selected.runtimeModes },
        );
        const brief = yield* fs
          .readFileString(path.join(home, "runs", run.id, "brief.md"))
          .pipe(Effect.mapError(unavailable));
        if (!brief.trim() || brief.length > 120_000)
          return yield* refusal(
            "Crew's standing brief is missing or exceeds the native prompt limit.",
          );
        run = yield* readRun(home, input.runId);
        if (run.state === "stopped")
          return yield* refusal("Stopped Crew workers cannot start or resume.");
        yield* threads
          .dispatch({
            type: "delegated_task.request",
            commandId: creationCommand,
            createdBy: "agent",
            creationSource: "mcp",
            parentThreadId: parent.thread.id,
            parentRunId: active.id,
            parentNodeId: active.rootNodeId,
            task: brief,
            title: `${run.role} · ${run.name}`,
            modelSelection,
            runtimeMode,
            interactionMode: parent.thread.interactionMode,
            completionWake: "none",
            crew: binding,
          })
          .pipe(Effect.mapError(dispatchFailure));
        run = yield* verifyAfterDispatch(home, input.runId, mappedId, creationCommand);
        shell = yield* threads.getThreadShell(mappedId).pipe(Effect.mapError(unavailable));
      }
      if (input.action === "stop" && shell === null && !run.t3 && run.parent.mailbox === mailbox) {
        yield* crewControl
          .retire({ crew: binding, providerInstanceId: parent.thread.providerInstanceId })
          .pipe(Effect.mapError(unavailable));
        yield* crewControl
          .confirmStopped({ crew: binding, providerInstanceId: parent.thread.providerInstanceId })
          .pipe(Effect.mapError(unavailable));
        return {
          runId: run.id,
          threadId: mappedId,
          taskId: IdAllocator.derive.delegatedTaskNode({ commandId: creationCommand }),
          state: "stopped",
        };
      }
      if (!shell || shell.deletedAt !== null)
        return yield* refusal(
          "This Crew worker has no available native T3 child. Start it through its owning parent.",
        );
      let child = yield* records(shell.id);
      if (
        child.thread.crew?.runId !== run.id ||
        child.thread.crew.home !== home ||
        child.thread.lineage.relationshipToParent !== "subagent"
      )
        return yield* refusal("The recorded T3 child does not belong to this Crew run.");
      const ownerId = child.thread.lineage.parentThreadId;
      if (!ownerId) return yield* refusal("The Crew child has no owning T3 thread.");
      let owner = ownerId;
      const threadAncestors = new Set([child.thread.id]);
      while (owner !== parent.thread.id) {
        if (threadAncestors.has(owner) || threadAncestors.size >= 128)
          return yield* refusal("The Crew child is outside the caller's T3 ancestry.");
        threadAncestors.add(owner);
        const next = (yield* records(owner)).thread.lineage.parentThreadId;
        if (!next) return yield* refusal("The Crew child is outside the caller's T3 ancestry.");
        owner = next;
      }
      const taskId = IdAllocator.derive.delegatedTaskNode({
        commandId: commandFor(ownerId, run.id),
      });
      if (run.t3 && run.t3.taskId !== taskId)
        return yield* refusal("The recorded native Crew task identity is invalid.");
      yield* assertTargetWithinLimits(parent.thread, child.thread);
      if (input.action === "start" && run.state === "stopped")
        return yield* refusal("Stopped Crew workers cannot start or resume.");
      if (input.action === "resume") {
        if (run.state === "stopped")
          return yield* refusal("Stopped Crew workers cannot start or resume.");
        if (!input.requestId)
          return yield* refusal("Crew resume requires a stable requestId for retry safety.");
        const key = yield* hash(`${ownerId}:${run.id}:${input.requestId}`);
        const commandId = CommandId.make(`command:crew:resume:${key}`);
        run = yield* readRun(home, input.runId);
        if (run.state === "stopped")
          return yield* refusal("Stopped Crew workers cannot start or resume.");
        yield* threads
          .dispatch({
            type: "message.dispatch",
            commandId,
            threadId: child.thread.id,
            messageId: MessageId.make(`message:crew:resume:${key}`),
            senderThreadId: parent.thread.id,
            dispatchMode: { type: "start_immediately" },
            crewResume: true,
            createdBy: "agent",
            creationSource: "mcp",
            attachments: [],
            text: `Read your standing brief at ${path.join(home, "runs", run.id, "brief.md")} and current packet at ${path.join(home, "runs", run.id, "packet.md")}. Run crew inbox now and consume only unread mail. Continue this same assignment; do not replay previously consumed mailbox content.`,
          })
          .pipe(Effect.mapError(dispatchFailure));
        run = yield* verifyAfterDispatch(home, input.runId, child.thread.id, commandId);
        child = yield* records(child.thread.id);
      }

      if (input.action === "stop") {
        yield* crewControl
          .retire({ crew: binding, providerInstanceId: parent.thread.providerInstanceId })
          .pipe(Effect.mapError(unavailable));
        yield* stopNative(
          child.thread.id,
          CommandId.make(
            `command:crew:stop:${encodeURIComponent(child.thread.id)}:${encodeURIComponent(input.requestId ?? String(run.turn ?? 0))}`,
          ),
          "Crew parent stopped this worker.",
        );
        yield* crewControl
          .confirmStopped({ crew: binding, providerInstanceId: parent.thread.providerInstanceId })
          .pipe(Effect.mapError(unavailable));
        child = yield* records(child.thread.id);
        run = yield* readRun(home, input.runId);
      }
      return response(run, child, taskId);
    }),
  });
});
export const layer = Layer.effect(CrewWorkerService, make);
