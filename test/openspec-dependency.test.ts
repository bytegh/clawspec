import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ensureOpenSpecCli, OPENSPEC_PACKAGE_NAME } from "../src/dependencies/openspec.ts";

const ROOT_PREFIX = process.platform === "win32" ? "C:\\clawspec-test" : "/tmp/clawspec-test";

const LOCAL_COMMAND = path.join(
  ROOT_PREFIX,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "openspec.cmd" : "openspec",
);

test("ensureOpenSpecCli uses the global openspec command when available", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await ensureOpenSpecCli({
    pluginRoot: ROOT_PREFIX,
    runner: async ({ command, args }) => {
      calls.push({ command, args });
      if (command === LOCAL_COMMAND) {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (command === "openspec") {
        return { code: 0, stdout: "1.2.0\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  });

  assert.equal(result.source, "global");
  assert.equal(result.version, "1.2.0");
  assert.equal(calls.some((call) => call.command === "npm"), false);
});

test("ensureOpenSpecCli installs a plugin-local openspec when none is available", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let localCheckCount = 0;

  const result = await ensureOpenSpecCli({
    pluginRoot: ROOT_PREFIX,
    runner: async ({ command, args }) => {
      calls.push({ command, args });
      if (command === LOCAL_COMMAND) {
        localCheckCount += 1;
        if (localCheckCount === 1) {
          return { code: 1, stdout: "", stderr: "not found" };
        }
        return { code: 0, stdout: "1.2.0\n", stderr: "" };
      }
      if (command === "openspec") {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (command === "npm") {
        return { code: 0, stdout: "installed\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  });

  assert.equal(result.source, "local");
  assert.equal(result.version, "1.2.0");
  assert.equal(
    calls.some((call) => call.command === "npm" && call.args.includes(OPENSPEC_PACKAGE_NAME)),
    true,
  );
});
