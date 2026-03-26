import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectState } from "../src/types.ts";
import {
  hasBlockingExecution,
  isFinishedStatus,
  isProjectContextAttached,
  requiresPlanningSync,
  sanitizePlanningMessageText,
  shouldCapturePlanningMessage,
  isMeaningfulExecutionSummary,
  okReply,
  errorReply,
  samePath,
} from "../src/orchestrator/helpers.ts";

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: "test-id",
    channelKey: "discord:test:default:main",
    projectName: "test",
    status: "ready",
    phase: "tasks",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as ProjectState;
}

test("hasBlockingExecution detects armed/running states", () => {
  assert.equal(hasBlockingExecution(makeProject({ execution: { state: "armed" } as any })), true);
  assert.equal(hasBlockingExecution(makeProject({ execution: { state: "running" } as any })), true);
  assert.equal(hasBlockingExecution(makeProject({ status: "running" })), true);
  assert.equal(hasBlockingExecution(makeProject({ status: "ready" })), false);
  assert.equal(hasBlockingExecution(makeProject()), false);
});

test("isFinishedStatus identifies terminal statuses", () => {
  assert.equal(isFinishedStatus("done"), true);
  assert.equal(isFinishedStatus("archived"), true);
  assert.equal(isFinishedStatus("cancelled"), true);
  assert.equal(isFinishedStatus("ready"), false);
  assert.equal(isFinishedStatus("running"), false);
  assert.equal(isFinishedStatus("armed"), false);
});

test("isProjectContextAttached returns false when detached", () => {
  assert.equal(isProjectContextAttached(makeProject({ contextMode: "detached" })), false);
  assert.equal(isProjectContextAttached(makeProject({ contextMode: undefined })), true);
  assert.equal(isProjectContextAttached(makeProject()), true);
});

test("requiresPlanningSync detects dirty journal", () => {
  assert.equal(requiresPlanningSync(makeProject({ changeName: "x", planningJournal: { dirty: true, entryCount: 1 } })), true);
  assert.equal(requiresPlanningSync(makeProject({ changeName: "x", phase: "proposal" })), true);
  assert.equal(requiresPlanningSync(makeProject({ changeName: "x", planningJournal: { dirty: false, entryCount: 0 } })), false);
  assert.equal(requiresPlanningSync(makeProject({ changeName: undefined as any })), false);
  assert.equal(requiresPlanningSync(makeProject({ changeName: "x", status: "done" })), false);
});

test("shouldCapturePlanningMessage excludes running/archived/cancelled", () => {
  assert.equal(shouldCapturePlanningMessage(makeProject({ changeName: "x", status: "ready" })), true);
  assert.equal(shouldCapturePlanningMessage(makeProject({ changeName: "x", status: "running" })), false);
  assert.equal(shouldCapturePlanningMessage(makeProject({ changeName: "x", status: "archived" })), false);
  assert.equal(shouldCapturePlanningMessage(makeProject({ changeName: "x", status: "cancelled" })), false);
  assert.equal(shouldCapturePlanningMessage(makeProject({ contextMode: "detached", changeName: "x" })), false);
  assert.equal(shouldCapturePlanningMessage(makeProject({ changeName: undefined as any })), false);
});

test("sanitizePlanningMessageText strips metadata blocks", () => {
  const input = `Hello\nConversation info (untrusted metadata):\n\`\`\`json\n{"key":"value"}\n\`\`\`\nWorld`;
  const result = sanitizePlanningMessageText(input);
  assert.equal(result, "Hello\nWorld");
});

test("sanitizePlanningMessageText preserves clean text", () => {
  assert.equal(sanitizePlanningMessageText("  clean text  "), "clean text");
});

test("isMeaningfulExecutionSummary filters boilerplate", () => {
  assert.equal(isMeaningfulExecutionSummary(undefined), false);
  assert.equal(isMeaningfulExecutionSummary(""), false);
  assert.equal(isMeaningfulExecutionSummary("No summary yet."), false);
  assert.equal(isMeaningfulExecutionSummary("Visible execution ended without a structured result."), false);
  assert.equal(isMeaningfulExecutionSummary("Visible execution started for something"), false);
  assert.equal(isMeaningfulExecutionSummary("Completed task 1.1"), true);
  assert.equal(isMeaningfulExecutionSummary("All tasks done."), true);
});

test("okReply and errorReply produce correct shapes", () => {
  const ok = okReply("success");
  assert.equal(ok.text, "success");
  assert.equal(ok.isError, undefined);

  const err = errorReply("failure");
  assert.equal(err.text, "failure");
  assert.equal(err.isError, true);
});

test("samePath respects platform case sensitivity rules", () => {
  if (process.platform === "win32") {
    assert.equal(samePath("C:\\Repo\\Demo", "c:\\repo\\demo"), true);
    return;
  }

  assert.equal(samePath("/Repo/Demo", "/repo/demo"), false);
  assert.equal(samePath("/repo/demo", "/repo/demo"), true);
});
