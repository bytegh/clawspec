import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { getNextIncompleteTask, parseTasksMarkdown } from "../src/openspec/tasks.ts";
import { readExecutionControl, readExecutionResult, isExecutionTriggerText } from "../src/execution/state.ts";
import { writeJsonFile } from "../src/utils/fs.ts";

test("tasks parser keeps checkbox order and selects the next unchecked task", () => {
  const taskList = parseTasksMarkdown(`
## 1. Setup

- [x] 1.1 Create package
- [ ] 1.2 Add state store
- [ ] 1.3 Add docs
`);

  assert.equal(taskList.counts.total, 3);
  assert.equal(taskList.counts.complete, 1);
  assert.equal(taskList.counts.remaining, 2);
  assert.equal(getNextIncompleteTask(taskList)?.taskId, "1.2");
});

test("execution helpers read structured control and result files", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-execution-"));
  const controlPath = path.join(tempRoot, "execution-control.json");
  const resultPath = path.join(tempRoot, "execution-result.json");

  await writeJsonFile(controlPath, {
    version: 1,
    changeName: "demo-change",
    mode: "apply",
    state: "armed",
    armedAt: new Date().toISOString(),
    pauseRequested: false,
    cancelRequested: false,
  });
  await writeJsonFile(resultPath, {
    version: 1,
    changeName: "demo-change",
    mode: "apply",
    status: "paused",
    timestamp: new Date().toISOString(),
    summary: "Paused cleanly.",
    progressMade: true,
    changedFiles: ["src/index.ts"],
    notes: ["wrote execution result"],
  });

  const control = await readExecutionControl(controlPath);
  const result = await readExecutionResult(resultPath);

  assert.equal(control?.changeName, "demo-change");
  assert.equal(control?.state, "armed");
  assert.equal(result?.status, "paused");
  assert.deepEqual(result?.changedFiles, ["src/index.ts"]);
  assert.equal(isExecutionTriggerText("continue"), true);
  assert.equal(isExecutionTriggerText("Need one more requirement"), false);
});
