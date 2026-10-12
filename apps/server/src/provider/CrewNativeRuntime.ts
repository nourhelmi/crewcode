import {
  NodeId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  type ProviderTurnId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Path from "effect/Path";

const SafeId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,160}$/));
const Run = Schema.Struct({
  id: SafeId,
  name: Schema.String,
  role: Schema.String,
  cwd: Schema.String,
  createdAt: Schema.String,
  state: Schema.Literals(["idle", "running", "done", "blocked", "failed", "stalled", "stopped"]),
  parent: Schema.Struct({ mailbox: Schema.String }),
  route: Schema.Struct({ host: Schema.String, model: Schema.String, effort: Schema.String }),
  turn: Schema.optional(Schema.Number),
  amendment: Schema.optional(
    Schema.Struct({ number: Schema.Number, resultHash: Schema.optional(Schema.String) }),
  ),
  assignment: Schema.optional(
    Schema.Struct({
      id: SafeId,
      revision: Schema.Number,
      status: Schema.Literals(["active", "submitted", "accepted"]),
      submission: Schema.optional(SafeId),
      submissions: Schema.Array(
        Schema.Struct({
          ref: SafeId,
          hash: Schema.String,
          revision: Schema.Number,
        }),
      ),
    }),
  ),
  settled: Schema.optional(
    Schema.Struct({
      ref: Schema.optional(SafeId),
      hash: Schema.String,
      at: Schema.String,
      status: Schema.String,
    }),
  ),
  waitingSince: Schema.optional(Schema.String),
});
type Run = typeof Run.Type;
const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(Run));

// Retirement ends the worker process, not a delivered outcome. An old settlement alone
// cannot prove delivery: amendments, new assignments, and reopened drafts invalidate it.
const completedAssignment = (run: Run): boolean => {
  const { assignment, settled } = run;
  if (
    !assignment ||
    assignment.status === "active" ||
    !settled?.ref ||
    assignment.submission !== settled.ref ||
    settled.ref !== `${assignment.id}-r${assignment.revision}-${settled.hash}` ||
    run.amendment?.resultHash === settled.hash ||
    !/^(DONE|PASS(ED)?)\b/i.test(settled.status)
  )
    return false;
  return assignment.submissions.some(
    (submission) =>
      submission.ref === settled.ref &&
      submission.hash === settled.hash &&
      submission.revision === assignment.revision,
  );
};

export class CrewStopError extends Schema.TaggedError<CrewStopError>()("CrewStopError", {
  mailbox: Schema.String,
  operation: Schema.Literals(["scan", "stop", "settle"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return "Some external Crew workers could not be stopped. Inspect Crew before continuing.";
  }
}

type Root = {
  readonly nativeThreadId: string;
  readonly input: Pick<
    ProviderAdapter.ProviderAdapterV2TurnInput,
    "threadId" | "runId" | "rootNodeId"
  > & {
    readonly providerThread: Pick<
      ProviderAdapter.ProviderAdapterV2TurnInput["providerThread"],
      "id"
    >;
  };
  readonly providerTurnId: ProviderTurnId;
  readonly ordinal: (id: string) => Effect.Effect<number>;
};
type Watched = Root & {
  active: boolean;
  pending: boolean;
  readonly started: DateTime.Utc;
};

export class CrewNativeRuntime extends Context.Service<
  CrewNativeRuntime,
  {
    readonly enabled: boolean;
    readonly observe: (root: Root) => Effect.Effect<void>;
    readonly finish: (
      nativeThreadId: string,
      providerTurnId: ProviderTurnId,
      interrupted?: boolean,
    ) => Effect.Effect<void>;
    readonly refresh: Effect.Effect<void>;
    readonly pending: (nativeThreadId?: string) => Effect.Effect<boolean>;
    readonly stop: (nativeThreadId: string) => Effect.Effect<void, CrewStopError>;
    readonly close: Effect.Effect<void, CrewStopError>;
  }
>()("t3/provider/CrewNativeRuntime") {}

/** The native provider remains the root. Crew rows are external work, never native subagents. */
export const make = Effect.fn("CrewNativeRuntime.make")(function* (options: {
  readonly host: "codex" | "claude";
  readonly driver: ProviderDriverKind;
  readonly environment: NodeJS.ProcessEnv;
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const userHome = yield* HostProcess.HomeDirectory;
  const home = options.environment.CREW_HOME || path.join(userHome, ".crew");
  const requested =
    options.environment.CREWCODE_NATIVE_CREW === "1" ||
    Boolean(options.environment.CREWCODE_CREW_BIN);
  const command = options.environment.CREWCODE_CREW_BIN || "crew";
  const processEnvironment = yield* HostProcess.Environment;
  const candidates =
    command.includes("/") || command.includes("\\")
      ? [command]
      : (options.environment.PATH ?? processEnvironment.PATH ?? "")
          .split(path.sep === "\\" ? ";" : ":")
          .filter(Boolean)
          .map((folder) => path.join(folder, command));
  const enabled =
    requested &&
    (yield* Effect.forEach(candidates, (candidate) => fs.exists(candidate))).some(Boolean);
  const directory = path.join(home, "runs");
  const roots = new Map<string, Watched>();
  const cards = new Map<string, { root: Watched; signature: string; terminal: boolean }>();
  // An old run's parent is immutable. Read historical metadata once, then only new and owned runs.
  const known = new Map<string, Run>();
  const lock = yield* Semaphore.make(1);
  const mailbox = (id: string) => `${options.host}-${id}`;
  const owned = (all: ReadonlyArray<Run>, parent: string) => {
    const parents = new Set([parent]);
    const result: Run[] = [];
    for (let changed = true; changed;) {
      changed = false;
      for (const run of all)
        if (!parents.has(run.id) && parents.has(run.parent.mailbox)) {
          parents.add(run.id);
          result.push(run);
          changed = true;
        }
    }
    return result;
  };
  const scan = Effect.fnUntraced(function* (parent: string) {
    const exists = yield* fs.exists(directory);
    if (!exists) {
      if (owned([...known.values()], parent).length)
        return yield* new CrewStopError({ mailbox: parent, operation: "scan" });
      return [] as Run[];
    }
    const names = yield* fs.readDirectory(directory);
    const refresh = new Set(owned([...known.values()], parent).map((run) => run.id));
    for (const name of names) {
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(name) || (known.has(name) && !refresh.has(name))) continue;
      const value = yield* fs
        .readFileString(path.join(directory, name, "meta.json"))
        .pipe(
          Effect.catch((cause) =>
            refresh.has(name)
              ? Effect.fail(new CrewStopError({ mailbox: parent, operation: "scan", cause }))
              : Effect.succeed(""),
          ),
        );
      const parsed = decodeRun(value);
      if (parsed._tag === "Some" && parsed.value.id === name) known.set(name, parsed.value);
      else if (refresh.has(name))
        return yield* new CrewStopError({ mailbox: parent, operation: "scan" });
    }
    const present = new Set(names);
    for (const id of known.keys())
      if (!present.has(id)) {
        if (refresh.has(id))
          return yield* new CrewStopError({ mailbox: parent, operation: "scan" });
        known.delete(id);
      }
    return owned([...known.values()], parent);
  });
  const project = Effect.fnUntraced(function* (candidate: Watched, run: Run) {
    const previous = cards.get(run.id);
    const root = previous && !previous.terminal ? previous.root : candidate;
    if (
      !previous &&
      run.state !== "running" &&
      Date.parse(run.settled?.at ?? run.createdAt) < DateTime.toEpochMillis(root.started)
    )
      return;
    const completed = completedAssignment(run);
    const signature = [
      run.state,
      completed,
      run.turn,
      run.amendment?.number,
      run.assignment?.id,
      run.assignment?.revision,
      run.assignment?.status,
      run.assignment?.submission,
      run.settled?.hash,
      run.waitingSince,
    ].join("\0");
    if (previous?.signature === signature) return;
    const now = yield* DateTime.now;
    const key = `crew:${mailbox(root.nativeThreadId)}:${root.providerTurnId}:${run.id}`;
    const nodeId = NodeId.make(key);
    const state: OrchestrationV2TurnItem["status"] =
      run.state === "running"
        ? "running"
        : run.state === "stopped"
          ? completed
            ? "completed"
            : "interrupted"
          : ["failed", "blocked", "stalled"].includes(run.state)
            ? "failed"
            : "completed";
    const result = run.settled?.ref
      ? yield* fs
          .readFileString(path.join(directory, run.id, "submissions", `${run.settled.ref}.md`))
          .pipe(
            Effect.map((text) => text.slice(0, 12_000)),
            Effect.orElseSucceed(() => ""),
          )
      : "";
    const base = {
      threadId: root.input.threadId,
      runId: root.input.runId,
      providerThreadId: root.input.providerThread.id,
      providerTurnId: root.providerTurnId,
      nativeItemRef: null,
      startedAt: root.started,
      completedAt: state === "running" ? null : now,
    };
    yield* options.emit({
      type: "node.updated",
      driver: options.driver,
      node: {
        ...base,
        id: nodeId,
        parentNodeId: root.input.rootNodeId,
        rootNodeId: root.input.rootNodeId,
        kind: "tool_call",
        status: state,
        countsForRun: false,
        runtimeRequestId: null,
        checkpointScopeId: null,
      },
    });
    yield* options.emit({
      type: "turn_item.updated",
      driver: options.driver,
      turnItem: {
        ...base,
        id: TurnItemId.make(key),
        nodeId,
        parentItemId: null,
        ordinal: yield* root.ordinal(key),
        status: state,
        updatedAt: now,
        type: "dynamic_tool",
        toolName: "Crew worker",
        title: `${run.role} · ${run.name}`,
        toolSource: { key: "crew", name: "Crew", kind: "integration" },
        input: { runId: run.id, role: run.role, ...run.route, cwd: run.cwd },
        output: {
          state: run.state,
          external: true,
          ...(run.waitingSince ? { waiting: "Needs attention in its native host" } : {}),
          ...(result ? { result } : {}),
        },
      },
    });
    cards.set(run.id, { root, signature, terminal: state !== "running" });
  });
  const refreshRoot = Effect.fnUntraced(function* (root: Watched) {
    const runs = yield* scan(mailbox(root.nativeThreadId));
    root.pending = runs.some((run) => run.state === "running");
    for (const run of runs) yield* project(root, run);
  });
  const refresh = lock.withPermits(1)(
    Effect.gen(function* () {
      if (!enabled) return;
      for (const root of roots.values())
        if (root.active || root.pending)
          yield* refreshRoot(root).pipe(
            Effect.catch(() =>
              Effect.logWarning("crew-native-status-unavailable", { driver: options.driver }),
            ),
          );
    }),
  );
  const stop = Effect.fn("CrewNativeRuntime.stop")(function* (nativeThreadId: string) {
    if (!enabled) return;
    const parent = mailbox(nativeThreadId);
    yield* scan(parent).pipe(
      Effect.mapError((cause) => new CrewStopError({ mailbox: parent, operation: "scan", cause })),
    );
    // Crew advances a cancellation epoch under its spawn lock, including for an empty tree.
    // A launch still awaiting routing cannot reserve after this fence; later prompts may spawn afresh.
    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make(command, ["stop", "--children-of", parent], {
          env: { ...options.environment, CREW_HOME: home, CREW_NO_DELEGATE: "1" },
          extendEnv: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.timeout("45 seconds"),
        Effect.mapError(
          (cause) => new CrewStopError({ mailbox: parent, operation: "stop", cause }),
        ),
      );
    if (exitCode !== 0) return yield* new CrewStopError({ mailbox: parent, operation: "stop" });
    const remaining = yield* scan(parent).pipe(
      Effect.mapError((cause) => new CrewStopError({ mailbox: parent, operation: "scan", cause })),
    );
    if (remaining.some((run) => run.state !== "stopped"))
      return yield* new CrewStopError({ mailbox: parent, operation: "settle" });
    const root = roots.get(nativeThreadId);
    if (root) {
      root.active = false;
      yield* refreshRoot(root).pipe(Effect.ignore);
    }
  });
  const cleanupFailure = Effect.fnUntraced(function* (root: Watched) {
    const now = yield* DateTime.now;
    const key = `crew-cleanup:${mailbox(root.nativeThreadId)}:${root.providerTurnId}`;
    yield* options.emit({
      type: "turn_item.updated",
      driver: options.driver,
      turnItem: {
        id: TurnItemId.make(key),
        threadId: root.input.threadId,
        runId: root.input.runId,
        nodeId: null,
        providerThreadId: root.input.providerThread.id,
        providerTurnId: root.providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* root.ordinal(key),
        status: "failed",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        title: "Crew cleanup failed",
        type: "dynamic_tool",
        toolName: "Crew stop",
        input: {},
        output: "External Crew workers may still be running. Inspect Crew and retry Stop.",
        toolSource: { key: "crew", name: "Crew", kind: "integration" },
      },
    });
  });
  if (enabled) yield* refresh.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped);
  return CrewNativeRuntime.of({
    enabled,
    observe: (root) =>
      Effect.gen(function* () {
        if (!enabled) return;
        roots.set(root.nativeThreadId, {
          ...root,
          active: true,
          pending: false,
          started: yield* DateTime.now,
        });
        yield* refresh;
      }),
    finish: (id, turn, interrupted = false) =>
      Effect.gen(function* () {
        const root = roots.get(id);
        if (root?.providerTurnId !== turn) return;
        if (interrupted)
          yield* lock
            .withPermits(1)(stop(id))
            .pipe(Effect.catchTags({ CrewStopError: () => cleanupFailure(root) }));
        yield* refresh;
        root.active = false;
      }),
    refresh,
    pending: (id) =>
      Effect.sync(() =>
        id === undefined
          ? [...roots.values()].some((root) => root.pending)
          : roots.get(id)?.pending === true,
      ),
    stop: (id) => lock.withPermits(1)(stop(id)),
    close: Effect.gen(function* () {
      const failures: CrewStopError[] = [];
      for (const id of roots.keys())
        yield* lock
          .withPermits(1)(stop(id))
          .pipe(
            Effect.catchTags({
              CrewStopError: (error) =>
                Effect.sync(() => {
                  failures.push(error);
                }),
            }),
          );
      if (failures.length > 0)
        return yield* new CrewStopError({
          mailbox: failures.map((error) => error.mailbox).join(", "),
          operation: "stop",
          cause: failures,
        });
    }),
  });
});
