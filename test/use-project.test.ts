import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../src/utils/fs.ts";
import { createServiceHarness } from "./helpers/harness.ts";

test("useProject initializes repo and selects project", async () => {
  const harness = await createServiceHarness("clawspec-use-project-");
  const { service, stateStore, workspacePath } = harness;
  const channelKey = "discord:use-project:default:main";

  await service.startProject(channelKey);
  const result = await service.useProject(channelKey, "demo-app");
  const project = await stateStore.getActiveProject(channelKey);

  assert.match(result.text ?? "", /Project Selected/);
  assert.equal(project?.repoPath, path.join(workspacePath, "demo-app"));
  assert.equal(await pathExists(path.join(workspacePath, "demo-app", "openspec", "config.yaml")), true);
});

test("workspaceProject resolves quoted home-relative path without nesting into default workspace", async () => {
  const harness = await createServiceHarness("clawspec-workspace-home-");
  const { service, stateStore, workspacePath } = harness;
  const channelKey = "discord:workspace-home:default:main";

  await service.startProject(channelKey);
  const result = await service.workspaceProject(channelKey, "\"~/Desktop/workspace/ai_workspacce\"");
  const project = await stateStore.getActiveProject(channelKey);
  const expected = path.join(os.homedir(), "Desktop", "workspace", "ai_workspacce");

  assert.match(result.text ?? "", /Workspace switched/);
  assert.equal(project?.workspacePath, expected);
  assert.equal(project?.workspacePath?.includes(workspacePath), false);
});

test("workspaceProject keeps absolute paths as absolute targets", async () => {
  const harness = await createServiceHarness("clawspec-workspace-abs-");
  const { service, stateStore } = harness;
  const channelKey = "discord:workspace-abs:default:main";

  await service.startProject(channelKey);

  const unixAbsolute = process.platform === "win32" ? "/var/tmp/clawspec-abs" : "/tmp/clawspec-abs";
  await service.workspaceProject(channelKey, unixAbsolute);
  const projectAfterUnix = await stateStore.getActiveProject(channelKey);
  assert.equal(projectAfterUnix?.workspacePath, path.normalize(unixAbsolute));

  const driveAbsolute = "C:\\Users\\dev\\workspace\\clawspec-abs";
  await service.workspaceProject(channelKey, driveAbsolute);
  const projectAfterDrive = await stateStore.getActiveProject(channelKey);
  assert.equal(projectAfterDrive?.workspacePath, path.normalize(driveAbsolute));
});

test("useProject accepts quoted project names with spaces", async () => {
  const harness = await createServiceHarness("clawspec-use-project-space-");
  const { service, stateStore, workspacePath } = harness;
  const channelKey = "discord:use-project-space:default:main";

  await service.startProject(channelKey);
  const result = await service.useProject(channelKey, "\"team app\"");
  const project = await stateStore.getActiveProject(channelKey);

  assert.match(result.text ?? "", /Project Selected/);
  assert.equal(project?.projectName, "team app");
  assert.equal(project?.repoPath, path.join(workspacePath, "team app"));
});
