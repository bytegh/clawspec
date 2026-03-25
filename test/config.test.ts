import test from "node:test";
import assert from "node:assert/strict";
import { parsePluginConfig } from "../src/config.ts";

test("parsePluginConfig returns defaults for empty input", () => {
  const config = parsePluginConfig(undefined);
  assert.equal(config.enabled, true);
  assert.equal(config.workerAgentId, "codex");
  assert.equal(config.archiveDirName, "archives");
  assert.equal(config.openSpecTimeoutMs, 120_000);
  assert.equal(config.watcherPollIntervalMs, 4_000);
  assert.equal(config.maxAutoContinueTurns, 3);
  assert.equal(config.maxNoProgressTurns, 2);
  assert.equal(config.workerBackendId, undefined);
  assert.equal(config.subagentLane, undefined);
  assert.equal(config.allowedChannels, undefined);
});

test("parsePluginConfig overrides specific fields", () => {
  const config = parsePluginConfig({
    enabled: false,
    workerAgentId: "my-agent",
    archiveDirName: "custom-archive",
  });
  assert.equal(config.enabled, false);
  assert.equal(config.workerAgentId, "my-agent");
  assert.equal(config.archiveDirName, "custom-archive");
});

test("parsePluginConfig clamps integer values to range", () => {
  const config = parsePluginConfig({
    maxAutoContinueTurns: 999,
    maxNoProgressTurns: 0,
    openSpecTimeoutMs: 1,
    watcherPollIntervalMs: 100_000,
  });
  assert.equal(config.maxAutoContinueTurns, 50);
  assert.equal(config.maxNoProgressTurns, 1);
  assert.equal(config.openSpecTimeoutMs, 5_000);
  assert.equal(config.watcherPollIntervalMs, 60_000);
});

test("parsePluginConfig ignores invalid types", () => {
  const config = parsePluginConfig({
    enabled: "yes" as any,
    maxAutoContinueTurns: "five" as any,
    workerAgentId: 123 as any,
  });
  assert.equal(config.enabled, true); // falls back to default
  assert.equal(config.maxAutoContinueTurns, 3); // falls back to default
  assert.equal(config.workerAgentId, "codex"); // falls back to default
});

test("parsePluginConfig filters allowedChannels", () => {
  const config = parsePluginConfig({
    allowedChannels: ["chan1", "", "  ", "chan2", 42 as any],
  });
  assert.deepEqual(config.allowedChannels, ["chan1", "chan2"]);
});

test("parsePluginConfig trims string values", () => {
  const config = parsePluginConfig({
    workerAgentId: "  my-agent  ",
    workerBackendId: "  backend  ",
  });
  assert.equal(config.workerAgentId, "my-agent");
  assert.equal(config.workerBackendId, "backend");
});

test("parsePluginConfig treats empty strings as undefined for optional strings", () => {
  const config = parsePluginConfig({
    workerBackendId: "",
    subagentLane: "   ",
  });
  assert.equal(config.workerBackendId, undefined);
  assert.equal(config.subagentLane, undefined);
});
