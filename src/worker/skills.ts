import path from "node:path";
import { fileURLToPath } from "node:url";
import { readUtf8 } from "../utils/fs.ts";

export type ClawSpecSkillKey = "apply" | "explore" | "propose";

const skillCache = new Map<ClawSpecSkillKey, string>();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillPaths: Record<ClawSpecSkillKey, string> = {
  apply: path.join(repoRoot, "skills", "openspec-apply-change.md"),
  explore: path.join(repoRoot, "skills", "openspec-explore.md"),
  propose: path.join(repoRoot, "skills", "openspec-propose.md"),
};

export async function loadClawSpecSkillBundle(keys: ClawSpecSkillKey[]): Promise<string> {
  const uniqueKeys = Array.from(new Set(keys));
  const sections: string[] = [];

  for (const key of uniqueKeys) {
    const body = await loadClawSpecSkill(key);
    sections.push([
      `## Imported Skill: ${skillName(key)}`,
      "",
      body.trim(),
    ].join("\n"));
  }

  return sections.join("\n\n");
}

async function loadClawSpecSkill(key: ClawSpecSkillKey): Promise<string> {
  const cached = skillCache.get(key);
  if (cached) {
    return cached;
  }

  const body = await readUtf8(skillPaths[key]);
  skillCache.set(key, body);
  return body;
}

function skillName(key: ClawSpecSkillKey): string {
  switch (key) {
    case "apply":
      return "openspec-apply-change";
    case "explore":
      return "openspec-explore";
    case "propose":
      return "openspec-propose";
  }
}
