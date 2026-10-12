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

it.effect(
  "records private idempotent amendments and metadata-only retirement without forwarding native credentials",
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
            requestId: `command:${"long".repeat(100)}`,
            text: "Human scope change",
          };
          yield* service.amend(amendment);
          yield* service.amend(amendment);
          yield* service.retire(owner);
          yield* service.confirmStopped(owner);
          const calls = (yield* fs.readFileString(path.join(home, "calls")))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.strictEqual(calls[0].args[3], calls[1].args[3]);
          assert.match(calls[0].args[3], /^t3-[a-f0-9]{64}$/);
          assert.strictEqual(calls[0].text, amendment.text);
          assert.strictEqual(yield* fs.exists(calls[0].args[5]), false);
          assert.deepEqual(calls[2].args, ["stop", "worker"]);
          assert.strictEqual(calls[3].env.CREW_T3_STOP_CONFIRMED, "1");
          for (const call of calls.slice(0, 3))
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
          yield* fs.writeFileString(path.join(home, "fail"), "");
          const failed = yield* service.amend(amendment).pipe(Effect.flip);
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
