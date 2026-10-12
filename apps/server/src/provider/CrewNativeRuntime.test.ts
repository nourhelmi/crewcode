import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CrewNativeRuntime from "./CrewNativeRuntime.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.fnUntraced(function* (host: "codex" | "claude" = "codex", enabled = true) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crew-native-" });
  const executable = yield* HostProcess.ExecutablePath;
  const command = path.join(home, "fake-crew.mjs");
  yield* fs.writeFileString(
    command,
    `#!${executable}\n` +
      `
import fs from 'node:fs'; import path from 'node:path';
const home=process.env.CREW_HOME;
const runs=path.join(home,'runs');
const parent=process.argv[4];
fs.appendFileSync(path.join(home,'calls'),parent+'\\n');
if(fs.existsSync(path.join(home,'fail')) || fs.existsSync(path.join(home,'fail-'+parent))) process.exit(2);
const read=()=>(fs.existsSync(runs)?fs.readdirSync(runs):[]).map(name=>[name,JSON.parse(fs.readFileSync(path.join(runs,name,'meta.json'),'utf8'))]);
const stop=(id)=>{const p=path.join(runs,id,'meta.json'); const r=JSON.parse(fs.readFileSync(p,'utf8')); r.state='stopped'; fs.writeFileSync(p,JSON.stringify(r)); for(const [name,child] of read()) if(child.parent.mailbox===id)stop(name);};
if(fs.existsSync(path.join(home,'late'))){fs.unlinkSync(path.join(home,'late')); const r=read().find(([,r])=>r.parent.mailbox===parent)[1]; r.id='late'; r.state='running'; fs.mkdirSync(path.join(runs,'late')); fs.writeFileSync(path.join(runs,'late','meta.json'),JSON.stringify(r));}
for(const [id,r] of read()) if(r.parent.mailbox===parent)stop(id);
`,
  );
  yield* fs.chmod(command, 0o700);
  const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const runtime = yield* CrewNativeRuntime.make({
    host,
    driver: ProviderDriverKind.make(host === "claude" ? "claudeAgent" : "codex"),
    environment: { CREW_HOME: home, ...(enabled ? { CREWCODE_CREW_BIN: command } : {}) },
    emit: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
  });
  const write = Effect.fnUntraced(function* (
    id: string,
    parent = `${host}-native-root`,
    extra = {},
  ) {
    const folder = path.join(home, "runs", id);
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(
      path.join(folder, "meta.json"),
      encode({
        id,
        parent: { mailbox: parent },
        name: id,
        role: "builder",
        cwd: home,
        createdAt: "1970-01-01T00:00:00.000Z",
        state: "running",
        route: { host: "codex", model: "gpt-test", effort: "high" },
        ...extra,
      }),
    );
  });
  const root = (turn = "turn-1") => ({
    nativeThreadId: "native-root",
    providerTurnId: ProviderTurnId.make(turn),
    input: {
      threadId: ThreadId.make("thread-1"),
      runId: RunId.make(`run-${turn}`),
      rootNodeId: NodeId.make(`node-${turn}`),
      providerThread: { id: ProviderThreadId.make("provider-thread") },
    },
    ordinal: (_id: string) => Effect.succeed(1),
  });
  return {
    fs,
    path,
    home,
    events,
    runtime,
    write,
    root,
    items: () => events.filter((event) => event.type === "turn_item.updated"),
  };
});
const test = <A, E, R>(body: () => Effect.Effect<A, E, R>) =>
  Effect.scoped(body()).pipe(Effect.provide(NodeServices.layer));

describe("native Crew worker boundary", () => {
  it.effect("disabled and missing Crew state leave ordinary providers alone", () =>
    test(() =>
      Effect.gen(function* () {
        const h = yield* fixture("codex", false);
        yield* h.write("owned");
        yield* h.runtime.observe(h.root());
        yield* h.runtime.refresh;
        yield* h.runtime.stop("native-root");
        assert.equal(h.events.length, 0);
        assert.isFalse(yield* h.fs.exists(h.path.join(h.home, "calls")));
        const missing = yield* fixture();
        yield* missing.runtime.observe(missing.root());
        yield* missing.runtime.stop("native-root");
        assert.isFalse(yield* missing.runtime.pending());
        const unavailableEvents: ProviderAdapter.ProviderAdapterV2Event[] = [];
        const unavailable = yield* CrewNativeRuntime.make({
          host: "codex",
          driver: ProviderDriverKind.make("codex"),
          environment: {
            CREWCODE_CREW_BIN: h.path.join(h.home, "missing-command"),
            CREW_HOME: h.home,
          },
          emit: (event) =>
            Effect.sync(() => {
              unavailableEvents.push(event);
            }),
        });
        yield* unavailable.observe(h.root());
        yield* unavailable.stop("native-root");
        assert.isFalse(unavailable.enabled);
        assert.equal(unavailableEvents.length, 0);
      }),
    ),
  );

  it.effect("uses native mailbox ancestry and truthful external rows, only on changes", () =>
    test(() =>
      Effect.gen(function* () {
        const h = yield* fixture("claude");
        yield* h.write("owned");
        yield* h.write("nested", "owned");
        yield* h.write("other", "claude-another-root");
        yield* h.runtime.observe(h.root());
        assert.equal(h.items().length, 2);
        for (const event of h.items()) {
          assert.equal(event.driver, "claudeAgent");
          assert.equal(event.turnItem.nativeItemRef, null);
          assert.equal(event.turnItem.type, "dynamic_tool");
        }
        yield* h.runtime.refresh;
        assert.equal(h.items().length, 2);
        assert.isTrue(yield* h.runtime.pending("native-root"));
        yield* h.fs.makeDirectory(h.path.join(h.home, "runs", "owned", "submissions"));
        yield* h.fs.writeFileString(
          h.path.join(h.home, "runs", "owned", "submissions", "proof.md"),
          "Accepted immutable result",
        );
        yield* h.fs.writeFileString(
          h.path.join(h.home, "runs", "owned", "result.md"),
          "Unsettled replacement draft",
        );
        yield* h.write("owned", "claude-native-root", {
          state: "idle",
          settled: { ref: "proof", hash: "abc", at: "1970-01-01T00:00:00.000Z", status: "DONE" },
        });
        yield* h.write("nested", "owned", { state: "done" });
        yield* h.runtime.finish("native-root", h.root().providerTurnId);
        assert.isFalse(yield* h.runtime.pending("native-root"));
        assert.equal(h.items().at(-1)?.turnItem.status, "completed");
        const completed = h
          .items()
          .map((event) => event.turnItem)
          .find(
            (item) =>
              item.type === "dynamic_tool" &&
              typeof item.output === "object" &&
              item.output !== null &&
              Reflect.get(item.output, "result") === "Accepted immutable result",
          );
        assert.isDefined(completed);
      }),
    ),
  );

  it.effect("follow-up keeps an active worker card on its original turn until settlement", () =>
    test(() =>
      Effect.gen(function* () {
        const h = yield* fixture();
        yield* h.write("owned");
        yield* h.runtime.observe(h.root());
        const first = h.items()[0]!.turnItem;
        yield* h.runtime.observe(h.root("turn-2"));
        assert.equal(h.items().length, 1);
        yield* h.write("owned", "codex-native-root", { state: "idle" });
        yield* h.runtime.refresh;
        assert.equal(h.items().at(-1)!.turnItem.id, first.id);
        assert.equal(h.items().at(-1)!.turnItem.providerTurnId, first.providerTurnId);
        assert.equal(h.items().at(-1)!.turnItem.status, "completed");
      }),
    ),
  );

  it.effect("deep recursive stop catches a late direct child without touching another root", () =>
    test(() =>
      Effect.gen(function* () {
        const h = yield* fixture();
        for (let i = 0; i < 20; i++)
          yield* h.write(`child-${i}`, i ? `child-${i - 1}` : "codex-native-root");
        yield* h.write("other", "codex-other-root");
        yield* h.fs.writeFileString(h.path.join(h.home, "late"), "1");
        yield* h.runtime.observe(h.root());
        yield* h.runtime.stop("native-root");
        assert.equal(
          yield* h.fs.readFileString(h.path.join(h.home, "calls")),
          "codex-native-root\n",
        );
        assert.include(
          yield* h.fs.readFileString(h.path.join(h.home, "runs", "other", "meta.json")),
          '"state":"running"',
        );
        assert.isFalse(yield* h.runtime.pending());
      }),
    ),
  );

  it.effect(
    "interrupted finalization publishes stopped worker rows before handing terminal control back",
    () =>
      test(() =>
        Effect.gen(function* () {
          const h = yield* fixture();
          yield* h.write("owned");
          yield* h.runtime.observe(h.root());
          yield* h.runtime.finish("native-root", h.root().providerTurnId, true);
          assert.equal(h.items().at(-1)!.turnItem.status, "interrupted");
          assert.equal(
            yield* h.fs.readFileString(h.path.join(h.home, "calls")),
            "codex-native-root\n",
          );
          assert.isFalse(yield* h.runtime.pending());
        }),
      ),
  );

  it.effect("close attempts every root and aggregates failures", () =>
    test(() =>
      Effect.gen(function* () {
        const h = yield* fixture();
        yield* h.write("first");
        yield* h.write("second", "codex-second-root");
        yield* h.runtime.observe(h.root());
        yield* h.runtime.observe({ ...h.root("turn-2"), nativeThreadId: "second-root" });
        yield* h.fs.writeFileString(h.path.join(h.home, "fail-codex-native-root"), "1");
        const result = yield* Effect.result(h.runtime.close);
        assert.equal(result._tag, "Failure");
        assert.equal(
          yield* h.fs.readFileString(h.path.join(h.home, "calls")),
          "codex-native-root\ncodex-second-root\n",
        );
        assert.isTrue(yield* h.runtime.pending("native-root"));
        assert.isFalse(yield* h.runtime.pending("second-root"));
        assert.include(
          yield* h.fs.readFileString(h.path.join(h.home, "runs", "second", "meta.json")),
          '\"state\":\"stopped\"',
        );
      }),
    ),
  );

  it.effect("owned unreadable metadata fails closed and stop failures remain retryable", () =>
    test(() =>
      Effect.gen(function* () {
        const h = yield* fixture();
        yield* h.write("owned");
        yield* h.runtime.observe(h.root());
        yield* h.fs.writeFileString(h.path.join(h.home, "runs", "owned", "meta.json"), "{");
        const corrupt = yield* Effect.result(h.runtime.stop("native-root"));
        assert.equal(corrupt._tag, "Failure");
        assert.isTrue(yield* h.runtime.pending());
        yield* h.write("owned");
        yield* h.fs.writeFileString(h.path.join(h.home, "fail"), "1");
        assert.equal((yield* Effect.result(h.runtime.stop("native-root")))._tag, "Failure");
        yield* h.fs.remove(h.path.join(h.home, "fail"));
        yield* h.runtime.stop("native-root");
        assert.isFalse(yield* h.runtime.pending());
      }),
    ),
  );
});
