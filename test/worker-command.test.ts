import test from "node:test";
import assert from "node:assert/strict";
import { createServiceHarness, seedPlanningProject } from "./helpers/harness.ts";

test("worker command sets agent", async () => {
  const harness = await createServiceHarness("clawspec-worker-command-");
  const { service, stateStore } = harness;
  const channelKey = "discord:worker-command:default:main";

  await service.startProject(channelKey);
  const before = await service.workerProject(channelKey, "");
  const setResult = await service.workerProject(channelKey, "piper");
  const project = await stateStore.getActiveProject(channelKey);

  assert.match(before.text ?? "", /Current worker agent: `codex`/);
  assert.match(setResult.text ?? "", /Worker Agent Updated/);
  assert.equal(project?.workerAgentId, "piper");
});

test("worker status shows live state", async () => {
  const harness = await createServiceHarness("clawspec-worker-status-");
  const { service, stateStore, workspacePath, repoPath, changeDir } = harness;
  const channelKey = "discord:worker-status:default:main";

  await seedPlanningProject(stateStore, channelKey, {
    workspacePath,
    repoPath,
    projectName: "demo-app",
    changeName: "watch-status",
    changeDir,
    phase: "implementing",
    status: "running",
    planningDirty: false,
    execution: { action: "work", state: "running", mode: "apply" },
  });

  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workerAgentId: "codex",
    latestSummary: "Worker is currently applying task 1.2.",
    taskCounts: { total: 4, complete: 1, remaining: 3 },
    execution: current.execution
      ? {
          ...current.execution,
          workerAgentId: "codex",
          workerSlot: "primary",
          startupPhase: "connected",
          currentTaskId: "1.2",
          currentArtifact: undefined,
          sessionKey: "watcher:demo",
          connectedAt: new Date(Date.now() - 6_000).toISOString(),
          lastHeartbeatAt: "2026-03-22T10:00:00.000Z",
        }
      : current.execution,
  }));

  const result = await service.workerProject(channelKey, "status");
  assert.match(result.text ?? "", /Worker Status/);
  assert.match(result.text ?? "", /Change: `watch-status`/);
  assert.match(result.text ?? "", /Execution state: `running`/);
  assert.match(result.text ?? "", /Startup phase: `connected`/);
  assert.match(result.text ?? "", /Startup wait: `\d+s`/);
  assert.match(result.text ?? "", /Current task: `1.2`/);
  assert.match(result.text ?? "", /Progress: 1\/4 complete, 3 remaining/);
  assert.match(result.text ?? "", /Next: Wait for worker updates or use `\/clawspec pause`\./);
});
