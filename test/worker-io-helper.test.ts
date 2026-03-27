import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { ensureWorkerIoHelper } from "../src/worker/io-helper.ts";
import { buildAcpImplementationTurnPrompt } from "../src/worker/prompts.ts";
import { getRepoStatePaths } from "../src/utils/paths.ts";
import { readUtf8 } from "../src/utils/fs.ts";

test("worker io helper appends progress events via node command", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-worker-io-helper-"));
  const repoPath = path.join(tempRoot, "demo-app");
  await mkdir(repoPath, { recursive: true });
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await ensureWorkerIoHelper(repoStatePaths);

  const result = spawnSync(
    process.execPath,
    [
      repoStatePaths.workerIoFile,
      "event",
      "--kind",
      "status",
      "--current",
      "1",
      "--total",
      "3",
      "--task-id",
      "1.1",
      "--message",
      "Preparing 1.1: loading context. Next: read proposal.md.",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const raw = await readUtf8(repoStatePaths.workerProgressFile);
  const lines = raw.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]!);
  assert.equal(payload.kind, "status");
  assert.equal(payload.current, 1);
  assert.equal(payload.total, 3);
  assert.equal(payload.taskId, "1.1");
  assert.equal(payload.message, "Preparing 1.1: loading context. Next: read proposal.md.");
});

test("implementation prompt instructs the worker to use the helper", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-worker-io-prompt-"));
  const repoPath = path.join(tempRoot, "demo-app");
  const changeDir = path.join(repoPath, "openspec", "changes", "demo-change");
  await mkdir(changeDir, { recursive: true });
  await writeFile(path.join(changeDir, "proposal.md"), "# Proposal\n", "utf8");
  await writeFile(path.join(changeDir, "tasks.md"), "- [ ] 1.1 Demo task\n", "utf8");

  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  const prompt = buildAcpImplementationTurnPrompt({
    project: {
      version: 1,
      projectId: "project-1",
      channelKey: "discord:test:default:main",
      storagePath: path.join(repoStatePaths.root, "state.json"),
      status: "running",
      phase: "implementing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      repoPath,
      workspacePath: tempRoot,
      projectName: "demo-app",
      changeName: "demo-change",
      changeDir,
      pauseRequested: false,
    },
    repoStatePaths,
    apply: {
      changeName: "demo-change",
      changeDir,
      schemaName: "spec-driven",
      contextFiles: {
        proposal: path.join(changeDir, "proposal.md"),
        tasks: path.join(changeDir, "tasks.md"),
      },
      progress: { total: 1, complete: 0, remaining: 1 },
      tasks: [{ id: "1.1", description: "Demo task", done: false }],
      state: "ready",
      instruction: "Implement the remaining task.",
    },
    task: { id: "1.1", description: "Demo task" },
    tasks: [{ id: "1.1", description: "Demo task" }],
    mode: "apply",
  });

  assert.match(prompt, /Use the worker IO helper instead of editing .*worker-progress\.jsonl directly\./);
  assert.match(prompt, /worker_io\.mjs['"] event --kind <status\|task_start\|task_done\|blocked>/);
});
