import test from "node:test";
import assert from "node:assert/strict";
import { buildHelpText } from "../src/orchestrator/helpers.ts";

test("help text only advertises the clawspec command surface", () => {
  const help = buildHelpText();

  assert.match(help, /\/clawspec workspace/);
  assert.match(help, /\/clawspec proposal <change-name> \[description\]/);
  assert.match(help, /\/clawspec continue/);
  assert.match(help, /cs-plan/);
  assert.match(help, /cs-work/);

  assert.doesNotMatch(help, /`\/project\b/);
  assert.doesNotMatch(help, /\/clawspec apply\b/);
  assert.doesNotMatch(help, /cs-proposal\b/);
  assert.doesNotMatch(help, /cs-propose\b/);
  assert.doesNotMatch(help, /cs-pop\b/);
  assert.doesNotMatch(help, /cs-push\b/);
});
