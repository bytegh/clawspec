import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { ActiveProjectConflictError, ProjectStateStore } from "../src/state/store.ts";

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
