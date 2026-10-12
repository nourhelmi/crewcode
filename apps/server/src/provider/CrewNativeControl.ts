import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import { type OrchestrationV2CrewBinding, type ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerSettings from "../serverSettings.ts";

export class CrewNativeControlError extends Schema.TaggedError<CrewNativeControlError>()(
  "CrewNativeControlError",
  {
    runId: Schema.String,
    operation: Schema.Literals(["amend", "retire"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.operation === "amend"
      ? "Crew could not record the packet amendment. The native message was not started; retry with the same request."
      : "Crew metadata cleanup failed. Native cancellation may be incomplete; retry Stop.";
  }
}
export class CrewNativeFollowupBusyError extends Schema.TaggedError<CrewNativeFollowupBusyError>()(
  "CrewNativeFollowupBusyError",
  { runId: Schema.String },
) {
  override get message() {
    return "This Crew worker still has native background work. Retry the follow-up when it is idle; its packet has not changed.";
  }
}
const isCrewNativeControlError = Schema.is(CrewNativeControlError);
const isCrewNativeFollowupBusyError = Schema.is(CrewNativeFollowupBusyError);
type Owner = {
  readonly crew: OrchestrationV2CrewBinding;
  readonly providerInstanceId: ProviderInstanceId;
};
export class CrewNativeControl extends Context.Service<
  CrewNativeControl,
  {
    readonly prepareMessage: (
      input: Owner & {
        readonly requestId: string;
        readonly attemptId: string;
        readonly text: string;
        readonly attachmentCount: number;
        readonly nativeBusy: boolean;
      },
    ) => Effect.Effect<
      { readonly onPromptAccepted: Effect.Effect<void> },
      CrewNativeControlError | CrewNativeFollowupBusyError
    >;
    readonly confirmStopped: (input: Owner) => Effect.Effect<void, CrewNativeControlError>;
    readonly retire: (input: Owner) => Effect.Effect<void, CrewNativeControlError>;
  }
>()("t3/provider/CrewNativeControl") {}
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostEnvironment = yield* HostProcess.Environment;
  const settings = yield* ServerSettings.ServerSettingsService;
  const invoke = Effect.fnUntraced(function* (
    input: Owner,
    operation: "amend" | "retire",
    args: readonly string[],
    confirmed = false,
  ) {
    const current = yield* settings.getSettings;
    const env: NodeJS.ProcessEnv = {
      ...hostEnvironment,
      ...Object.fromEntries(
        (current.providerInstances[input.providerInstanceId]?.environment ?? []).map((entry) => [
          entry.name,
          entry.value,
        ]),
      ),
      CREW_HOME: input.crew.home,
      CREW_NO_DELEGATE: "1",
      CREW_T3_AMEND_OWNED: "1",
      CREW_T3_STOP_OWNED: "1",
    };
    for (const key of [
      "CREW_RUN",
      "CREW_MAILBOX",
      "T3_CREW_THREAD_ID",
      "T3_ACP_MCP_ENDPOINT",
      "T3_ACP_MCP_AUTHORIZATION",
      "CREW_CONFIG",
      "CREW_ROSTER",
      "CREW_ROUTER",
    ])
      delete env[key];
    delete env.CREW_T3_STOP_CONFIRMED;
    if (confirmed) env.CREW_T3_STOP_CONFIRMED = "1";
    if (input.crew.configPath) env.CREW_CONFIG = input.crew.configPath;
    if (input.crew.rosterPath) env.CREW_ROSTER = input.crew.rosterPath;
    if (input.crew.router) env.CREW_ROUTER = input.crew.router;
    const code = yield* spawner.exitCode(
      ChildProcess.make(env.CREWCODE_CREW_BIN || "crew", args, {
        env,
        extendEnv: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    if (code !== 0)
      return yield* new CrewNativeControlError({ runId: input.crew.runId, operation });
  });
  return CrewNativeControl.of({
    prepareMessage: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (input.nativeBusy)
            return yield* new CrewNativeFollowupBusyError({ runId: input.crew.runId });
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crew-amend-" });
          const textFile = path.join(directory, "message.txt");
          yield* fs.writeFileString(
            textFile,
            input.text.trim() ||
              (input.attachmentCount > 0
                ? `Human follow-up with ${input.attachmentCount} attached file(s); inspect the attachments in this native chat.`
                : input.text),
            { mode: 0o600 },
          );
          const requestKey = Hex.encode(
            yield* crypto.digest("SHA-256", new TextEncoder().encode(input.requestId)),
          );
          const attemptKey = Hex.encode(
            yield* crypto.digest("SHA-256", new TextEncoder().encode(input.attemptId)),
          );
          const deliveryArgs = [
            input.crew.runId,
            "--request-id",
            `t3-${requestKey}`,
            "--attempt-id",
            `t3-${attemptKey}`,
          ];
          yield* invoke(input, "amend", [
            "t3-amend",
            input.crew.runId,
            "--request-id",
            `t3-${requestKey}`,
            "--text-file",
            textFile,
          ]);
          yield* invoke(input, "amend", ["t3-amend-prepare", ...deliveryArgs]);
          return {
            // Native acceptance is distinct from queueing. Retry only this exact
            // receipt; a post-send failure must never fail or resend a live turn.
            onPromptAccepted: invoke(input, "amend", ["t3-amend-ack", ...deliveryArgs]).pipe(
              Effect.timeout("5 seconds"),
              Effect.retry({ times: 2, schedule: Schedule.spaced("250 millis") }),
              Effect.catchCause(() =>
                Effect.logWarning("Crew prompt acknowledgment remains pending", {
                  runId: input.crew.runId,
                }),
              ),
            ),
          };
        }),
      ).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError((cause) =>
          isCrewNativeControlError(cause) || isCrewNativeFollowupBusyError(cause)
            ? cause
            : new CrewNativeControlError({ runId: input.crew.runId, operation: "amend", cause }),
        ),
      ),
    confirmStopped: (input) =>
      invoke(input, "retire", ["stop", input.crew.runId], true).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError((cause) =>
          isCrewNativeControlError(cause)
            ? cause
            : new CrewNativeControlError({ runId: input.crew.runId, operation: "retire", cause }),
        ),
      ),
    retire: (input) =>
      invoke(input, "retire", ["stop", input.crew.runId]).pipe(
        Effect.timeout("45 seconds"),
        Effect.mapError((cause) =>
          isCrewNativeControlError(cause)
            ? cause
            : new CrewNativeControlError({ runId: input.crew.runId, operation: "retire", cause }),
        ),
      ),
  });
});
export const layer = Layer.effect(CrewNativeControl, make);
