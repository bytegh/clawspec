import test from "node:test";
import assert from "node:assert/strict";
import { createServiceHarness, seedPlanningProject } from "./helpers/harness.ts";

test("pause requests watcher interrupt", async () => {
  const harness = await createServiceHarness("clawspec-pause-");
  const { service, stateStore, watcherManager, repoPath, workspacePath, changeDir } = harness;
  const channelKey = "discord:pause:default:main";

  await seedPlanningProject(stateStore, channelKey, {
    workspacePath,
    repoPath,
    projectName: "demo-app",
    changeName: "pause-change",
    changeDir,
    phase: "implementing",
    status: "running",
    planningDirty: false,
    execution: { action: "work", state: "running", mode: "apply" },
  });

  const result = await service.pauseProject(channelKey);
  const project = await stateStore.getActiveProject(channelKey);

  assert.match(result.text ?? "", /Pause Requested/);
  assert.equal(project?.pauseRequested, true);
  assert.deepEqual(watcherManager.interruptCalls, [{ channelKey, reason: "paused by user" }]);
  assert.deepEqual(watcherManager.wakeCalls, [channelKey]);
});

test("cancel requests watcher interrupt", async () => {
  const harness = await createServiceHarness("clawspec-cancel-");
  const { service, stateStore, watcherManager, repoPath, workspacePath, changeDir } = harness;
  const channelKey = "discord:cancel:default:main";

  await seedPlanningProject(stateStore, channelKey, {
    workspacePath,
    repoPath,
    projectName: "demo-app",
    changeName: "cancel-change",
    changeDir,
    phase: "implementing",
    status: "running",
    planningDirty: false,
    execution: { action: "work", state: "running", mode: "apply" },
  });

  const result = await service.cancelProject(channelKey);
  const project = await stateStore.getActiveProject(channelKey);

  assert.match(result.text ?? "", /Cancellation Requested/);
  assert.equal(project?.cancelRequested, true);
  assert.deepEqual(watcherManager.interruptCalls, [{ channelKey, reason: "cancelled by user" }]);
  assert.deepEqual(watcherManager.wakeCalls, [channelKey]);
});
