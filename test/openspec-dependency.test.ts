import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildOpenSpecInstallMessage, ensureOpenSpecCli } from "../src/dependencies/openspec.ts";

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

test("ensureOpenSpecCli installs plugin-local openspec when local and global are unavailable", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await ensureOpenSpecCli({
    pluginRoot: ROOT_PREFIX,
    runner: async ({ command, args }) => {
      calls.push({ command, args });
      if (command === LOCAL_COMMAND) {
        const versionChecks = calls.filter((call) => call.command === LOCAL_COMMAND && call.args[0] === "--version").length;
        if (versionChecks >= 2) {
          return { code: 0, stdout: "1.2.3\n", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (command === "openspec") {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (command === "npm") {
        return { code: 0, stdout: "installed", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  });

  assert.equal(result.source, "local");
  assert.equal(result.version, "1.2.3");
  assert.equal(calls.some((call) => call.command === "npm"), true);
});

test("buildOpenSpecInstallMessage includes install command", () => {
  const message = buildOpenSpecInstallMessage("not found");
  assert.match(message, /npm install -g @fission-ai\/openspec/);
  assert.match(message, /not found/);
});
