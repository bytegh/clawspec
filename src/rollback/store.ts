import path from "node:path";
import type { RollbackManifest, RollbackTrackedFile } from "../types.ts";
import {
  copyIfExists,
  ensureDir,
  listFilesRecursive,
  normalizeSlashes,
  pathExists,
  readJsonFile,
  removeIfExists,
  toPosixRelative,
  writeJsonFile,
} from "../utils/fs.ts";
import { getChangeBaselineRoot, getChangeSnapshotRoot, getRepoStatePaths } from "../utils/paths.ts";

export class RollbackStore {
  readonly repoPath: string;
  readonly archiveDirName: string;
  readonly changeName: string;
  readonly manifestPath: string;
  readonly snapshotRoot: string;
  readonly baselineRoot: string;

  constructor(repoPath: string, archiveDirName: string, changeName: string) {
    this.repoPath = repoPath;
    this.archiveDirName = archiveDirName;
    this.changeName = changeName;
    const repoStatePaths = getRepoStatePaths(repoPath, archiveDirName);
    this.manifestPath = repoStatePaths.rollbackManifestFile;
    this.snapshotRoot = getChangeSnapshotRoot(repoPath, archiveDirName, changeName);
    this.baselineRoot = getChangeBaselineRoot(repoPath, archiveDirName, changeName);
  }

  async initializeBaseline(): Promise<RollbackManifest> {
    const existing = await this.readManifest();
    if (existing && existing.changeName === this.changeName && await pathExists(this.baselineRoot)) {
      return existing;
    }

    await removeIfExists(this.snapshotRoot);
    await ensureDir(this.baselineRoot);

    const repoFiles = await listFilesRecursive(this.repoPath);
    for (const filePath of repoFiles) {
      const relativePath = toPosixRelative(this.repoPath, filePath);
      if (!shouldSnapshotPath(relativePath)) {
        continue;
      }
      await copyIfExists(filePath, this.resolveBaselinePath(relativePath));
    }

    const now = new Date().toISOString();
    const manifest: RollbackManifest = {
      version: 1,
      changeName: this.changeName,
      baselineRoot: this.baselineRoot,
      createdAt: now,
      updatedAt: now,
      files: [],
    };
    await writeJsonFile(this.manifestPath, manifest);
    return manifest;
  }

  async readManifest(): Promise<RollbackManifest | null> {
    const manifest = await readJsonFile<RollbackManifest | null>(this.manifestPath, null);
    if (!manifest || manifest.changeName !== this.changeName) {
      return null;
    }
    return manifest;
  }

  async recordTouchedFiles(relativePaths: string[]): Promise<RollbackManifest> {
    const manifest = await this.requireManifest();
    const trackedByPath = new Map<string, RollbackTrackedFile>(
      manifest.files.map((entry) => [entry.path, entry]),
    );

    for (const relativePath of relativePaths) {
      const normalized = normalizeTrackedPath(relativePath);
      if (!normalized || !shouldTrackPath(normalized)) {
        continue;
      }
      trackedByPath.set(normalized, {
        path: normalized,
        kind: await this.detectKind(normalized),
      });
    }

    const next: RollbackManifest = {
      ...manifest,
      updatedAt: new Date().toISOString(),
      files: Array.from(trackedByPath.values()).sort((left, right) => left.path.localeCompare(right.path)),
    };
    await writeJsonFile(this.manifestPath, next);
    return next;
  }

  async restoreTouchedFiles(): Promise<RollbackManifest> {
    const manifest = await this.requireManifest();

    for (const entry of manifest.files) {
      const livePath = this.resolveRepoPath(entry.path);
      const baselinePath = this.resolveBaselinePath(entry.path);

      if (entry.kind === "created") {
        await removeIfExists(livePath);
        continue;
      }

      if (await pathExists(baselinePath)) {
        await copyIfExists(baselinePath, livePath);
        continue;
      }

      await removeIfExists(livePath);
    }

    const next: RollbackManifest = {
      ...manifest,
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(this.manifestPath, next);
    return next;
  }

  async clear(): Promise<void> {
    await removeIfExists(this.snapshotRoot);
    await removeIfExists(this.manifestPath);
  }

  private async requireManifest(): Promise<RollbackManifest> {
    const manifest = await this.readManifest();
    if (!manifest) {
      throw new Error(`Rollback manifest is missing for change \`${this.changeName}\`.`);
    }
    return manifest;
  }

  private async detectKind(relativePath: string): Promise<RollbackTrackedFile["kind"]> {
    const baselineExists = await pathExists(this.resolveBaselinePath(relativePath));
    const liveExists = await pathExists(this.resolveRepoPath(relativePath));
    if (!baselineExists) {
      return "created";
    }
    if (!liveExists) {
      return "deleted";
    }
    return "modified";
  }

  private resolveRepoPath(relativePath: string): string {
    return path.join(this.repoPath, ...relativePath.split("/"));
  }

  private resolveBaselinePath(relativePath: string): string {
    return path.join(this.baselineRoot, ...relativePath.split("/"));
  }
}

function normalizeTrackedPath(relativePath: string): string | undefined {
  const normalized = normalizeSlashes(relativePath).replace(/^\.\//, "");
  return normalized.length === 0 ? undefined : normalized;
}

function shouldSnapshotPath(relativePath: string): boolean {
  return !relativePath.startsWith(".openclaw/clawspec/");
}

function shouldTrackPath(relativePath: string): boolean {
  return shouldSnapshotPath(relativePath);
}
