import { expect, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as CrewNativeControl from "../provider/CrewNativeControl.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const childId = ThreadId.make("crew-child");
const grandchildId = ThreadId.make("crew-grandchild");
const command = {
  type: "thread.stop" as const,
  threadId: childId,
  commandId: CommandId.make("stop-crew-child"),
};

const fixture = (active = false, withDescendant = false) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const interrupted = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const state = { failRelease: false };
    const projections = new Map(
      [childId, grandchildId].map((id) => {
        const running = id === childId && active;
        return [
          id,
          {
            thread: {
              id,
              projectId: "project",
              providerInstanceId: "codex",
              crew: { runId: id, home: "/isolated/crew" },
            },
            runs: [
              {
                id: `run:${id}`,
                ordinal: 1,
                providerThreadId: `provider:${id}`,
                status: running ? "waiting" : "completed",
              },
            ],
            runtimeRequests: running ? [{ status: "pending" }] : [],
            providerThreads: [
              {
                id: `provider:${id}`,
                providerSessionId: `session:${id}`,
                pendingBackgroundTasks: [],
              },
            ],
            providerTurns: [
              {
                id: `turn:${id}`,
                providerThreadId: `provider:${id}`,
                ordinal: 1,
                status: running ? "running" : "completed",
              },
            ],
            subagents:
              id === childId && withDescendant
                ? ["original", "followup"].map((id) => ({
                    id,
                    origin: "app_owned",
                    childThreadId: grandchildId,
                  }))
                : [],
          } as unknown as OrchestrationV2ThreadProjection,
        ] as const;
      }),
    );
    const liveSessions = new Set([`session:${childId}`, `session:${grandchildId}`]);
    const layer = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerSettings.layerTest(),
          Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
            getByCommandId: () => Effect.succeedNone,
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadEventSequence: () => Effect.succeed(0),
            getThreadRecords: (id) => Effect.sync(() => projections.get(id)!),
            streamStoredEventsFrom: () => Stream.fromQueue(events),
            dispatch: (input) =>
              Effect.sync(() => {
                calls.push(`${input.type}:${"threadId" in input ? input.threadId : ""}`);
                if (input.type === "thread.background-work.settle") {
                  const current = projections.get(input.threadId)!;
                  projections.set(input.threadId, { ...current, runtimeRequests: [] });
                }
                return { sequence: 1, storedEvents: [] };
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: (id) =>
              Effect.succeed(
                liveSessions.has(id)
                  ? Option.some({
                      interruptTurn: () =>
                        Effect.sync(() => {
                          calls.push(`interrupt:${id}`);
                        }).pipe(
                          Effect.andThen(Deferred.succeed(interrupted, undefined)),
                          Effect.asVoid,
                        ),
                    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime)
                  : Option.none(),
              ),
            detach: ({ providerSessionId, ...input }) =>
              Effect.sync(() => {
                expect(input.revokeMcpCredential).toBe(true);
                calls.push(`detach:${providerSessionId}`);
              }),
            release: ({ providerSessionId, requireClosed }) =>
              Effect.suspend(() => {
                expect(requireClosed).toBe(true);
                calls.push(`release:${providerSessionId}`);
                if (state.failRelease)
                  return Effect.fail(
                    new ProviderSessionManager.ProviderSessionReleaseError({
                      providerSessionId,
                      reason: "manual_shutdown",
                      cause: "close failed",
                    }),
                  );
                liveSessions.delete(providerSessionId);
                return Effect.void;
              }),
          }),
          Layer.mock(CrewNativeControl.CrewNativeControl)({
            retire: ({ crew }) =>
              Effect.sync(() => {
                calls.push(`retire:${crew.runId}`);
              }),
            confirmStopped: ({ crew }) =>
              Effect.sync(() => {
                calls.push(`confirm:${crew.runId}`);
              }),
          }),
        ),
      ),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layer),
    );
    return {
      service,
      calls,
      state,
      liveSessions,
      interrupted,
      terminal: Effect.gen(function* () {
        const current = projections.get(childId)!;
        projections.set(childId, {
          ...current,
          runs: current.runs.map((run) => ({ ...run, status: "interrupted" })),
          providerTurns: current.providerTurns.map((turn) => ({ ...turn, status: "interrupted" })),
        });
        yield* Queue.offer(events, {
          event: { type: "run.updated" },
        } as OrchestrationV2StoredEvent);
      }),
    };
  });

it.effect(
  "Crew Stop closes dedicated shared-capable runtimes and descendants before confirming",
  () =>
    Effect.gen(function* () {
      const { service, calls, liveSessions } = yield* fixture(false, true);
      yield* service.dispatch(command);
      expect(liveSessions.size).toBe(0);
      expect(calls.filter((call) => call === `thread.stop:${grandchildId}`)).toHaveLength(1);
      expect(calls.indexOf(`release:session:${childId}`)).toBeLessThan(
        calls.indexOf(`confirm:${childId}`),
      );
      expect(calls.indexOf(`release:session:${grandchildId}`)).toBeLessThan(
        calls.indexOf(`confirm:${grandchildId}`),
      );
      expect(calls.indexOf(`confirm:${grandchildId}`)).toBeLessThan(
        calls.indexOf(`confirm:${childId}`),
      );
    }),
);

it.effect("Crew Stop waits for terminal ingestion before closing an approval-blocked runtime", () =>
  Effect.gen(function* () {
    const { service, calls, interrupted, terminal } = yield* fixture(true);
    const stop = yield* service.dispatch(command).pipe(Effect.forkChild);
    yield* Deferred.await(interrupted);
    expect(calls.some((call) => call.startsWith("detach:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("confirm:"))).toBe(false);
    yield* terminal;
    yield* Fiber.join(stop);
    expect(calls).toContain(`release:session:${childId}`);
    expect(calls).toContain(`thread.background-work.settle:${childId}`);
    expect(calls.at(-1)).toBe(`confirm:${childId}`);
  }),
);

it.effect("Crew Stop preserves unconfirmed ownership on close failure and retries cleanup", () =>
  Effect.gen(function* () {
    const { service, calls, state, liveSessions } = yield* fixture();
    state.failRelease = true;
    expect(Exit.isFailure(yield* Effect.exit(service.dispatch(command)))).toBe(true);
    expect(calls).not.toContain(`confirm:${childId}`);
    expect(liveSessions.has(`session:${childId}`)).toBe(true);
    state.failRelease = false;
    yield* service.dispatch(command);
    expect(liveSessions.has(`session:${childId}`)).toBe(false);
    expect(calls.at(-1)).toBe(`confirm:${childId}`);
  }),
);
