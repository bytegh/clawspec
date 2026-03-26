import test from "node:test";
import assert from "node:assert/strict";
import { pathExists, readJsonFile, writeUtf8 } from "../src/utils/fs.ts";
import { PlanningJournalStore } from "../src/planning/journal.ts";
import { getRepoStatePaths } from "../src/utils/paths.ts";
import { createServiceHarness, seedPlanningProject } from "./helpers/harness.ts";

test("apply prepares visible planning", async () => {
  const harness = await createServiceHarness("clawspec-apply-queue-");
  const { service, stateStore, watcherManager, repoPath, workspacePath, changeDir } = harness;
  const channelKey = "discord:apply-queue:default:main";

  await seedPlanningProject(stateStore, channelKey, {
    workspacePath,
    repoPath,
    projectName: "demo-app",
    changeName: "weather-plan",
    changeDir,
    phase: "proposal",
    status: "ready",
    planningDirty: true,
  });

  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await writeUtf8(repoStatePaths.executionControlFile, "{\"state\":\"running\"}\n");
  await writeUtf8(repoStatePaths.executionResultFile, "{\"status\":\"running\"}\n");
  await writeUtf8(repoStatePaths.workerProgressFile, "{\"kind\":\"task_start\"}\n");

  const result = await service.queuePlanningProject(channelKey, "apply");
  const project = await stateStore.getActiveProject(channelKey);

  assert.match(result.text ?? "", /Planning Ready/);
  assert.equal(project?.status, "ready");
  assert.equal(project?.execution, undefined);
  assert.deepEqual(watcherManager.wakeCalls, []);
  assert.equal(await pathExists(repoStatePaths.executionControlFile), false);
  assert.equal(await pathExists(repoStatePaths.executionResultFile), false);
  assert.equal(await pathExists(repoStatePaths.workerProgressFile), false);
});

test("continue routes back to planning when dirty", async () => {
  const harness = await createServiceHarness("clawspec-continue-planning-");
  const { service, stateStore, watcherManager, repoPath, workspacePath, changeDir } = harness;
  const channelKey = "discord:continue-planning:default:main";

  await seedPlanningProject(stateStore, channelKey, {
    workspacePath,
    repoPath,
    projectName: "demo-app",
    changeName: "dirty-plan",
    changeDir,
    phase: "tasks",
    status: "paused",
    planningDirty: true,
  });

  const result = await service.continueProject(channelKey);
  const project = await stateStore.getActiveProject(channelKey);

  assert.match(result.text ?? "", /Planning Ready/);
  assert.equal(project?.status, "ready");
  assert.equal(project?.execution, undefined);
  assert.deepEqual(watcherManager.wakeCalls, []);
});

test("apply still prepares visible planning review when attached and journal matches the last snapshot", async () => {
  const harness = await createServiceHarness("clawspec-apply-no-new-plan-");
  const { service, stateStore, watcherManager, repoPath, workspacePath, changeDir } = harness;
  const channelKey = "discord:apply-no-new-plan:default:main";

  await seedPlanningProject(stateStore, channelKey, {
    workspacePath,
    repoPath,
    projectName: "demo-app",
    changeName: "weather-plan",
    changeDir,
    phase: "tasks",
    status: "ready",
    planningDirty: true,
  });

  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
  await journalStore.append({
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    changeName: "weather-plan",
    role: "user",
    text: "keep the same two API endpoints",
  });
  await journalStore.writeSnapshot(repoStatePaths.planningJournalSnapshotFile, "weather-plan");

  const result = await service.queuePlanningProject(channelKey, "apply");
  const project = await stateStore.getActiveProject(channelKey);

  assert.match(result.text ?? "", /Planning Ready/);
  assert.equal(project?.status, "ready");
  assert.match(project?.latestSummary ?? "", /Waiting for cs-plan in chat/);
  assert.deepEqual(watcherManager.wakeCalls, []);
});

test("apply reports no new planning notes when the chat context is detached", async () => {
  const harness = await createServiceHarness("clawspec-apply-detached-no-new-plan-");
  const { service, stateStore, watcherManager, repoPath, workspacePath, changeDir } = harness;
  const channelKey = "discord:apply-detached-no-new-plan:default:main";

  await seedPlanningProject(stateStore, channelKey, {
    workspacePath,
    repoPath,
    projectName: "demo-app",
    changeName: "weather-plan",
    changeDir,
    phase: "tasks",
    status: "ready",
    planningDirty: true,
  });

  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    contextMode: "detached",
  }));

  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
  await journalStore.writeSnapshot(repoStatePaths.planningJournalSnapshotFile, "weather-plan");

  const result = await service.queuePlanningProject(channelKey, "apply");
  const project = await stateStore.getActiveProject(channelKey);

  assert.match(result.text ?? "", /No New Planning Notes/);
  assert.equal(project?.planningJournal?.dirty, false);
  assert.deepEqual(watcherManager.wakeCalls, []);
});

test("cs-plan runs visible planning sync and writes a fresh snapshot", async () => {
  const harness = await createServiceHarness("clawspec-visible-plan-");
  const { service, stateStore, repoPath } = harness;
  const channelKey = "discord:visible-plan:default:main";
  const promptContext = {
    trigger: "user",
    channel: "discord",
    channelId: "visible-plan",
    accountId: "default",
    conversationId: "main",
    sessionKey: "agent:main:discord:channel:visible-plan",
  };

  await service.startProject(channelKey);
  await service.useProject(channelKey, "demo-app");
  await service.proposalProject(channelKey, "demo-change Demo change");
  await service.recordPlanningMessageFromContext(promptContext, "add another API endpoint");

  const injected = await service.handleBeforePromptBuild(
    { prompt: "cs-plan", messages: [] },
    promptContext,
  );
  const runningProject = await stateStore.getActiveProject(channelKey);

  assert.match(injected?.prependContext ?? "", /ClawSpec planning sync is active for this turn/);
  assert.match(injected?.prependContext ?? "", /Prefetched OpenSpec instructions for this turn/);
  assert.match(injected?.prependContext ?? "", /planning-instructions[\\/]+proposal\.json/);
  assert.match(injected?.prependContext ?? "", /mandatory final line exactly in this shape/i);
  assert.equal(runningProject?.status, "planning");
  assert.equal(runningProject?.phase, "planning_sync");

  await service.handleAgentEnd(
    { messages: [], success: true, durationMs: 10 },
    promptContext,
  );

  const finalized = await stateStore.getActiveProject(channelKey);
  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  const snapshotExists = await pathExists(repoStatePaths.planningJournalSnapshotFile);
  const snapshot = await readJsonFile<any>(repoStatePaths.planningJournalSnapshotFile, null);

  assert.equal(finalized?.status, "ready");
  assert.equal(finalized?.phase, "tasks");
  assert.equal(finalized?.planningJournal?.dirty, false);
  assert.match(finalized?.latestSummary ?? "", /Say `cs-work` to start implementation/);
  assert.equal(snapshotExists, true);
  assert.equal(snapshot?.changeName, "demo-change");
});

test("cs-plan clears stale execution control artifacts from earlier worker runs", async () => {
  const harness = await createServiceHarness("clawspec-visible-plan-cleanup-");
  const { service, stateStore, repoPath } = harness;
  const channelKey = "discord:visible-plan-cleanup:default:main";
  const promptContext = {
    trigger: "user",
    channel: "discord",
    channelId: "visible-plan-cleanup",
    accountId: "default",
    conversationId: "main",
    sessionKey: "agent:main:discord:channel:visible-plan-cleanup",
  };

  await service.startProject(channelKey);
  await service.useProject(channelKey, "demo-app");
  await service.proposalProject(channelKey, "demo-change Demo change");
  await service.recordPlanningMessageFromContext(promptContext, "add another API endpoint");

  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  await writeUtf8(repoStatePaths.executionControlFile, "{\"state\":\"running\"}\n");
  await writeUtf8(repoStatePaths.executionResultFile, "{\"status\":\"running\"}\n");
  await writeUtf8(repoStatePaths.workerProgressFile, "{\"kind\":\"task_start\"}\n");

  await service.handleBeforePromptBuild(
    { prompt: "cs-plan", messages: [] },
    promptContext,
  );

  await service.handleAgentEnd(
    { messages: [], success: true, durationMs: 10 },
    promptContext,
  );

  assert.equal(await pathExists(repoStatePaths.executionControlFile), false);
  assert.equal(await pathExists(repoStatePaths.executionResultFile), false);
  assert.equal(await pathExists(repoStatePaths.workerProgressFile), false);
});

test("ordinary planning discussion does not preload planning artifacts or propose skill", async () => {
  const harness = await createServiceHarness("clawspec-discussion-guard-");
  const { service } = harness;
  const channelKey = "discord:discussion-guard:default:main";
  const promptContext = {
    trigger: "user",
    channel: "discord",
    channelId: "discussion-guard",
    accountId: "default",
    conversationId: "main",
    sessionKey: "agent:main:discord:channel:discussion-guard",
  };

  await service.startProject(channelKey);
  await service.useProject(channelKey, "demo-app");
  await service.proposalProject(channelKey, "demo-change Demo change");

  const injected = await service.handleBeforePromptBuild(
    { prompt: "再增加一个接口", messages: [] },
    promptContext,
  );

  assert.match(injected?.prependContext ?? "", /ClawSpec planning discussion mode is active/);
  assert.doesNotMatch(injected?.prependContext ?? "", /openspec[\\/].*proposal\.md/);
  assert.doesNotMatch(injected?.prependContext ?? "", /openspec[\\/].*design\.md/);
  assert.doesNotMatch(injected?.prependContext ?? "", /openspec[\\/].*tasks\.md/);
  assert.match(injected?.prependContext ?? "", /Do not say planning has started, queued, refreshed, synced, or completed/);
  assert.match(injected?.prependContext ?? "", /explicitly tell the user that `cs-plan` is the next step before any further implementation/);
  assert.match(injected?.prependContext ?? "", /do not say the next step is `cs-work`/);
  assert.doesNotMatch(injected?.prependSystemContext ?? "", /openspec-propose/i);
});
