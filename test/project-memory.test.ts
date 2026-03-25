import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import {
  DuplicateRememberedProjectError,
  ProjectMemoryStore,
  RememberedProjectPathInvalidError,
} from "../src/memory/store.ts";

test("project memory store remembers, lists, overwrites, and validates paths", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-memory-"));
  const memoryFile = path.join(tempRoot, "project-memory.json");
  const repoA = path.join(tempRoot, "repo-a");
  const repoB = path.join(tempRoot, "repo-b");
  await mkdir(repoA, { recursive: true });
  await mkdir(repoB, { recursive: true });

  const store = new ProjectMemoryStore(memoryFile);
  await store.initialize();

  const created = await store.remember("demo", repoA);
  assert.equal(created.created, true);
  assert.equal(created.overwritten, false);

  const entries = await store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].repoPath, repoA);

  await assert.rejects(() => store.remember("demo", repoB), DuplicateRememberedProjectError);

  const overwritten = await store.remember("demo", repoB, { overwrite: true });
  assert.equal(overwritten.overwritten, true);
  assert.equal((await store.resolveForUse("demo")).repoPath, repoB);

  const staleFile = path.join(tempRoot, "stale-memory.json");
  const staleStore = new ProjectMemoryStore(staleFile);
  await staleStore.initialize();
  await staleStore.remember("stale", path.join(tempRoot, "missing"));
  await assert.rejects(() => staleStore.resolveForUse("stale"), RememberedProjectPathInvalidError);
});
