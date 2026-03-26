import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { runShellCommand } from "../src/utils/shell-command.ts";

test("runShellCommand handles cwd and script paths that contain spaces", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-shell-"));
  const spaceDir = path.join(tempRoot, "space dir");
  const scriptPath = path.join(spaceDir, "echo script.js");
  await mkdir(spaceDir, { recursive: true });
  await writeFile(scriptPath, `
console.log(process.cwd());
console.log(process.argv[2]);
`, "utf8");

  const result = await runShellCommand({
    command: process.execPath,
    args: [scriptPath, "hello world"],
    cwd: spaceDir,
    timeoutMs: 2_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /space dir/);
  assert.match(result.stdout, /hello world/);
});

test("runShellCommand surfaces timeout errors", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-shell-timeout-"));
  const scriptPath = path.join(tempRoot, "sleep.js");
  await writeFile(scriptPath, `
setTimeout(() => {
  console.log("finished");
}, 5_000);
`, "utf8");

  const result = await runShellCommand({
    command: process.execPath,
    args: [scriptPath],
    cwd: tempRoot,
    timeoutMs: 100,
  });

  assert.match(result.error?.message ?? "", /timed out/i);
});
