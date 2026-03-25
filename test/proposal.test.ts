import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathExists } from "../src/utils/fs.ts";
import { createServiceHarness } from "./helpers/harness.ts";

test("proposal creates scaffold and rollback baseline", async () => {
  const harness = await createServiceHarness("clawspec-proposal-");
  const { service, stateStore, workspacePath } = harness;
  const channelKey = "discord:proposal:default:main";

  await service.startProject(channelKey);
  await service.useProject(channelKey, "demo-app");
  const result = await service.proposalProject(channelKey, "support-weather Add weather endpoints");
  const project = await stateStore.getActiveProject(channelKey);
  const changeDir = path.join(workspacePath, "demo-app", "openspec", "changes", "support-weather");

  assert.match(result.text ?? "", /Proposal Ready/);
  assert.equal(project?.changeName, "support-weather");
  assert.equal(project?.status, "ready");
  assert.equal(project?.phase, "proposal");
  assert.equal(await pathExists(path.join(changeDir, ".openspec.yaml")), true);
  assert.equal(await pathExists(project?.rollback?.manifestPath ?? ""), true);
});
