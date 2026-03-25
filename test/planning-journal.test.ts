import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { PlanningJournalStore } from "../src/planning/journal.ts";

test("planning journal reports clean when snapshot matches current content", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-journal-clean-"));
  const journalPath = path.join(tempRoot, "planning-journal.jsonl");
  const snapshotPath = path.join(tempRoot, "planning-journal.snapshot.json");
  const store = new PlanningJournalStore(journalPath);

  await store.append({
    timestamp: "2026-03-23T07:00:00.000Z",
    changeName: "hello",
    role: "user",
    text: "keep the two existing endpoints",
  });
  await store.writeSnapshot(snapshotPath, "hello", "2026-03-23T07:05:00.000Z");

  assert.equal(await store.hasUnsyncedChanges("hello", snapshotPath), false);
});

test("planning journal reports dirty when a new entry is appended after the snapshot", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-journal-dirty-"));
  const journalPath = path.join(tempRoot, "planning-journal.jsonl");
  const snapshotPath = path.join(tempRoot, "planning-journal.snapshot.json");
  const store = new PlanningJournalStore(journalPath);

  await store.append({
    timestamp: "2026-03-23T07:00:00.000Z",
    changeName: "hello",
    role: "user",
    text: "keep the two existing endpoints",
  });
  await store.writeSnapshot(snapshotPath, "hello", "2026-03-23T07:05:00.000Z");
  await store.append({
    timestamp: "2026-03-23T07:10:00.000Z",
    changeName: "hello",
    role: "user",
    text: "add two new interfaces to the same change",
  });

  assert.equal(await store.hasUnsyncedChanges("hello", snapshotPath), true);
});

test("planning journal falls back to lastSyncedAt when no snapshot exists yet", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-journal-fallback-"));
  const journalPath = path.join(tempRoot, "planning-journal.jsonl");
  const snapshotPath = path.join(tempRoot, "planning-journal.snapshot.json");
  const store = new PlanningJournalStore(journalPath);

  await store.append({
    timestamp: "2026-03-23T07:00:00.000Z",
    changeName: "hello",
    role: "user",
    text: "keep the two existing endpoints",
  });

  assert.equal(
    await store.hasUnsyncedChanges("hello", snapshotPath, "2026-03-23T07:05:00.000Z"),
    false,
  );
  assert.equal(
    await store.hasUnsyncedChanges("hello", snapshotPath, "2026-03-23T06:55:00.000Z"),
    true,
  );
});
