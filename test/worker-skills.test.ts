import test from "node:test";
import assert from "node:assert/strict";
import { loadClawSpecSkillBundle } from "../src/worker/skills.ts";

test("loadClawSpecSkillBundle reads bundled runtime skills", async () => {
  const bundle = await loadClawSpecSkillBundle(["apply", "explore", "propose"]);

  assert.match(bundle, /Imported Skill: openspec-apply-change/);
  assert.match(bundle, /Imported Skill: openspec-explore/);
  assert.match(bundle, /Imported Skill: openspec-propose/);
  assert.doesNotMatch(bundle, /\.codex[\\/]/);
});
