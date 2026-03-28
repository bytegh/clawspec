import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { pathExists, readJsonFile, readUtf8, writeJsonFile, writeUtf8 } from "../src/utils/fs.ts";
import { getRepoStatePaths } from "../src/utils/paths.ts";
import { RollbackStore } from "../src/rollback/store.ts";
import { ProjectStateStore } from "../src/state/store.ts";
import { WatcherManager, describeWorkerStartupTimeout, shouldAbortWorkerStartup } from "../src/watchers/manager.ts";
import { createLogger, waitFor } from "./helpers/harness.ts";

const TEST_WATCHER_POLL_INTERVAL_MS = 1_000;
const TEST_WAIT_TIMEOUT_MS = 60_000;

function hasMessage(messages: string[], ...parts: string[]): boolean {
  return messages.some((message) => parts.every((part) => message.includes(part)));
}

async function readProjectState(repoPath: string) {
  return await readJsonFile<any>(getRepoStatePaths(repoPath, "archives").stateFile, null);
}

async function waitForProjectState(
  repoPath: string,
  predicate: (project: any) => boolean,
  timeoutMs = TEST_WAIT_TIMEOUT_MS,
): Promise<void> {
  await waitFor(async () => predicate(await readProjectState(repoPath)), timeoutMs);
}

test("queue owner unavailable is treated as a non-fatal startup state", () => {
  const status = {
    summary: "status=dead acpxRecordId=session-1",
    details: {
      status: "dead",
      summary: "queue owner unavailable",
    },
  } as any;

  assert.equal(shouldAbortWorkerStartup(status), false);
  assert.equal(describeWorkerStartupTimeout(status), undefined);
});

test("watcher work flow completes", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-work-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const outputPath = path.join(repoPath, "src", "demo.txt");
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Build the demo endpoint\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => {
      const done = (await readUtf8(tasksPath)).includes("- [x] 1.1 Build the demo endpoint");
      return {
        command: `openspec instructions apply --change ${cn} --json`,
        cwd,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        parsed: {
          changeName: cn,
          changeDir,
          schemaName: "spec-driven",
          contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
          progress: done ? { total: 1, complete: 1, remaining: 0 } : { total: 1, complete: 0, remaining: 1 },
          tasks: [{ id: "1.1", description: "Build the demo endpoint", done }],
          state: done ? "all_done" : "ready",
          instruction: "Implement the remaining task.",
        },
      };
    },
  } as any;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async (params: {
      onReady?: () => Promise<void> | void;
      onEvent?: (event: { type: string; title?: string }) => Promise<void> | void;
    }) => {
      await params.onReady?.();
      const startEvent = JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: "task_start",
        current: 1,
        total: 1,
        taskId: "1.1",
        message: "Start 1.1: build the demo endpoint. Next: finish this task.",
      });
      await writeUtf8(repoStatePaths.workerProgressFile, `${startEvent}\n`);
      await params.onEvent?.({ type: "tool_call", title: "worker-progress" });

      await writeUtf8(tasksPath, "- [x] 1.1 Build the demo endpoint\n");
      await writeUtf8(outputPath, "demo\n");

      const doneEvent = JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: "task_done",
        current: 1,
        total: 1,
        taskId: "1.1",
        message: "Done 1.1: built the demo endpoint. Changed 2 files: openspec/changes/watch-work/tasks.md, src/demo.txt. Next: done.",
      });
      await writeUtf8(repoStatePaths.workerProgressFile, `${startEvent}\n${doneEvent}\n`);
      await writeJsonFile(repoStatePaths.executionResultFile, {
        version: 1,
        changeName,
        mode: "apply",
        status: "done",
        timestamp: new Date().toISOString(),
        summary: "Completed task 1.1.",
        progressMade: true,
        completedTask: "1.1 Build the demo endpoint",
        changedFiles: ["openspec/changes/watch-work/tasks.md", "src/demo.txt"],
        notes: ["Task completed"],
        taskCounts: { total: 1, complete: 1, remaining: 0 },
        remainingTasks: 0,
      });
    },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    await manager.stop();
  });

  const channelKey = "discord:watch-work:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1.1 Build the demo endpoint",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
    },
  }));

  await manager.start();
  await manager.wake(channelKey);
  await waitForProjectState(
    repoPath,
    (project) =>
      project?.status === "done"
      && hasMessage(notifierMessages, "demo-app-watch-work", "All tasks complete", "/clawspec archive"),
  );

  const project = await stateStore.getActiveProject(channelKey);
  const manifest = await rollbackStore.readManifest();
  assert.equal(project?.status, "done");
  assert.equal(project?.phase, "validating");
  assert.equal(await pathExists(outputPath), true);
  assert.equal(manifest?.files.some((entry) => entry.path === "src/demo.txt"), true);
  assert.equal(notifierMessages.some((message) => message.includes("Run node") || message.includes("Run shell command")), false);
  assert.equal(hasMessage(notifierMessages, "Watcher active. Starting codex worker for task 1.1"), true);
  assert.equal(hasMessage(notifierMessages, "ACP worker connected with codex"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work", "[######] 1/1", "Start 1.1: build the demo endpoint"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work", "[######] 1/1", "Done 1.1: built the demo endpoint"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work", "[######] 1/1", "All tasks complete", "/clawspec archive"), true);
  assert.match(notifierMessages.find((message) => message.includes("Start 1.1: build the demo endpoint")) ?? "", /\*\*demo-app-watch-work\*\*/);
  assert.match(notifierMessages.find((message) => message.includes("Start 1.1: build the demo endpoint")) ?? "", /\nNext:/);
  assert.match(notifierMessages.find((message) => message.includes("Done 1.1: built the demo endpoint")) ?? "", /\n(Changed 2 files:|Files:)/);
  const watcherStartIndex = notifierMessages.findIndex((message) => message.includes("Watcher active. Starting codex worker"));
  const workerReadyIndex = notifierMessages.findIndex((message) => message.includes("ACP worker connected with codex"));
  const taskStartIndex = notifierMessages.findIndex((message) => message.includes("Start 1.1: build the demo endpoint"));
  assert.equal(watcherStartIndex >= 0, true);
  assert.equal(workerReadyIndex >= 0, true);
  assert.equal(taskStartIndex >= 0, true);
  assert.equal(watcherStartIndex < workerReadyIndex, true);
  assert.equal(workerReadyIndex < taskStartIndex, true);
});

test("worker progress display compacts absolute paths across separators", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-work-paths-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work-paths";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const specPath = path.join(changeDir, "specs", "md5-hash-api", "spec.md");
  const outputPath = path.join(repoPath, "src", "demo.txt");
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await mkdir(path.dirname(specPath), { recursive: true });
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Build the demo endpoint\n");
  await writeUtf8(specPath, "# Spec\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => {
      const done = (await readUtf8(tasksPath)).includes("- [x] 1.1 Build the demo endpoint");
      return {
        command: `openspec instructions apply --change ${cn} --json`,
        cwd,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        parsed: {
          changeName: cn,
          changeDir,
          schemaName: "spec-driven",
          contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
          progress: done ? { total: 1, complete: 1, remaining: 0 } : { total: 1, complete: 0, remaining: 1 },
          tasks: [{ id: "1.1", description: "Build the demo endpoint", done }],
          state: done ? "all_done" : "ready",
          instruction: "Implement the remaining task.",
        },
      };
    },
  } as any;

  const displaySpecPath = specPath.replace(/[\\/]+/g, "\\");
  const displayOutputPath = outputPath.replace(/[\\/]+/g, "/");

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async (params: {
      onReady?: () => Promise<void> | void;
      onEvent?: (event: { type: string; title?: string }) => Promise<void> | void;
    }) => {
      await params.onReady?.();
      const startEvent = JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: "task_start",
        current: 1,
        total: 1,
        taskId: "1.1",
        message: `Loaded ${displaySpecPath}. Next: read tasks.`,
      });
      await writeUtf8(repoStatePaths.workerProgressFile, `${startEvent}\n`);
      await params.onEvent?.({ type: "tool_call", title: "worker-progress" });

      await writeUtf8(tasksPath, "- [x] 1.1 Build the demo endpoint\n");
      await writeUtf8(outputPath, "demo\n");

      const doneEvent = JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: "task_done",
        current: 1,
        total: 1,
        taskId: "1.1",
        message: `Done 1.1: built the demo endpoint. Changed 1 files: ${displayOutputPath}. Next: done.`,
      });
      await writeUtf8(repoStatePaths.workerProgressFile, `${startEvent}\n${doneEvent}\n`);
      await writeJsonFile(repoStatePaths.executionResultFile, {
        version: 1,
        changeName,
        mode: "apply",
        status: "done",
        timestamp: new Date().toISOString(),
        summary: "Completed task 1.1.",
        progressMade: true,
        completedTask: "1.1 Build the demo endpoint",
        changedFiles: ["src/demo.txt"],
        notes: ["Task completed"],
        taskCounts: { total: 1, complete: 1, remaining: 0 },
        remainingTasks: 0,
      });
    },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    await manager.stop();
  });

  const channelKey = "discord:watch-work-paths:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1.1 Build the demo endpoint",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
    },
  }));

  await manager.start();
  await manager.wake(channelKey);
  await waitForProjectState(
    repoPath,
    (project) =>
      project?.status === "done"
      && hasMessage(
        notifierMessages,
        "Loaded demo-app@watch-work-paths:specs/md5-hash-api/spec.md",
        "Next: read tasks",
      )
      && hasMessage(
        notifierMessages,
        "demo-app@watch-work-paths:src/demo.txt",
        "Next: done",
      ),
  );

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(
    notifierMessages.some((message) => message.includes(displaySpecPath) || message.includes(displayOutputPath)),
    false,
  );
  assert.equal(project?.status, "done");
});

test("worker progress events keep running state in sync before execution finishes", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-work-progress-sync-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work-progress-sync";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  let releaseFinalStep!: () => void;
  const finalStep = new Promise<void>((resolve) => {
    releaseFinalStep = resolve;
  });

  await mkdir(changeDir, { recursive: true });
  await writeUtf8(
    tasksPath,
    "- [ ] 1.1 Define upload contracts\n- [ ] 1.2 Add multipart parsing\n",
  );
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => {
      const content = await readUtf8(tasksPath);
      const task1Done = content.includes("- [x] 1.1");
      const task2Done = content.includes("- [x] 1.2");
      const complete = (task1Done ? 1 : 0) + (task2Done ? 1 : 0);
      return {
        command: `openspec instructions apply --change ${cn} --json`,
        cwd,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        parsed: {
          changeName: cn,
          changeDir,
          schemaName: "spec-driven",
          contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
          progress: { total: 2, complete, remaining: 2 - complete },
          tasks: [
            { id: "1.1", description: "Define upload contracts", done: task1Done },
            { id: "1.2", description: "Add multipart parsing", done: task2Done },
          ],
          state: complete === 2 ? "all_done" : "ready",
          instruction: "Implement the remaining task.",
        },
      };
    },
  } as any;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async (params: { onEvent?: (event: { type: string; title?: string }) => Promise<void> | void }) => {
      const startEvent1 = JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: "task_start",
        current: 1,
        total: 2,
        taskId: "1.1",
        message: "Start 1.1: define upload contracts. Next: write shared metadata.",
      });
      await writeUtf8(repoStatePaths.workerProgressFile, `${startEvent1}\n`);
      await params.onEvent?.({ type: "tool_call", title: "worker-progress" });

      await writeUtf8(
        tasksPath,
        "- [x] 1.1 Define upload contracts\n- [ ] 1.2 Add multipart parsing\n",
      );
      const doneEvent1 = JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: "task_done",
        current: 1,
        total: 2,
        taskId: "1.1",
        message: "Done 1.1: added shared upload contracts. Changed 1 files: openspec/changes/watch-work-progress-sync/tasks.md. Next: 1.2.",
      });
      const startEvent2 = JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: "task_start",
        current: 2,
        total: 2,
        taskId: "1.2",
        message: "Start 1.2: add multipart parsing. Next: implement parser checks.",
      });
      await writeUtf8(repoStatePaths.workerProgressFile, `${startEvent1}\n${doneEvent1}\n${startEvent2}\n`);
      await params.onEvent?.({ type: "tool_call", title: "worker-progress" });

      await finalStep;

      await writeUtf8(
        tasksPath,
        "- [x] 1.1 Define upload contracts\n- [x] 1.2 Add multipart parsing\n",
      );
      await writeJsonFile(repoStatePaths.executionResultFile, {
        version: 1,
        changeName,
        mode: "apply",
        status: "done",
        timestamp: new Date().toISOString(),
        summary: "Completed task 1.2.",
        progressMade: true,
        completedTask: "1.2 Add multipart parsing",
        changedFiles: ["openspec/changes/watch-work-progress-sync/tasks.md"],
        notes: ["Task completed"],
        taskCounts: { total: 2, complete: 2, remaining: 0 },
        remainingTasks: 0,
      });
    },
    getSessionStatus: async () => ({ summary: "status=running", details: { status: "running" } }),
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    await manager.stop();
  });

  const channelKey = "discord:watch-work-progress-sync:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1.1 Define upload contracts",
    taskCounts: { total: 2, complete: 0, remaining: 2 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
    },
  }));

  await manager.start();
  await manager.wake(channelKey);
  await waitForProjectState(repoPath, (project) =>
    project?.status === "running"
      && project.taskCounts?.complete === 1
      && project.taskCounts?.remaining === 1
      && project.currentTask === "1.2 Add multipart parsing"
      && project.latestSummary?.includes("Start 1.2") === true
      && project.execution?.currentTaskId === "1.2",
  );

  releaseFinalStep();
  await waitForProjectState(repoPath, (project) => project?.status === "done");

  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-progress-sync", "1/2", "Done 1.1"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-progress-sync", "2/2", "Start 1.2"), true);
});

test("watcher restarts implementation worker after ACP runtime exit", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-work-restart-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work-restart";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const outputPath = path.join(repoPath, "src", "demo.txt");
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Build the demo endpoint\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];
  let runCount = 0;

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => {
      const done = (await readUtf8(tasksPath)).includes("- [x] 1.1 Build the demo endpoint");
      return {
        command: `openspec instructions apply --change ${cn} --json`,
        cwd,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        parsed: {
          changeName: cn,
          changeDir,
          schemaName: "spec-driven",
          contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
          progress: done ? { total: 1, complete: 1, remaining: 0 } : { total: 1, complete: 0, remaining: 1 },
          tasks: [{ id: "1.1", description: "Build the demo endpoint", done }],
          state: done ? "all_done" : "ready",
          instruction: "Implement the remaining task.",
        },
      };
    },
  } as any;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async () => {
      runCount += 1;
      if (runCount === 1) {
        const startEvent = JSON.stringify({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: "task_start",
          current: 1,
          total: 1,
          taskId: "1.1",
          message: "Start 1.1: build the demo endpoint. Next: finish this task.",
        });
        const doneEvent = JSON.stringify({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: "task_done",
          current: 1,
          total: 1,
          taskId: "1.1",
          message: "Done 1.1: built the demo endpoint. Changed 2 files: openspec/changes/watch-work-restart/tasks.md, src/demo.txt. Next: done.",
        });
        await writeUtf8(repoStatePaths.workerProgressFile, `${startEvent}\n${doneEvent}\n`);
        await writeUtf8(tasksPath, "- [x] 1.1 Build the demo endpoint\n");
        await writeUtf8(outputPath, "demo\n");
        throw new Error("acpx exited with code 1");
      }

      await writeUtf8(tasksPath, "- [x] 1.1 Build the demo endpoint\n");
      await writeUtf8(outputPath, "demo\n");
      await writeJsonFile(repoStatePaths.executionResultFile, {
        version: 1,
        changeName,
        mode: "apply",
        status: "done",
        timestamp: new Date().toISOString(),
        summary: "Completed task 1.1.",
        progressMade: true,
        completedTask: "1.1 Build the demo endpoint",
        changedFiles: ["openspec/changes/watch-work-restart/tasks.md", "src/demo.txt"],
        notes: ["Task completed"],
        taskCounts: { total: 1, complete: 1, remaining: 0 },
        remainingTasks: 0,
      });
    },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    await manager.stop();
  });

  const channelKey = "discord:watch-work-restart:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1.1 Build the demo endpoint",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
    },
  }));

  await manager.start();
  await manager.wake(channelKey);
  await waitForProjectState(
    repoPath,
    (project) =>
      project?.status === "done"
      && hasMessage(notifierMessages, "demo-app-watch-work-restart", "All tasks complete", "/clawspec archive"),
  );

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "done");
  assert.equal(project?.lastExecution?.status, "done");
  assert.equal(runCount, 1);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-restart", "Restarting ACP worker", "retry task 1.1"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-restart", "All tasks complete", "/clawspec archive"), true);
  assert.equal(notifierMessages.some((message) => message.includes("Blocked:")), false);
  const progress = await readUtf8(repoStatePaths.progressFile);
  assert.match(progress, /- status: done/);
  assert.doesNotMatch(progress, /- status: blocked/);
});

test("watcher restarts a dead ACP session after progress stalls", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-work-dead-session-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work-dead-session";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Recover dead session\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];
  let runCount = 0;

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => {
      const done = (await readUtf8(tasksPath)).includes("- [x] 1.1 Recover dead session");
      return {
        command: `openspec instructions apply --change ${cn} --json`,
        cwd,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        parsed: {
          changeName: cn,
          changeDir,
          schemaName: "spec-driven",
          contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
          progress: done ? { total: 1, complete: 1, remaining: 0 } : { total: 1, complete: 0, remaining: 1 },
          tasks: [{ id: "1.1", description: "Recover dead session", done }],
          state: done ? "all_done" : "ready",
          instruction: "Implement the remaining task.",
        },
      };
    },
  } as any;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async (
      params: {
        signal?: AbortSignal;
        onEvent?: (event: { type: string; title?: string }) => Promise<void> | void;
      },
    ) => {
      runCount += 1;
      if (runCount === 1) {
        const startEvent = JSON.stringify({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: "task_start",
          current: 1,
          total: 1,
          taskId: "1.1",
          message: "Start 1.1: recover dead session. Next: wait for the worker restart.",
        });
        await writeUtf8(repoStatePaths.workerProgressFile, `${startEvent}\n`);
        await params.onEvent?.({ type: "tool_call", title: "worker-progress" });
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => {
            reject(new Error("acpx exited with code 1"));
          }, { once: true });
        });
        return;
      }

      await writeUtf8(tasksPath, "- [x] 1.1 Recover dead session\n");
      await writeJsonFile(repoStatePaths.executionResultFile, {
        version: 1,
        changeName,
        mode: "apply",
        status: "done",
        timestamp: new Date().toISOString(),
        summary: "Completed task 1.1.",
        progressMade: true,
        completedTask: "1.1 Recover dead session",
        changedFiles: ["openspec/changes/watch-work-dead-session/tasks.md"],
        notes: ["Recovered after dead session restart."],
        taskCounts: { total: 1, complete: 1, remaining: 0 },
        remainingTasks: 0,
      });
    },
    getSessionStatus: async () => runCount === 1
      ? {
          summary: "status=dead acpxRecordId=dead-session",
          details: {
            status: "dead",
            summary: "queue owner unavailable",
          },
        }
      : {
          summary: "status=running",
          details: {
            status: "running",
          },
        },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    await manager.stop();
  });

  const channelKey = "discord:watch-work-dead-session:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1.1 Recover dead session",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
    },
  }));

  await manager.start();
  await manager.wake(channelKey);
  await waitForProjectState(
    repoPath,
    (project) =>
      project?.status === "done"
      && hasMessage(notifierMessages, "demo-app-watch-work-dead-session", "All tasks complete", "/clawspec archive"),
  );

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "done");
  assert.equal(project?.lastExecution?.status, "done");
  assert.equal(runCount, 2);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-dead-session", "Restarting ACP worker", "retry task 1.1"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-dead-session", "All tasks complete", "/clawspec archive"), true);
});

test("watcher restarts a dead ACP session that dies before first progress", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-work-dead-startup-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work-dead-startup";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Recover startup failure\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];
  let runCount = 0;

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => {
      const done = (await readUtf8(tasksPath)).includes("- [x] 1.1 Recover startup failure");
      return {
        command: `openspec instructions apply --change ${cn} --json`,
        cwd,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        parsed: {
          changeName: cn,
          changeDir,
          schemaName: "spec-driven",
          contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
          progress: done ? { total: 1, complete: 1, remaining: 0 } : { total: 1, complete: 0, remaining: 1 },
          tasks: [{ id: "1.1", description: "Recover startup failure", done }],
          state: done ? "all_done" : "ready",
          instruction: "Implement the remaining task.",
        },
      };
    },
  } as any;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async (params: { signal?: AbortSignal }) => {
      runCount += 1;
      if (runCount === 1) {
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => {
            reject(new Error("acpx exited with code 1"));
          }, { once: true });
        });
        return;
      }

      await writeUtf8(tasksPath, "- [x] 1.1 Recover startup failure\n");
      await writeJsonFile(repoStatePaths.executionResultFile, {
        version: 1,
        changeName,
        mode: "apply",
        status: "done",
        timestamp: new Date().toISOString(),
        summary: "Recovered after startup failure.",
        progressMade: true,
        completedTask: "1.1 Recover startup failure",
        changedFiles: ["openspec/changes/watch-work-dead-startup/tasks.md"],
        notes: ["Recovered after dead startup restart."],
        taskCounts: { total: 1, complete: 1, remaining: 0 },
        remainingTasks: 0,
      });
    },
    getSessionStatus: async () => runCount === 1
      ? {
          summary: "status=dead acpxRecordId=dead-startup",
          details: {
            status: "dead",
            summary: "queue owner unavailable",
          },
        }
      : {
          summary: "status=running",
          details: {
            status: "running",
          },
        },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    await manager.stop();
  });

  const channelKey = "discord:watch-work-dead-startup:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1.1 Recover startup failure",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
    },
  }));

  await manager.start();
  await manager.wake(channelKey);
  await waitForProjectState(
    repoPath,
    (project) =>
      project?.status === "done"
      && hasMessage(notifierMessages, "demo-app-watch-work-dead-startup", "All tasks complete", "/clawspec archive"),
  );

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "done");
  assert.equal(project?.lastExecution?.status, "done");
  assert.equal(runCount, 2);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-dead-startup", "Restarting ACP worker", "retry task 1.1"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-dead-startup", "All tasks complete", "/clawspec archive"), true);
});

test("status-only ACP heartbeats do not keep a dead session alive", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-work-status-heartbeats-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work-status-heartbeats";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Recover dead worker after empty heartbeats\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];
  let runCount = 0;

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => {
      const done = (await readUtf8(tasksPath)).includes("- [x] 1.1 Recover dead worker after empty heartbeats");
      return {
        command: `openspec instructions apply --change ${cn} --json`,
        cwd,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        parsed: {
          changeName: cn,
          changeDir,
          schemaName: "spec-driven",
          contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
          progress: done ? { total: 1, complete: 1, remaining: 0 } : { total: 1, complete: 0, remaining: 1 },
          tasks: [{ id: "1.1", description: "Recover dead worker after empty heartbeats", done }],
          state: done ? "all_done" : "ready",
          instruction: "Implement the remaining task.",
        },
      };
    },
  } as any;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async (
      params: {
        signal?: AbortSignal;
        onEvent?: (event: { type: string; text?: string; tag?: string }) => Promise<void> | void;
      },
    ) => {
      runCount += 1;
      if (runCount === 1) {
        await new Promise<void>((_resolve, reject) => {
          const timer = setInterval(() => {
            void params.onEvent?.({
              type: "status",
              text: "session heartbeat",
              tag: "session_info_update",
            });
          }, 250);
          params.signal?.addEventListener("abort", () => {
            clearInterval(timer);
            reject(new Error("acpx exited with code 1"));
          }, { once: true });
        });
        return;
      }

      await writeUtf8(tasksPath, "- [x] 1.1 Recover dead worker after empty heartbeats\n");
      await writeJsonFile(repoStatePaths.executionResultFile, {
        version: 1,
        changeName,
        mode: "apply",
        status: "done",
        timestamp: new Date().toISOString(),
        summary: "Recovered after dead worker heartbeat loop.",
        progressMade: true,
        completedTask: "1.1 Recover dead worker after empty heartbeats",
        changedFiles: ["openspec/changes/watch-work-status-heartbeats/tasks.md"],
        notes: ["Recovered after watcher ignored empty ACP status heartbeats."],
        taskCounts: { total: 1, complete: 1, remaining: 0 },
        remainingTasks: 0,
      });
    },
    getSessionStatus: async () => runCount === 1
      ? {
          summary: "status=dead acpxRecordId=dead-heartbeats",
          details: {
            status: "dead",
            summary: "agent process exited",
          },
        }
      : {
          summary: "status=running",
          details: {
            status: "running",
          },
        },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    await manager.stop();
  });

  const channelKey = "discord:watch-work-status-heartbeats:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1.1 Recover dead worker after empty heartbeats",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
    },
  }));

  await manager.start();
  await manager.wake(channelKey);
  await waitForProjectState(
    repoPath,
    (project) =>
      project?.status === "done"
      && hasMessage(notifierMessages, "demo-app-watch-work-status-heartbeats", "All tasks complete"),
  );

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "done");
  assert.equal(runCount, 2);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-status-heartbeats", "Restarting ACP worker", "retry task 1.1"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-status-heartbeats", "All tasks complete"), true);
});

test("dead ACP session that ignores abort is restarted without hanging the watcher", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-work-hung-dead-session-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work-hung-dead-session";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Recover hung dead worker session\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];
  let runCount = 0;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => {
      const done = (await readUtf8(tasksPath)).includes("- [x] 1.1 Recover hung dead worker session");
      return {
        command: `openspec instructions apply --change ${cn} --json`,
        cwd,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        parsed: {
          changeName: cn,
          changeDir,
          schemaName: "spec-driven",
          contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
          progress: done ? { total: 1, complete: 1, remaining: 0 } : { total: 1, complete: 0, remaining: 1 },
          tasks: [{ id: "1.1", description: "Recover hung dead worker session", done }],
          state: done ? "all_done" : "ready",
          instruction: "Implement the remaining task.",
        },
      };
    },
  } as any;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async (
      params: {
        signal?: AbortSignal;
        onEvent?: (event: { type: string; text?: string; tag?: string }) => Promise<void> | void;
      },
    ) => {
      runCount += 1;
      if (runCount === 1) {
        await params.onEvent?.({ type: "tool_call" });
        await new Promise<void>(() => {
          heartbeatTimer = setInterval(() => {
            void params.onEvent?.({
              type: "status",
              text: "session heartbeat",
              tag: "session_info_update",
            });
          }, 250);
          heartbeatTimer.unref?.();
          params.signal?.addEventListener("abort", () => {
            // Simulate a dead backend that never settles the stream after abort.
          }, { once: true });
        });
        return;
      }

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }

      await writeUtf8(tasksPath, "- [x] 1.1 Recover hung dead worker session\n");
      await writeJsonFile(repoStatePaths.executionResultFile, {
        version: 1,
        changeName,
        mode: "apply",
        status: "done",
        timestamp: new Date().toISOString(),
        summary: "Recovered after hung dead worker session.",
        progressMade: true,
        completedTask: "1.1 Recover hung dead worker session",
        changedFiles: ["openspec/changes/watch-work-hung-dead-session/tasks.md"],
        notes: ["Watcher restarted after the first ACP run stayed dead and ignored abort."],
        taskCounts: { total: 1, complete: 1, remaining: 0 },
        remainingTasks: 0,
      });
    },
    getSessionStatus: async () => runCount === 1
      ? {
          summary: "status=dead acpxRecordId=hung-dead-worker",
          details: {
            status: "dead",
            summary: "agent process exited",
          },
        }
      : {
          summary: "status=running",
          details: {
            status: "running",
          },
        },
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    await manager.stop();
  });

  const channelKey = "discord:watch-work-hung-dead-session:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1.1 Recover hung dead worker session",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
    },
  }));

  await manager.start();
  await manager.wake(channelKey);
  await waitForProjectState(
    repoPath,
    (project) =>
      project?.status === "done"
      && hasMessage(notifierMessages, "demo-app-watch-work-hung-dead-session", "All tasks complete"),
  );

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "done");
  assert.equal(project?.lastExecution?.status, "done");
  assert.equal(runCount, 2);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-hung-dead-session", "Restarting ACP worker", "retry task 1.1"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-hung-dead-session", "All tasks complete"), true);
});

test("manager stop closes active worker sessions and rearms project recovery state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-stop-closes-workers-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-stop";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [x] 1.1 First task\n- [ ] 1.2 Remaining task\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const closedSessions: Array<{ sessionKey: string; reason?: string }> = [];

  const manager = new WatcherManager({
    stateStore,
    openSpec: {} as any,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async () => undefined } as any,
    acpClient: {
      agentId: "codex",
      closeSession: async (sessionKey: string, reason?: string) => {
        closedSessions.push({ sessionKey, reason });
      },
    } as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });

  const channelKey = "discord:watch-stop:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "running",
    phase: "implementing",
    latestSummary: "Running task 2",
    currentTask: "1.2 Remaining task",
    taskCounts: { total: 2, complete: 1, remaining: 1 },
    execution: {
      mode: "apply",
      action: "work",
      state: "running",
      workerAgentId: "codex",
      workerSlot: "primary",
      armedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      sessionKey: "session-stop-1",
      lastHeartbeatAt: new Date().toISOString(),
    },
  }));

  await manager.stop();

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "armed");
  assert.equal(project?.phase, "implementing");
  assert.equal(project?.execution?.state, "armed");
  assert.equal(project?.execution?.startedAt, undefined);
  assert.equal(project?.execution?.lastHeartbeatAt, undefined);
  assert.equal(project?.taskCounts?.complete, 1);
  assert.equal(project?.taskCounts?.remaining, 1);
  assert.deepEqual(closedSessions, [{
    sessionKey: "session-stop-1",
    reason: "gateway service stopping",
  }]);
});

test("watcher stops retrying after 10 ACP restart attempts", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-work-restart-cap-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work-restart-cap";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Recover repeated worker failure\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];
  let runCount = 0;

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => ({
      command: `openspec instructions apply --change ${cn} --json`,
      cwd,
      stdout: "{}",
      stderr: "",
      durationMs: 1,
      parsed: {
        changeName: cn,
        changeDir,
        schemaName: "spec-driven",
        contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
        progress: { total: 1, complete: 0, remaining: 1 },
        tasks: [{ id: "1.1", description: "Recover repeated worker failure", done: false }],
        state: "ready",
        instruction: "Implement the remaining task.",
      },
    }),
  } as any;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async () => {
      runCount += 1;
      throw new Error("acpx exited with code 1");
    },
    getSessionStatus: async () => undefined,
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    await manager.stop();
  });

  const channelKey = "discord:watch-work-restart-cap:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1.1 Recover repeated worker failure",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
      restartCount: 10,
      lastFailure: "previous failure",
    },
  }));

  await manager.wake(channelKey);
  await waitForProjectState(
    repoPath,
    (project) =>
      project?.status === "blocked"
      && hasMessage(notifierMessages, "demo-app-watch-work-restart-cap", "Blocked after 10 ACP restart attempts"),
  );

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "blocked");
  assert.equal(project?.execution, undefined);
  assert.equal(runCount, 1);
  assert.equal(project?.blockedReason?.includes("Blocked after 10 ACP restart attempts"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-restart-cap", "Blocked after 10 ACP restart attempts"), true);
});

test("watcher blocked message includes ACPX setup guidance when backend stays unavailable", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-work-backend-blocked-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work-backend-blocked";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Recover ACP backend setup\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => ({
      command: `openspec instructions apply --change ${cn} --json`,
      cwd,
      stdout: "{}",
      stderr: "",
      durationMs: 1,
      parsed: {
        changeName: cn,
        changeDir,
        schemaName: "spec-driven",
        contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
        progress: { total: 1, complete: 0, remaining: 1 },
        tasks: [{ id: "1.1", description: "Recover ACP backend setup", done: false }],
        state: "ready",
        instruction: "Implement the remaining task.",
      },
    }),
  } as any;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async () => {
      throw new Error("ACP runtime backend is currently unavailable. Try again in a moment.");
    },
    getSessionStatus: async () => undefined,
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    await manager.stop();
  });

  const channelKey = "discord:watch-work-backend-blocked:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1.1 Recover ACP backend setup",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
      restartCount: 10,
      lastFailure: "previous backend unavailable",
    },
  }));

  await manager.wake(channelKey);
  await waitForProjectState(
    repoPath,
    (project) =>
      project?.status === "blocked"
      && hasMessage(notifierMessages, "demo-app-watch-work-backend-blocked", "Blocked: ACPX backend unavailable"),
  );

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "blocked");
  assert.equal(project?.blockedReason?.includes("Blocked after 10 ACP restart attempts"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-backend-blocked", "Blocked: ACPX backend unavailable"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-backend-blocked", "openclaw config set acp.defaultAgent codex"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-backend-blocked", "cs-work"), true);
});

test("watcher retries when ACP runtime backend is temporarily unavailable", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-backend-unavailable-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work-backend-unavailable";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1.1 Recover backend startup race\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];
  let runCount = 0;

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => {
      const done = (await readUtf8(tasksPath)).includes("- [x] 1.1 Recover backend startup race");
      return {
        command: `openspec instructions apply --change ${cn} --json`,
        cwd,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        parsed: {
          changeName: cn,
          changeDir,
          schemaName: "spec-driven",
          contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
          progress: done ? { total: 1, complete: 1, remaining: 0 } : { total: 1, complete: 0, remaining: 1 },
          tasks: [{ id: "1.1", description: "Recover backend startup race", done }],
          state: done ? "all_done" : "ready",
          instruction: "Implement the remaining task.",
        },
      };
    },
  } as any;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async () => {
      runCount += 1;
      if (runCount === 1) {
        throw new Error("ACP runtime backend is currently unavailable. Try again in a moment.");
      }

      await writeUtf8(tasksPath, "- [x] 1.1 Recover backend startup race\n");
      await writeJsonFile(repoStatePaths.executionResultFile, {
        version: 1,
        changeName,
        mode: "apply",
        status: "done",
        timestamp: new Date().toISOString(),
        summary: "Recovered after backend startup race.",
        progressMade: true,
        completedTask: "1.1 Recover backend startup race",
        changedFiles: ["openspec/changes/watch-work-backend-unavailable/tasks.md"],
        notes: ["Recovered after ACP runtime backend became ready."],
        taskCounts: { total: 1, complete: 1, remaining: 0 },
        remainingTasks: 0,
      });
    },
    getSessionStatus: async () => undefined,
    cancelSession: async () => undefined,
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    await manager.stop();
  });

  const channelKey = "discord:watch-work-backend-unavailable:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1.1 Recover backend startup race",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
    },
  }));

  await manager.wake(channelKey);
  await waitForProjectState(
    repoPath,
    (project) =>
      project?.status === "done"
      && hasMessage(notifierMessages, "demo-app-watch-work-backend-unavailable", "All tasks complete"),
  );

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "done");
  assert.equal(runCount, 2);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-backend-unavailable", "Restarting ACP worker"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-backend-unavailable", "OpenClaw ACP is unavailable"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-backend-unavailable", "openclaw config set acp.defaultAgent codex"), true);
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-backend-unavailable", "All tasks complete"), true);
});

test("watcher finalizes when terminal result exists before ACP turn exits", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-watcher-work-terminal-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeName = "watch-work-terminal";
  const changeDir = path.join(repoPath, "openspec", "changes", changeName);
  const tasksPath = path.join(changeDir, "tasks.md");
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await mkdir(changeDir, { recursive: true });
  await writeUtf8(tasksPath, "- [ ] 1 Build the demo endpoint\n");
  await writeUtf8(path.join(changeDir, "proposal.md"), "# Proposal\n");

  const rollbackStore = new RollbackStore(repoPath, "archives", changeName);
  await rollbackStore.initializeBaseline();

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  await stateStore.initialize();
  const notifierMessages: string[] = [];
  let cancelled = false;

  const fakeOpenSpec = {
    instructionsApply: async (cwd: string, cn: string) => {
      const done = (await readUtf8(tasksPath)).includes("- [x] 1 Build the demo endpoint");
      return {
        command: `openspec instructions apply --change ${cn} --json`,
        cwd,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        parsed: {
          changeName: cn,
          changeDir,
          schemaName: "spec-driven",
          contextFiles: { proposal: path.join(changeDir, "proposal.md"), tasks: tasksPath },
          progress: done ? { total: 1, complete: 1, remaining: 0 } : { total: 1, complete: 0, remaining: 1 },
          tasks: [{ id: "1", description: "Build the demo endpoint", done }],
          state: done ? "all_done" : "ready",
          instruction: "Implement the remaining task.",
        },
      };
    },
  } as any;

  const fakeAcpClient = {
    agentId: "codex",
    runTurn: async (params: { onEvent?: (event: { type: string; title?: string }) => Promise<void> | void }) => {
      const startEvent = JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: "task_start",
        current: 1,
        total: 1,
        taskId: "1",
        message: "Start 1: build the demo endpoint. Next: done.",
      });
      const doneEvent = JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: "task_done",
        current: 1,
        total: 1,
        taskId: "1",
        message: "Done 1: built the demo endpoint. Changed 1 files: openspec/changes/watch-work-terminal/tasks.md. Next: done.",
      });
      await writeUtf8(repoStatePaths.workerProgressFile, `${startEvent}\n${doneEvent}\n`);
      await writeUtf8(tasksPath, "- [x] 1 Build the demo endpoint\n");
      await writeJsonFile(repoStatePaths.executionResultFile, {
        version: 1,
        changeName,
        mode: "apply",
        status: "done",
        timestamp: new Date().toISOString(),
        summary: "Completed task 1.",
        progressMade: true,
        completedTask: "1 Build the demo endpoint",
        changedFiles: ["openspec/changes/watch-work-terminal/tasks.md"],
        notes: ["Task completed"],
        taskCounts: { total: 1, complete: 1, remaining: 0 },
        remainingTasks: 0,
      });
      await params.onEvent?.({ type: "tool_call", title: "worker-progress" });
      await waitFor(async () => cancelled, 4_000);
    },
    cancelSession: async () => { cancelled = true; },
    closeSession: async () => undefined,
  };

  const manager = new WatcherManager({
    stateStore,
    openSpec: fakeOpenSpec,
    archiveDirName: "archives",
    logger: createLogger(),
    notifier: { send: async (_: string, text: string) => { notifierMessages.push(text); } } as any,
    acpClient: fakeAcpClient as any,
    pollIntervalMs: TEST_WATCHER_POLL_INTERVAL_MS,
  });
  t.after(async () => {
    await manager.stop();
  });

  const channelKey = "discord:watch-work-terminal:default:main";
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath,
    repoPath,
    projectName: "demo-app",
    projectTitle: "Demo App",
    changeName,
    changeDir,
    status: "armed",
    phase: "implementing",
    currentTask: "1 Build the demo endpoint",
    taskCounts: { total: 1, complete: 0, remaining: 1 },
    planningJournal: { dirty: false, entryCount: 0 },
    rollback: {
      baselineRoot: rollbackStore.baselineRoot,
      manifestPath: rollbackStore.manifestPath,
      snapshotReady: true,
      touchedFileCount: 0,
    },
    execution: {
      mode: "apply",
      action: "work",
      state: "armed",
      armedAt: new Date().toISOString(),
    },
  }));

  await manager.start();
  await manager.wake(channelKey);
  await waitForProjectState(
    repoPath,
    (project) =>
      project?.status === "done"
      && hasMessage(notifierMessages, "demo-app-watch-work-terminal", "All tasks complete"),
  );

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(cancelled, true);
  assert.equal(project?.status, "done");
  assert.equal(project?.execution, undefined);
  assert.equal(project?.lastExecution?.status, "done");
  assert.equal(hasMessage(notifierMessages, "demo-app-watch-work-terminal", "[######] 1/1", "All tasks complete"), true);
});
