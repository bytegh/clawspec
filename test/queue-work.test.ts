import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildWorkerSessionKey, createWorkerSessionKey } from "../src/execution/session.ts";
import { writeUtf8 } from "../src/utils/fs.ts";
import { createServiceHarness, seedPlanningProject } from "./helpers/harness.ts";

test("work queues background implementation", async () => {
  const harness = await createServiceHarness("clawspec-work-queue-");
  const { service, stateStore, watcherManager, repoPath, workspacePath, changeDir } = harness;
  const channelKey = "discord:work-queue:default:main";
  const tasksPath = path.join(changeDir, "tasks.md");
  await writeUtf8(tasksPath, "- [ ] 1.1 Build the demo endpoint\n");

  harness.openSpec.instructionsApply = async (cwd: string, changeName: string) => ({
    command: `openspec instructions apply --change ${changeName} --json`,
    cwd,
    stdout: "{}",
    stderr: "",
    durationMs: 1,
    parsed: {
      changeName,
      changeDir,
      schemaName: "spec-driven",
      contextFiles: { tasks: tasksPath },
      progress: { total: 1, complete: 0, remaining: 1 },
      tasks: [{ id: "1.1", description: "Build the demo endpoint", done: false }],
      state: "ready",
      instruction: "Implement the remaining task.",
    },
  });

  await seedPlanningProject(stateStore, channelKey, {
    workspacePath,
    repoPath,
    projectName: "demo-app",
    changeName: "queue-work",
    changeDir,
    phase: "tasks",
    status: "ready",
    planningDirty: false,
  });
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    boundSessionKey: "agent:main:discord:channel:work-queue",
  }));

  const result = await service.queueWorkProject(channelKey, "apply");
  const project = await stateStore.getActiveProject(channelKey);

  assert.match(result.text ?? "", /Execution Queued/);
  assert.equal(project?.status, "armed");
  assert.equal(project?.execution?.action, "work");
  assert.equal(project?.currentTask, "1.1 Build the demo endpoint");
  assert.equal(
    project?.execution?.sessionKey,
    createWorkerSessionKey(project!, {
      workerSlot: "primary",
      workerAgentId: "codex",
      attemptKey: project?.execution?.armedAt,
    }),
  );
  assert.match(project?.execution?.sessionKey ?? "", new RegExp(`^${buildWorkerSessionKey(project!, "primary", "codex")}:`));
  assert.notEqual(project?.execution?.sessionKey, project?.boundSessionKey);
  assert.deepEqual(watcherManager.wakeCalls, [channelKey]);
});

test("main chat agent end does not clear a background worker run", async () => {
  const harness = await createServiceHarness("clawspec-work-session-");
  const { service, stateStore, repoPath, workspacePath, changeDir } = harness;
  const channelKey = "discord:work-session:default:main";
  const workerSessionKey = "clawspec:worker-session";
  const boundSessionKey = "agent:main:discord:channel:work-session";

  await seedPlanningProject(stateStore, channelKey, {
    workspacePath,
    repoPath,
    projectName: "demo-app",
    changeName: "queue-work",
    changeDir,
    phase: "implementing",
    status: "running",
    planningDirty: false,
    execution: { action: "work", state: "running", mode: "apply" },
  });
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    boundSessionKey,
    latestSummary: "Worker is running in the background.",
    execution: current.execution
      ? {
          ...current.execution,
          sessionKey: workerSessionKey,
          workerAgentId: "codex",
          workerSlot: "primary",
        }
      : current.execution,
  }));

  await service.handleAgentEnd(
    { messages: [], success: true },
    { sessionKey: boundSessionKey, trigger: "user" },
  );

  const project = await stateStore.getActiveProject(channelKey);
  assert.equal(project?.status, "running");
  assert.equal(project?.execution?.state, "running");
  assert.equal(project?.execution?.sessionKey, workerSessionKey);
  assert.equal(project?.latestSummary, "Worker is running in the background.");
});
