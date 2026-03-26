import path from "node:path";
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from "../utils/fs.ts";
import { sameNormalizedPath } from "../utils/paths.ts";
import type { WorkspaceRecord, WorkspaceStateFile } from "../types.ts";

export class WorkspaceStore {
  readonly filePath: string;
  readonly defaultWorkspace: string;
  private initPromise: Promise<void> | undefined;

  constructor(filePath: string, defaultWorkspace: string) {
    this.filePath = filePath;
    this.defaultWorkspace = path.normalize(defaultWorkspace);
  }

  async initialize(): Promise<void> {
    this.initPromise ??= this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    if (!(await pathExists(this.filePath))) {
      await this.writeState({
        version: 1,
        currentWorkspace: this.defaultWorkspace,
        currentWorkspaceByChannel: {},
        workspaces: [{
          path: this.defaultWorkspace,
          lastUsedAt: new Date().toISOString(),
        }],
      });
    }

    const currentWorkspace = await this.getCurrentWorkspace();
    await ensureDir(currentWorkspace);
  }

  async getCurrentWorkspace(channelKey?: string): Promise<string> {
    const state = await this.readState();
    if (channelKey) {
      const channelWorkspace = state.currentWorkspaceByChannel?.[channelKey];
      if (channelWorkspace) {
        return path.normalize(channelWorkspace);
      }
    }
    return path.normalize(state.currentWorkspace || this.defaultWorkspace);
  }

  async list(): Promise<WorkspaceRecord[]> {
    const state = await this.readState();
    return [...state.workspaces].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
  }

  async useWorkspace(workspacePath: string, channelKey?: string): Promise<WorkspaceStateFile> {
    const normalized = path.normalize(workspacePath);
    await ensureDir(normalized);
    const state = await this.readState();
    const now = new Date().toISOString();
    const existing = state.workspaces.find((entry) => sameNormalizedPath(entry.path, normalized));
    const nextByChannel = { ...(state.currentWorkspaceByChannel ?? {}) };
    if (channelKey) {
      nextByChannel[channelKey] = normalized;
    }

    const next: WorkspaceStateFile = {
      version: 1,
      currentWorkspace: normalized,
      currentWorkspaceByChannel: nextByChannel,
      workspaces: [
        ...state.workspaces.filter((entry) => !sameNormalizedPath(entry.path, normalized)),
        {
          path: normalized,
          lastUsedAt: now,
        },
      ],
    };

    if (!existing && next.workspaces.length === 0) {
      next.workspaces.push({ path: normalized, lastUsedAt: now });
    }

    await this.writeState(next);
    return next;
  }

  private async readState(): Promise<WorkspaceStateFile> {
    const fallback: WorkspaceStateFile = {
      version: 1,
      currentWorkspace: this.defaultWorkspace,
      currentWorkspaceByChannel: {},
      workspaces: [{
        path: this.defaultWorkspace,
        lastUsedAt: new Date(0).toISOString(),
      }],
    };
    const raw = await readJsonFile<WorkspaceStateFile | (WorkspaceStateFile & { workspace?: string })>(
      this.filePath,
      fallback,
    );

    const currentWorkspace = path.normalize(
      (raw as WorkspaceStateFile).currentWorkspace ?? (raw as { workspace?: string }).workspace ?? this.defaultWorkspace,
    );
    const currentWorkspaceByChannel = typeof (raw as WorkspaceStateFile).currentWorkspaceByChannel === "object"
      && (raw as WorkspaceStateFile).currentWorkspaceByChannel
      ? Object.fromEntries(
          Object.entries((raw as WorkspaceStateFile).currentWorkspaceByChannel ?? {})
            .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
            .map(([channelKey, workspacePath]) => [channelKey, path.normalize(workspacePath)]),
        )
      : {};
    const workspaces = Array.isArray((raw as WorkspaceStateFile).workspaces)
      ? (raw as WorkspaceStateFile).workspaces
          .filter((entry): entry is WorkspaceRecord => typeof entry?.path === "string" && entry.path.trim().length > 0)
          .map((entry) => ({
            path: path.normalize(entry.path),
            lastUsedAt: entry.lastUsedAt || new Date(0).toISOString(),
          }))
      : [];

    if (!workspaces.some((entry) => sameNormalizedPath(entry.path, currentWorkspace))) {
      workspaces.push({
        path: currentWorkspace,
        lastUsedAt: new Date().toISOString(),
      });
    }

    return {
      version: 1,
      currentWorkspace,
      currentWorkspaceByChannel,
      workspaces,
    };
  }

  private async writeState(state: WorkspaceStateFile): Promise<void> {
    await writeJsonFile(this.filePath, state);
  }
}
