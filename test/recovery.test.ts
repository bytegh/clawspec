import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { pathExists, readUtf8, writeJsonFile, writeUtf8 } from "../src/utils/fs.ts";
import { getRepoStatePaths } from "../src/utils/paths.ts";
import { RollbackStore } from "../src/rollback/store.ts";
import { ProjectStateStore } from "../src/state/store.ts";
import { WatcherManager } from "../src/watchers/manager.ts";
import { createLogger, waitFor } from "./helpers/harness.ts";

function createWorkOpenSpec(changeDir: string, tasksPath: string) {
  return {
    instructionsApply: async (cwd: string, cn: string) => {
      const content = await readUtf8(tasksPath);
      const task1Done = content.includes("- [x] 1.1");
      const task2Done = content.includes("- [x] 1.2");
      const complete = (task1Done ? 1 : 0) + (task2Done ? 1 : 0);
      const total = content.includes("1.2") ? 2 : 1;
      return {
        command: `openspec instructions apply --change ${cn} --json`,
        cwd, stdout: "{}", stderr: "", durationMs: 1,
        parsed: {
          changeName: cn, changeDir, schemaName: "spec-driven",
          contextFiles: { tasks: tasksPath },
          progress: { total, complete, remaining: total - complete },
          tasks: total === 2
            ? [
                { id: "1.1", description: "First task", done: task1Done },
                { id: "1.2", description: "Second task", done: task2Done },
              ]
            : [{ id: "1.1", description: "Build the demo endpoint", done: task1Done }],
          state: complete === total ? "all_done" : "ready",
          instruction: "Implement the remaining task.",
        },
      };
    },
  } as any;
}

test("recovery from orphaned state (armed, no execution field)", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-recovery-orphan-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "orphan-recovery";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const outputPath = path.join(repoPath, "src", "demo.txt");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Build the demo endpoint\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async () => {
      await writeUtf8(tasksPath, "- [x] 1.1 Build the demo endpoint\n");
      await writeUtf8(outputPath, "demo\n");
      await writeJsonFile(getRepoStatePaths(repoPath, "archives").executionResultFile, {
        version: 1, changeName, mode: "apply", status: "done",
        timestamp: new Date().toISOString(), summary: "Completed task 1.1.",
        progressMade: true, completedTask: "1.1 Build the demo endpoint",
        changedFiles: ["src/demo.txt"], notes: ["Task completed"],
        taskCounts: { total: 1, complete: 1, remaining: 0 }, remainingTasks: 0,
      });
    },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const channelKey = "discord:orphan-recovery:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath, repoPath, projectName: "demo-app", projectTitle: "Demo App",
    changeName, changeDir, status: "armed", phase: "implementing",
    workerAgentId: "codex",
    currentTask: "1.1 Build the demo endpoint",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true, touchedFileCount: 0,
    },
    // execution is intentionally NOT set — simulates orphaned state
  }));

  // Create stale tmp file to verify cleanup
  const clawspecDir = path.join(repoPath, ".openclaw", "clawspec");
  await writeUtf8(path.join(clawspecDir, "state.json.12345.999999.tmp"), "stale");

  const manager = new WatcherManager({
    stateStore,
    openSpec: createWorkOpenSpec(changeDir, tasksPath),
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: 25,
  });

  await manager.start();
  await waitFor(async () => (await stateStore.getActiveProject(channelKey))?.status === "done");
  await manager.stop();

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "done");
  assert.equal(project?.phase, "validating");
  assert.equal(notifierMessages.some((m) => m.includes("Gateway restarted")), true);
  assert.equal(notifierMessages.some((m) => m.includes("All tasks complete")), true);
  assert.equal(await pathExists(path.join(clawspecDir, "state.json.12345.999999.tmp")), false);
});

test("recovery from mid-crash running state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-recovery-midcrash-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "midcrash-recovery";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [x] 1.1 First task\n- [ ] 1.2 Second task\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async () => {
      await writeUtf8(tasksPath, "- [x] 1.1 First task\n- [x] 1.2 Second task\n");
      await writeJsonFile(getRepoStatePaths(repoPath, "archives").executionResultFile, {
        version: 1, changeName, mode: "apply", status: "done",
        timestamp: new Date().toISOString(), summary: "Completed task 1.2.",
        progressMade: true, completedTask: "1.2 Second task",
        changedFiles: [], notes: ["Task completed"],
        taskCounts: { total: 2, complete: 2, remaining: 0 }, remainingTasks: 0,
      });
    },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const channelKey = "discord:midcrash-recovery:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath, repoPath, projectName: "demo-app", projectTitle: "Demo App",
    changeName, changeDir, status: "running", phase: "implementing",
    workerAgentId: "codex",
    currentTask: "1.2 Second task",
    taskCounts: { total: 2, complete: 1, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    execution: {
      mode: "apply", action: "work", state: "running",
      workerAgentId: "codex", workerSlot: "primary",
      armedAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      sessionKey: "clawspec:dead-session",
      lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    },
  }));

  const manager = new WatcherManager({
    stateStore,
    openSpec: createWorkOpenSpec(changeDir, tasksPath),
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: 25,
  });

  await manager.start();
  await waitFor(async () => (await stateStore.getActiveProject(channelKey))?.status === "done");
  await manager.stop();

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "done");
  assert.equal(notifierMessages.some((m) => m.includes("Gateway restarted")), true);
});

test("recovery from recoverable blocked implementation state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-recovery-blocked-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "blocked-recovery";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const outputPath = path.join(repoPath, "src", "recovered.txt");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Resume after backend startup race\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async () => {
      await writeUtf8(tasksPath, "- [x] 1.1 Resume after backend startup race\n");
      await writeUtf8(outputPath, "recovered\n");
      await writeJsonFile(getRepoStatePaths(repoPath, "archives").executionResultFile, {
        version: 1,
        changeName,
        mode: "apply",
        status: "done",
        timestamp: new Date().toISOString(),
        summary: "Recovered from blocked startup state.",
        progressMade: true,
        completedTask: "1.1 Resume after backend startup race",
        changedFiles: ["src/recovered.txt"],
        notes: ["Recovered after ACP runtime backend became ready."],
        taskCounts: { total: 1, complete: 1, remaining: 0 },
        remainingTasks: 0,
      });
    },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const channelKey = "discord:blocked-recovery:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "blocked",
    phase: "implementing",
    workerAgentId: "codex",
    currentTask: "1.1 Resume after backend startup race",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    latestSummary: "Execution failed: ACP runtime backend is currently unavailable. Try again in a moment.",
    blockedReason: "ACP runtime backend is currently unavailable. Try again in a moment.",
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: undefined,
    lastExecution: {
      version: 1,
      changeName,
      mode: "apply",
      status: "blocked",
      timestamp: new Date().toISOString(),
      summary: "Execution failed: ACP runtime backend is currently unavailable. Try again in a moment.",
      progressMade: false,
      changedFiles: [],
      notes: ["ACP runtime backend is currently unavailable. Try again in a moment."],
      blocker: "ACP runtime backend is currently unavailable. Try again in a moment.",
      taskCounts: { total: 1, complete: 0, remaining: 1 },
      remainingTasks: 1,
    },
    lastExecutionAt: new Date().toISOString(),
  }));

  const manager = new WatcherManager({
    stateStore,
    openSpec: createWorkOpenSpec(changeDir, tasksPath),
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: 25,
  });

  await manager.start();
  await waitFor(async () => (await stateStore.getActiveProject(channelKey))?.status === "done");
  await manager.stop();

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "done");
  assert.equal(project?.phase, "validating");
  assert.equal(notifierMessages.some((m) => m.includes("Gateway restarted")), true);
  assert.equal(notifierMessages.some((m) => m.includes("All tasks complete")), true);
});

test("rearm never drops execution field (batch mode)", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-rearm-safe-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "rearm-safe";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Build it\n- [ ] 1.2 Test it\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  let turnCount = 0;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async () => {
      turnCount += 1;
      await writeUtf8(tasksPath, "- [x] 1.1 Build it\n- [x] 1.2 Test it\n");
      await writeJsonFile(getRepoStatePaths(repoPath, "archives").executionResultFile, {
        version: 1, changeName, mode: "apply", status: "done",
        timestamp: new Date().toISOString(), summary: "Completed 2 tasks.",
        progressMade: true, completedTask: "1.2 Test it",
        changedFiles: [], notes: ["Completed all tasks in batch."],
        taskCounts: { total: 2, complete: 2, remaining: 0 },
      });
    },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const channelKey = "discord:rearm-safe:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath, repoPath, projectName: "demo-app", projectTitle: "Demo App",
    changeName, changeDir, status: "armed", phase: "implementing",
    currentTask: "1.1 Build it",
    taskCounts: { total: 2, complete: 0, remaining: 2 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true, touchedFileCount: 0,
    },
    execution: {
      mode: "apply", action: "work", state: "armed", armedAt: new Date().toISOString(),
    },
  }));

  const manager = new WatcherManager({
    stateStore,
    openSpec: createWorkOpenSpec(changeDir, tasksPath),
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async () => undefined } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: 25,
  });

  await manager.start();
  await manager.wake(channelKey);
  await waitFor(async () => (await stateStore.getActiveProject(channelKey))?.status === "done");
  await manager.stop();

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "done");
  assert.equal(project?.phase, "validating");
  assert.equal(turnCount, 1);
});

test("startup recovery does not spawn a worker for visible chat planning", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-recovery-visible-plan-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "visible-plan";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];
  let runCount = 0;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async () => {
      runCount += 1;
    },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const channelKey = "discord:visible-plan:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "planning",
    phase: "planning_sync",
    planningJournal: {
      dirty: true,
      entryCount: 1,
      lastEntryAt: new Date(Date.now() - 60_000).toISOString(),
    },
    execution: undefined,
  }));

  const manager = new WatcherManager({
    stateStore,
    openSpec: createWorkOpenSpec(changeDir, path.join(changeDir, "tasks.md")),
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: 25,
  });

  await manager.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await manager.stop();

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(runCount, 0);
  assert.equal(project?.status, "planning");
  assert.equal(project?.phase, "planning_sync");
  assert.equal(notifierMessages.length, 0);
});
