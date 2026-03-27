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

test("snapshot is always written after planning sync regardless of journal dirty state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-snapshot-always-"));
  const journalPath = path.join(tempRoot, "planning-journal.jsonl");
  const snapshotPath = path.join(tempRoot, "planning-journal.snapshot.json");
  const store = new PlanningJournalStore(journalPath);

  await store.append({
    timestamp: "2026-03-27T03:00:00.000Z",
    changeName: "test",
    role: "user",
    text: "initial requirement",
  });

  const snapshot1 = await store.writeSnapshot(snapshotPath, "test", "2026-03-27T03:05:00.000Z");
  assert.equal(snapshot1.entryCount, 1);

  await store.append({
    timestamp: "2026-03-27T03:10:00.000Z",
    changeName: "test",
    role: "assistant",
    text: "planning sync response",
  });

  const snapshot2 = await store.writeSnapshot(snapshotPath, "test", "2026-03-27T03:15:00.000Z");
  assert.equal(snapshot2.entryCount, 2);
  assert.equal(await store.hasUnsyncedChanges("test", snapshotPath), false);
});

test("snapshot correctly captures all journal entries including assistant messages", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawspec-snapshot-complete-"));
  const journalPath = path.join(tempRoot, "planning-journal.jsonl");
  const snapshotPath = path.join(tempRoot, "planning-journal.snapshot.json");
  const store = new PlanningJournalStore(journalPath);

  await store.append({
    timestamp: "2026-03-27T03:00:00.000Z",
    changeName: "test",
    role: "user",
    text: "user requirement",
  });
  await store.append({
    timestamp: "2026-03-27T03:05:00.000Z",
    changeName: "test",
    role: "assistant",
    text: "assistant response",
  });

  const snapshot = await store.writeSnapshot(snapshotPath, "test");
  const digest = await store.digest("test");

  assert.equal(snapshot.entryCount, digest.entryCount);
  assert.equal(snapshot.lastEntryAt, digest.lastEntryAt);
  assert.equal(snapshot.contentHash, digest.contentHash);
});
