import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { ActiveProjectConflictError, ProjectStateStore } from "../src/state/store.ts";
import { readJsonFile, removeIfExists, writeJsonFile } from "../src/utils/fs.ts";
import { getActiveProjectMapPath, getPluginStateRoot } from "../src/utils/paths.ts";
import { withFileLock } from "../src/state/locks.ts";

test("state store enforces one active project per channel and migrates to repo-local state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-state-"));
  const repoPath = path.join(tempRoot, "repo");
  await mkdir(repoPath, { recursive: true });

  const store = new ProjectStateStore(tempRoot, "archives");
  await store.initialize();

  const project = await store.createProject("channel:demo");
  assert.equal(project.status, "idle");

  await assert.rejects(() => store.createProject("channel:demo"), ActiveProjectConflictError);

  const updated = await store.setRepoPath("channel:demo", repoPath, "demo");
  assert.equal(updated.repoPath, repoPath);
  assert.match(updated.storagePath, /\.openclaw[\\\/]clawspec[\\\/]state\.json$/);

  const described = await store.setDescription(
    "channel:demo",
    "Build the project orchestrator",
    "Build the project orchestrator",
    "build-project-orchestrator",
  );
  assert.equal(described.changeName, "build-project-orchestrator");
  assert.equal((await store.getActiveProject("channel:demo"))?.repoPath, repoPath);
  assert.equal((await store.listActiveProjects()).length, 1);
});

test("updateProject waits for the active map lock instead of failing on a transiently missing map file", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-state-lock-"));
  const store = new ProjectStateStore(tempRoot, "archives");
  await store.initialize();
  await store.createProject("channel:demo");

  const activeMapPath = getActiveProjectMapPath(tempRoot);
  const activeMapLockPath = path.join(getPluginStateRoot(tempRoot), "locks", "active-projects.lock");
  const originalMap = await readJsonFile(activeMapPath, { version: 1, channels: {} as Record<string, unknown> });

  let settled = false;
  let updatePromise: Promise<unknown> | undefined;

  await withFileLock(activeMapLockPath, async () => {
    await removeIfExists(activeMapPath);
    updatePromise = store.updateProject("channel:demo", (current) => ({
      ...current,
      latestSummary: "updated after lock release",
    }));
    updatePromise.finally(() => {
      settled = true;
    });

    await delay(50);
    assert.equal(settled, false);

    await writeJsonFile(activeMapPath, originalMap);
  });

  const updated = await updatePromise;
  assert.equal((updated as { latestSummary?: string }).latestSummary, "updated after lock release");
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
