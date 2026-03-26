import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { withFileLock } from "../src/state/locks.ts";

test("withFileLock blocks competing processes on the same lock file", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-lock-"));
  const lockPath = path.join(tempRoot, "shared.lock");
  const workerPath = path.join(tempRoot, "lock-worker.mjs");
  const lockModuleUrl = pathToFileURL(path.join(process.cwd(), "src", "state", "locks.ts")).href;

  await writeFile(workerPath, `
import { withFileLock } from ${JSON.stringify(lockModuleUrl)};

const lockPath = process.argv[2];
await withFileLock(lockPath, async () => {
  process.stdout.write("acquired\\n");
});
`, "utf8");

  let childOutput = "";
  let childError = "";
  let child: ReturnType<typeof spawn> | undefined;

  t.after(() => {
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        return;
      }
    }
  });

  await withFileLock(lockPath, async () => {
    child = spawn(process.execPath, ["--experimental-strip-types", workerPath, lockPath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      childOutput += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      childError += chunk;
    });

    await delay(150);
    assert.equal(childOutput.includes("acquired"), false);
  });

  await waitFor(() => childOutput.includes("acquired"));
  const exitCode = await new Promise<number | null>((resolve) => {
    child?.once("close", (code) => resolve(code));
  });

  assert.equal(exitCode, 0, childError || undefined);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await delay(25);
  }
  throw new Error("timed out waiting for lock handoff");
}
