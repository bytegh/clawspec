import { createHash } from "node:crypto";
import {
  appendUtf8,
  pathExists,
  readJsonFile,
  readUtf8,
  removeIfExists,
  writeJsonFile,
} from "../utils/fs.ts";
import type {
  PlanningJournalEntry,
  PlanningJournalSnapshot,
} from "../types.ts";

type PlanningJournalDigest = {
  changeName: string;
  entryCount: number;
  lastEntryAt?: string;
  contentHash: string;
};

export class PlanningJournalStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async append(entry: PlanningJournalEntry): Promise<void> {
    await appendUtf8(this.filePath, `${JSON.stringify(entry)}\n`);
  }

  async list(changeName?: string): Promise<PlanningJournalEntry[]> {
    if (!(await pathExists(this.filePath))) {
      return [];
    }
    const raw = await readUtf8(this.filePath);
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as PlanningJournalEntry];
        } catch {
          return [];
        }
      });
    return changeName ? entries.filter((entry) => entry.changeName === changeName) : entries;
  }

  async clear(): Promise<void> {
    await removeIfExists(this.filePath);
  }

  async readSnapshot(snapshotPath: string): Promise<PlanningJournalSnapshot | null> {
    return await readJsonFile<PlanningJournalSnapshot | null>(snapshotPath, null);
  }

  async writeSnapshot(snapshotPath: string, changeName: string, syncedAt = new Date().toISOString()): Promise<PlanningJournalSnapshot> {
    const digest = await this.digest(changeName);
    const snapshot: PlanningJournalSnapshot = {
      version: 1,
      changeName,
      syncedAt,
      entryCount: digest.entryCount,
      lastEntryAt: digest.lastEntryAt,
      contentHash: digest.contentHash,
    };
    await writeJsonFile(snapshotPath, snapshot);
    return snapshot;
  }

  async clearSnapshot(snapshotPath: string): Promise<void> {
    await removeIfExists(snapshotPath);
  }

  async hasUnsyncedChanges(
    changeName: string,
    snapshotPath: string,
    fallbackLastSyncedAt?: string,
  ): Promise<boolean> {
    const digest = await this.digest(changeName);
    const snapshot = await this.readSnapshot(snapshotPath);
    if (!snapshot) {
      if (
        fallbackLastSyncedAt
        && digest.lastEntryAt
        && Date.parse(digest.lastEntryAt) <= Date.parse(fallbackLastSyncedAt)
      ) {
        return false;
      }
      return digest.entryCount > 0;
    }
    return snapshot.changeName !== changeName
      || snapshot.entryCount !== digest.entryCount
      || snapshot.lastEntryAt !== digest.lastEntryAt
      || snapshot.contentHash !== digest.contentHash;
  }

  async digest(changeName: string): Promise<PlanningJournalDigest> {
    const entries = await this.list(changeName);
    const normalized = entries.map((entry) => ({
      timestamp: entry.timestamp,
      changeName: entry.changeName,
      role: entry.role,
      text: entry.text,
    }));
    const serialized = JSON.stringify(normalized);
    const contentHash = createHash("sha256").update(serialized).digest("hex");
    return {
      changeName,
      entryCount: normalized.length,
      lastEntryAt: normalized[normalized.length - 1]?.timestamp,
      contentHash,
    };
  }
}
