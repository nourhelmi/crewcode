import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerSettings from "../serverSettings.ts";
import * as CrewNativeControl from "./CrewNativeControl.ts";

it.live(
  "prepares exact native amendments and acknowledges only accepted prompts without forwarding credentials",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-crew-control-" });
        const executable = yield* HostProcess.ExecutablePath;
        const command = path.join(home, "fake-crew.mjs");
        yield* fs.writeFileString(
          command,
          `#!${executable}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);const p=args[args.indexOf('--text-file')+1];fs.appendFileSync(process.env.CREW_HOME+'/calls',JSON.stringify({args,env:process.env,text:args[0]==='t3-amend'?fs.readFileSync(p,'utf8'):null})+'\\n');if(fs.existsSync(process.env.CREW_HOME+'/fail'))process.exit(2);`,
        );
        yield* fs.chmod(command, 0o700);
        const env = {
          CREWCODE_CREW_BIN: command,
          CREW_HOME: "/invalid",
          CREW_RUN: "wrong",
          CREW_CONFIG: "/untrusted",
          CREW_T3_STOP_CONFIRMED: "1",
          T3_ACP_MCP_AUTHORIZATION: "private-test-only",
          T3_ACP_MCP_ENDPOINT: "private-test-only",
        };
        const providerInstanceId = ProviderInstanceId.make("codex");
        const owner = {
          crew: { runId: "worker", home, router: "off" as const },
          providerInstanceId,
        };
        yield* Effect.gen(function* () {
          const service = yield* CrewNativeControl.CrewNativeControl;
          const amendment = {
            ...owner,
            requestId: `message:${"long".repeat(100)}`,
            attemptId: `attempt:%${"long".repeat(100)}`,
            text: "Human scope change",
            attachmentCount: 0,
            nativeBusy: false,
          };
          const busy = yield* service
            .prepareMessage({ ...amendment, nativeBusy: true })
            .pipe(Effect.flip);
          assert.strictEqual(busy._tag, "CrewNativeFollowupBusyError");
          assert.strictEqual(yield* fs.exists(path.join(home, "calls")), false);
          const delivery = yield* service.prepareMessage(amendment);
          const beforeAcceptance = (yield* fs.readFileString(path.join(home, "calls")))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.deepEqual(
            beforeAcceptance.map((call) => call.args[0]),
            ["t3-amend", "t3-amend-prepare"],
          );
          yield* delivery.onPromptAccepted;
          yield* service.prepareMessage(amendment);
          yield* service.retire(owner);
          yield* service.confirmStopped(owner);
          const calls = (yield* fs.readFileString(path.join(home, "calls")))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.strictEqual(calls[0].args[3], calls[3].args[3]);
          assert.match(calls[0].args[3], /^t3-[a-f0-9]{64}$/);
          assert.strictEqual(calls[0].text, amendment.text);
          assert.strictEqual(yield* fs.exists(calls[0].args[5]), false);
          assert.deepEqual(calls[1].args.slice(1), calls[2].args.slice(1));
          assert.match(calls[1].args[5], /^t3-[a-f0-9]{64}$/);
          assert.deepEqual(calls[5].args, ["stop", "worker"]);
          assert.strictEqual(calls[6].env.CREW_T3_STOP_CONFIRMED, "1");
          for (const call of calls.slice(0, 6))
            assert.strictEqual(call.env.CREW_T3_STOP_CONFIRMED, undefined);
          for (const call of calls) {
            assert.strictEqual(call.env.CREW_HOME, home);
            assert.strictEqual(call.env.CREW_ROUTER, "off");
            assert.strictEqual(call.env.CREW_T3_STOP_OWNED, "1");
            assert.strictEqual(call.env.CREW_T3_AMEND_OWNED, "1");
            for (const key of [
              "CREW_RUN",
              "CREW_CONFIG",
              "T3_ACP_MCP_AUTHORIZATION",
              "T3_ACP_MCP_ENDPOINT",
            ])
              assert.strictEqual(call.env[key], undefined);
          }
          const attachmentDelivery = yield* service.prepareMessage({
            ...amendment,
            requestId: "attachment",
            text: "",
            attachmentCount: 2,
          });
          const attachmentCalls = (yield* fs.readFileString(path.join(home, "calls")))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.match(attachmentCalls.at(-2).text, /2 attached file/);
          yield* fs.writeFileString(path.join(home, "fail"), "");
          // A transport acknowledgment failure never fails an already accepted native turn.
          yield* attachmentDelivery.onPromptAccepted;
          const failed = yield* service.prepareMessage(amendment).pipe(Effect.flip);
          assert.strictEqual(failed._tag, "CrewNativeControlError");
        }).pipe(
          Effect.provide(
            CrewNativeControl.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  ServerSettings.layerTest(),
                  Layer.succeed(HostProcess.Environment, env),
                ),
              ),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
