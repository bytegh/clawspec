import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  ACPX_EXPECTED_VERSION,
  ACPX_PACKAGE_NAME,
  ensureAcpxCli,
} from "../src/dependencies/acpx.ts";

const ROOT_PREFIX = process.platform === "win32" ? "C:\\clawspec-test" : "/tmp/clawspec-test";
const OPENCLAW_PREFIX = process.platform === "win32" ? "C:\\openclaw-test" : "/opt/openclaw";

const LOCAL_COMMAND = path.join(
  ROOT_PREFIX,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "acpx.cmd" : "acpx",
);
const BUILTIN_COMMAND = path.join(
  OPENCLAW_PREFIX,
  "dist",
  "extensions",
  "acpx",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "acpx.cmd" : "acpx",
);
const OPENCLAW_RUNTIME_ENTRYPOINT = path.join(
  OPENCLAW_PREFIX,
  "dist",
  "index.js",
);

test("ensureAcpxCli uses the global acpx command when available", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await ensureAcpxCli({
    pluginRoot: ROOT_PREFIX,
    runner: async ({ command, args }) => {
      calls.push({ command, args });
      if (command === LOCAL_COMMAND) {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (command === "acpx") {
        return { code: 0, stdout: `${ACPX_EXPECTED_VERSION}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  });

  assert.equal(result.source, "global");
  assert.equal(result.version, ACPX_EXPECTED_VERSION);
  assert.equal(calls.some((call) => call.command === "npm"), false);
});

test("ensureAcpxCli accepts a newer global acpx version", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await ensureAcpxCli({
    pluginRoot: ROOT_PREFIX,
    runner: async ({ command, args }) => {
      calls.push({ command, args });
      if (command === LOCAL_COMMAND) {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (command === "acpx") {
        return { code: 0, stdout: "0.3.2\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  });

  assert.equal(result.source, "global");
  assert.equal(result.version, "0.3.2");
  assert.equal(calls.some((call) => call.command === "npm"), false);
});

test("ensureAcpxCli prefers the OpenClaw builtin acpx over an incompatible PATH acpx", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await ensureAcpxCli({
    pluginRoot: ROOT_PREFIX,
    runtimeEntrypoint: OPENCLAW_RUNTIME_ENTRYPOINT,
    runner: async ({ command, args }) => {
      calls.push({ command, args });
      if (command === LOCAL_COMMAND) {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (command === BUILTIN_COMMAND) {
        return { code: 0, stdout: `${ACPX_EXPECTED_VERSION}\n`, stderr: "" };
      }
      if (command === "acpx") {
        return { code: 0, stdout: "0.1.15\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  });

  assert.equal(result.source, "builtin");
  assert.equal(result.version, ACPX_EXPECTED_VERSION);
  assert.equal(result.command, BUILTIN_COMMAND);
  assert.equal(calls.some((call) => call.command === "npm"), false);
});

test("ensureAcpxCli installs a plugin-local acpx when none is available", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const installEvents: Array<{ packageName: string; reason: string; expectedVersion: string }> = [];
  let localCheckCount = 0;

  const result = await ensureAcpxCli({
    pluginRoot: ROOT_PREFIX,
    onInstallStart: async (event) => {
      installEvents.push(event);
    },
    runner: async ({ command, args }) => {
      calls.push({ command, args });
      if (command === LOCAL_COMMAND) {
        localCheckCount += 1;
        if (localCheckCount === 1) {
          return { code: 1, stdout: "", stderr: "not found" };
        }
        return { code: 0, stdout: `${ACPX_EXPECTED_VERSION}\n`, stderr: "" };
      }
      if (command === "acpx") {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (command === "npm") {
        return { code: 0, stdout: "installed\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  });

  assert.equal(result.source, "local");
  assert.equal(result.version, ACPX_EXPECTED_VERSION);
  assert.equal(
    calls.some((call) => call.command === "npm" && call.args.includes(`${ACPX_PACKAGE_NAME}@${ACPX_EXPECTED_VERSION}`)),
    true,
  );
  assert.deepEqual(installEvents, [{
    packageName: ACPX_PACKAGE_NAME,
    reason: "not found",
    expectedVersion: ACPX_EXPECTED_VERSION,
  }]);
});
