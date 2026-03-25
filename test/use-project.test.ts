import test from "node:test";
import assert from "node:assert/strict";
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
