import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import plugin from "../src/index.ts";

test("plugin registers the clawspec command", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "clawspec-plugin-register-"));
  const commandNames: string[] = [];

  plugin.register({
    pluginConfig: {},
    config: {},
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
    },
    registerService() {},
    registerCli() {},
    registerCommand(command: { name: string }) {
      commandNames.push(command.name);
    },
    on() {},
  } as any);

  assert.deepEqual(commandNames, ["clawspec"]);
});
