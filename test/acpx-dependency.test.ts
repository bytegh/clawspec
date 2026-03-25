import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  ACPX_EXPECTED_VERSION,
  ACPX_PACKAGE_NAME,
  ensureAcpxCli,
} from "../src/dependencies/acpx.ts";

const LOCAL_COMMAND = path.join(
  "C:\\plugin-root",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "acpx.cmd" : "acpx",
);
const BUILTIN_COMMAND = path.join(
  "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\openclaw",
  "dist",
  "extensions",
  "acpx",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "acpx.cmd" : "acpx",
);
const OPENCLAW_RUNTIME_ENTRYPOINT = path.join(
  "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\openclaw",
  "dist",
  "index.js",
);

test("ensureAcpxCli uses the global acpx command when available", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await ensureAcpxCli({
    pluginRoot: "C:\\plugin-root",
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

test("ensureAcpxCli prefers the OpenClaw builtin acpx over an incompatible PATH acpx", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await ensureAcpxCli({
    pluginRoot: "C:\\plugin-root",
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
  let localCheckCount = 0;

  const result = await ensureAcpxCli({
    pluginRoot: "C:\\plugin-root",
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
});
