import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { AcpWorkerClient } from "../src/acp/client.ts";

test("AcpWorkerClient tracks active worker lifecycle through acpx CLI", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-acpx-client-"));
  const fake = await createFakeAcpx(tempRoot);
  const client = new AcpWorkerClient({
    agentId: "codex",
    logger: createLogger(),
    command: fake.command,
    env: fake.env,
  });

  const events: Array<{ type: string; text?: string }> = [];
  const runPromise = client.runTurn({
    sessionKey: "session-1",
    cwd: tempRoot,
    text: "fix tests",
    onEvent: async (event) => {
      events.push(event);
    },
  });

  await waitFor(async () => {
    const status = await client.getSessionStatus({
      sessionKey: "session-1",
      cwd: tempRoot,
      agentId: "codex",
    });
    return status?.details?.status === "alive";
  });

  await runPromise;

  const finalStatus = await client.getSessionStatus({
    sessionKey: "session-1",
    cwd: tempRoot,
    agentId: "codex",
  });

  assert.equal(events.some((event) => event.type === "text_delta" && event.text?.includes("Working on fix tests")), true);
  assert.match(finalStatus?.summary ?? "", /status=dead/);
});

async function createFakeAcpx(tempRoot: string): Promise<{ command: string; env: NodeJS.ProcessEnv }> {
  const scriptPath = path.join(tempRoot, "fake-acpx.js");
  const wrapperPath = path.join(tempRoot, process.platform === "win32" ? "fake-acpx.cmd" : "fake-acpx");

  await writeFile(scriptPath, `
const fs = require("node:fs/promises");
const path = require("node:path");

const args = process.argv.slice(2);
const stateDir = process.env.FAKE_ACPX_STATE;

function consumeGlobals(argv) {
  const out = [...argv];
  const result = [];
  while (out.length > 0) {
    const head = out[0];
    if (head === "--format" || head === "--cwd" || head === "--ttl") {
      out.shift();
      out.shift();
      continue;
    }
    if (head === "--json-strict" || head === "--approve-all" || head === "--approve-reads" || head === "--deny-all") {
      out.shift();
      continue;
    }
    result.push(...out);
    break;
  }
  return result;
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) {
    return argv[index + 1];
  }
  return undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function writeJsonLine(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

async function main() {
  if (args.includes("--version")) {
    process.stdout.write("0.3.1\\n");
    return;
  }

  const rest = consumeGlobals(args);
  const agent = rest[0];
  const verb = rest[1];
  const tail = rest.slice(2);
  const sessionName = flagValue(tail, "--session") || flagValue(tail, "--name") || tail[1];
  const sessionFile = sessionName ? path.join(stateDir, sessionName + ".json") : "";
  const runningFile = sessionName ? path.join(stateDir, sessionName + ".running") : "";

  async function sessionExists() {
    try {
      await fs.access(sessionFile);
      return true;
    } catch {
      return false;
    }
  }

  async function runningExists() {
    try {
      await fs.access(runningFile);
      return true;
    } catch {
      return false;
    }
  }

  if (verb === "sessions" && tail[0] === "ensure") {
    if (await sessionExists()) {
      await writeJsonLine({ acpxRecordId: "record-" + sessionName, acpxSessionId: "backend-" + sessionName, agentSessionId: "agent-" + sessionName, agent });
      return;
    }
    await writeJsonLine({ type: "error", code: "NO_SESSION", message: "missing session" });
    return;
  }

  if (verb === "sessions" && tail[0] === "new") {
    await fs.writeFile(sessionFile, JSON.stringify({ sessionName, agent }), "utf8");
    await writeJsonLine({ acpxRecordId: "record-" + sessionName, acpxSessionId: "backend-" + sessionName, agentSessionId: "agent-" + sessionName, agent });
    return;
  }

  if (verb === "status") {
    if (!(await sessionExists())) {
      await writeJsonLine({ type: "error", code: "NO_SESSION", message: "missing session" });
      return;
    }
    await writeJsonLine({
      status: await runningExists() ? "alive" : "dead",
      acpxRecordId: "record-" + sessionName,
      acpxSessionId: "backend-" + sessionName,
      agentSessionId: "agent-" + sessionName,
      pid: 1234,
    });
    return;
  }

  if (verb === "cancel") {
    await fs.rm(runningFile, { force: true });
    await writeJsonLine({ ok: true });
    return;
  }

  if (verb === "prompt") {
    const text = (await readStdin()).trim();
    await fs.writeFile(runningFile, "running", "utf8");
    process.on("SIGTERM", async () => {
      await fs.rm(runningFile, { force: true });
      process.exit(143);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await writeJsonLine({ text: "Working on " + text });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await fs.rm(runningFile, { force: true });
    await writeJsonLine({ type: "done" });
    return;
  }

  if (verb === "sessions" && tail[0] === "close") {
    await fs.rm(sessionFile, { force: true });
    await fs.rm(runningFile, { force: true });
    await writeJsonLine({ ok: true });
    return;
  }

  process.stderr.write("unexpected args: " + JSON.stringify(args));
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
`, "utf8");

  if (process.platform === "win32") {
    await writeFile(wrapperPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`, "utf8");
  } else {
    await writeFile(wrapperPath, `#!/usr/bin/env bash\nnode "${scriptPath}" "$@"\n`, "utf8");
    await chmod(wrapperPath, 0o755);
  }

  return {
    command: wrapperPath,
    env: {
      ...process.env,
      FAKE_ACPX_STATE: tempRoot,
    },
  };
}

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}
