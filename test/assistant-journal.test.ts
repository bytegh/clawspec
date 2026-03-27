import test from "node:test";
import assert from "node:assert/strict";
import { PlanningJournalStore } from "../src/planning/journal.ts";
import { getRepoStatePaths } from "../src/utils/paths.ts";
import { createServiceHarness } from "./helpers/harness.ts";

function createPromptContext(channelId: string) {
  return {
    trigger: "user",
    channel: "discord",
    channelId,
    accountId: "default",
    conversationId: "main",
    sessionKey: `agent:main:discord:channel:${channelId}`,
  };
}

test("assistant planning suggestions are appended to the journal for attached discussion turns", async () => {
  const harness = await createServiceHarness("clawspec-assistant-journal-");
  const { service, stateStore, repoPath } = harness;
  const channelKey = "discord:assistant-journal:default:main";
  const promptContext = createPromptContext("assistant-journal");
  const userPrompt = "Add JWT auth, refresh tokens, and forgot-password support.";

  await service.startProject(channelKey);
  await service.useProject(channelKey, "demo-app");
  await service.proposalProject(channelKey, "demo-change Demo change");
  await service.recordPlanningMessageFromContext(promptContext, userPrompt);
  await service.handleBeforePromptBuild(
    { prompt: userPrompt, messages: [] },
    promptContext,
  );

  await service.handleAgentEnd(
    {
      success: true,
      messages: [
        { role: "user", content: userPrompt },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "We should keep short-lived access tokens, add a refresh endpoint, and split forgot-password into request and confirm steps.",
            },
          ],
        },
      ],
    },
    promptContext,
  );

  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
  const entries = await journalStore.list("demo-change");
  const project = await stateStore.getActiveProject(channelKey);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.role, "user");
  assert.equal(entries[1]?.role, "assistant");
  assert.match(entries[1]?.text ?? "", /refresh endpoint/i);
  assert.equal(project?.planningJournal?.dirty, true);
  assert.equal(project?.planningJournal?.entryCount, 2);
});

test("passive assistant control replies are not appended to the planning journal", async () => {
  const harness = await createServiceHarness("clawspec-passive-assistant-journal-");
  const { service, repoPath } = harness;
  const channelKey = "discord:passive-assistant-journal:default:main";
  const promptContext = createPromptContext("passive-assistant-journal");
  const userPrompt = "Add a help endpoint for the API catalog.";

  await service.startProject(channelKey);
  await service.useProject(channelKey, "demo-app");
  await service.proposalProject(channelKey, "demo-change Demo change");
  await service.recordPlanningMessageFromContext(promptContext, userPrompt);
  await service.handleBeforePromptBuild(
    { prompt: userPrompt, messages: [] },
    promptContext,
  );

  await service.handleAgentEnd(
    {
      success: true,
      messages: [
        { role: "user", content: userPrompt },
        {
          role: "assistant",
          content: "Continue describing requirements if needed.\nNext step: run `cs-plan`.",
        },
      ],
    },
    promptContext,
  );

  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
  const entries = await journalStore.list("demo-change");

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.role, "user");
});

test("assistant discussion replies are not journaled after the chat is detached", async () => {
  const harness = await createServiceHarness("clawspec-detached-assistant-journal-");
  const { service, repoPath } = harness;
  const channelKey = "discord:detached-assistant-journal:default:main";
  const promptContext = createPromptContext("detached-assistant-journal");
  const userPrompt = "Add a city weather endpoint.";

  await service.startProject(channelKey);
  await service.useProject(channelKey, "demo-app");
  await service.proposalProject(channelKey, "demo-change Demo change");
  await service.handleBeforePromptBuild(
    { prompt: userPrompt, messages: [] },
    promptContext,
  );
  await service.detachProject(channelKey);

  await service.handleAgentEnd(
    {
      success: true,
      messages: [
        { role: "user", content: userPrompt },
        { role: "assistant", content: "We can resolve the city name first, then fetch weather details." },
      ],
    },
    promptContext,
  );

  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
  const entries = await journalStore.list("demo-change");

  assert.equal(entries.length, 0);
});

test("inbound bot/system messages are ignored by planning journal capture", async () => {
  const harness = await createServiceHarness("clawspec-ignore-bot-inbound-");
  const { service, stateStore, repoPath } = harness;
  const channelKey = "discord:ignore-bot-inbound:default:main";
  const promptContext = createPromptContext("ignore-bot-inbound");

  await service.startProject(channelKey);
  await service.useProject(channelKey, "demo-app");
  await service.proposalProject(channelKey, "demo-change Demo change");

  await service.recordPlanningMessageFromContext(
    {
      ...promptContext,
      from: "assistant",
      metadata: {
        role: "assistant",
        fromSelf: true,
      },
    },
    "Planning ready. Next: run `cs-work` to start implementation.",
  );

  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
  const entries = await journalStore.list("demo-change");
  const project = await stateStore.getActiveProject(channelKey);

  assert.equal(entries.length, 0);
  assert.equal(project?.planningJournal?.dirty, false);
  assert.equal(project?.planningJournal?.entryCount, 0);
});

test("heartbeat assistant replies are not appended to the planning journal", async () => {
  const harness = await createServiceHarness("clawspec-ignore-heartbeat-journal-");
  const { service, repoPath } = harness;
  const channelKey = "discord:ignore-heartbeat-journal:default:main";
  const promptContext = createPromptContext("ignore-heartbeat-journal");
  const userPrompt = "Add one more API endpoint.";

  await service.startProject(channelKey);
  await service.useProject(channelKey, "demo-app");
  await service.proposalProject(channelKey, "demo-change Demo change");
  await service.recordPlanningMessageFromContext(promptContext, userPrompt);
  await service.handleBeforePromptBuild(
    { prompt: userPrompt, messages: [] },
    promptContext,
  );

  await service.handleAgentEnd(
    {
      success: true,
      messages: [
        { role: "user", content: userPrompt },
        { role: "assistant", content: "HEARTBEAT_OK" },
      ],
    },
    promptContext,
  );

  const repoStatePaths = getRepoStatePaths(repoPath, "archives");
  const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
  const entries = await journalStore.list("demo-change");

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.role, "user");
});
