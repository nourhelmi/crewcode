import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { setup } from "./setup.mjs";

NodeTest.default("setup configures crew acp and preserves custom settings on repeat", async (t) => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crewcode-acp-setup-"));
  t.after(() => NodeFSP.rm(home, { recursive: true, force: true }));
  const first = await setup({ home, crewBin: "crew" });
  NodeAssert.deepEqual(first.settings.providerInstances.crew.config, {
    source: "local",
    commandPath: "crew",
    commandArgs: ["acp"],
    customModels: [],
  });
  NodeAssert.deepEqual(first.settings.defaultModelSelection, {
    instanceId: "crew",
    model: "default",
  });
  NodeAssert.equal(first.settings.providerInstances.codex.enabled, true);
  const custom = '{\n  // Preserve this comment.\n  "providerInstances": {}\n}\n';
  await NodeFSP.writeFile(first.path, custom);
  await setup({ home, crewBin: "different-crew" });
  NodeAssert.equal(await NodeFSP.readFile(first.path, "utf8"), custom);
});

NodeTest.default(
  "setup migrates the generated legacy bridge once without changing unrelated settings",
  async (t) => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crewcode-acp-migrate-"));
    t.after(() => NodeFSP.rm(home, { recursive: true, force: true }));
    const first = await setup({ home, crewBin: "crew" });
    const old = {
      ...first.settings,
      defaultModelSelection: { instanceId: "crew", model: "crew-auto" },
      custom: { keep: true },
    };
    old.providerInstances.crew = {
      ...old.providerInstances.crew,
      enabled: false,
      config: {
        source: "local",
        commandPath: process.execPath,
        commandArgs: ["/old/crewcode/acp.mjs"],
        customModels: ["crew-auto"],
      },
    };
    await NodeFSP.writeFile(first.path, JSON.stringify(old));
    const migrated = await setup({ home, crewBin: "crew" });
    NodeAssert.deepEqual(migrated.settings.custom, old.custom);
    NodeAssert.deepEqual(migrated.settings.providerInstances.crew.config.commandArgs, ["acp"]);
    NodeAssert.equal(migrated.settings.providerInstances.crew.enabled, true);
    const before = await NodeFSP.readFile(first.path, "utf8");
    await setup({ home, crewBin: "crew" });
    NodeAssert.equal(await NodeFSP.readFile(first.path, "utf8"), before);
  },
);
