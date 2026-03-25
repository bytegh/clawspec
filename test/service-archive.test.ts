import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { ProjectMemoryStore } from "../src/memory/store.ts";
import { ClawSpecService } from "../src/orchestrator/service.ts";
import { ProjectStateStore } from "../src/state/store.ts";
import { pathExists, writeUtf8 } from "../src/utils/fs.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";

test("service writes archive bundles from visible-execution state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-service-"));
  const repoPath = path.join(tempRoot, "repo");
  const workspacePath = path.join(tempRoot, "workspace");
  const changeName = "demo-change";
  await mkdir(path.join(repoPath, "openspec", "changes", changeName), { recursive: true });
  await mkdir(workspacePath, { recursive: true });

  await writeUtf8(
    path.join(repoPath, "openspec", "changes", changeName, "tasks.md"),
    [
      "## 1. Setup",
      "",
      "- [x] 1.1 Create plugin",
      "- [ ] 1.2 Add lifecycle store",
      "",
    ].join("\n"),
  );

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  const memoryStore = new ProjectMemoryStore(path.join(tempRoot, "memory.json"));
  const workspaceStore = new WorkspaceStore(path.join(tempRoot, "workspace-state.json"), workspacePath);
  await stateStore.initialize();
  await memoryStore.initialize();
  await workspaceStore.initialize();

  let project = await stateStore.createProject("channel:demo");
  project = await stateStore.updateProject("channel:demo", (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "repo",
    changeName,
    changeDir: path.join(repoPath, "openspec", "changes", changeName),
    latestSummary: "Latest summary text",
  }));

  const fakeApi = {
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  } as any;

  const service = new ClawSpecService({
    api: fakeApi,
    config: {} as any,
    logger: fakeApi.logger,
    stateStore,
    memoryStore,
    openSpec: {} as any,
    archiveDirName: "archives",
    defaultWorkspace: workspacePath,
    defaultWorkerAgentId: "codex",
    workspaceStore,
  });

  await (service as any).ensureProjectSupportFiles(project);
  const counts = await (service as any).loadTaskCounts(project);
  assert.equal(counts.complete, 1);
  assert.equal(counts.remaining, 1);

  const archivePath = await (service as any).writeArchiveBundle(project, counts);
  assert.equal(await pathExists(path.join(archivePath, "resume-context.md")), true);
  assert.equal(await pathExists(path.join(archivePath, "session-summary.md")), true);
  assert.equal(await pathExists(path.join(archivePath, "changed-files.md")), true);
  assert.equal(await pathExists(path.join(archivePath, "decision-log.md")), true);
  assert.equal(await pathExists(path.join(archivePath, "run-metadata.json")), true);
});
