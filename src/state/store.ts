import path from "node:path";
import {
  ensureDir,
  pathExists,
  readJsonFile,
  removeIfExists,
  writeJsonFile,
} from "../utils/fs.ts";
import {
  getActiveProjectMapPath,
  getGlobalProjectStatePath,
  getPluginStateRoot,
  getRepoStatePaths,
} from "../utils/paths.ts";
import { createProjectId } from "../utils/slug.ts";
import { withFileLock } from "./locks.ts";
import type { ActiveProjectMap, ProjectPhase, ProjectState, ProjectStatus } from "../types.ts";

export class ActiveProjectConflictError extends Error {
  readonly project: ProjectState;

  constructor(project: ProjectState) {
    super(`Channel already has an active project: ${project.projectId}`);
    this.project = project;
  }
}

export class ProjectStateStore {
  readonly stateDir: string;
  readonly archiveDirName: string;
  private initPromise: Promise<void> | undefined;

  constructor(stateDir: string, archiveDirName: string) {
    this.stateDir = stateDir;
    this.archiveDirName = archiveDirName;
  }

  async initialize(): Promise<void> {
    this.initPromise ??= this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    await ensureDir(getPluginStateRoot(this.stateDir));
    await ensureDir(path.dirname(getActiveProjectMapPath(this.stateDir)));
  }

  async getActiveProject(channelKey: string): Promise<ProjectState | null> {
    return this.withChannelLock(channelKey, async () => {
      const record = await this.readActiveRecord(channelKey);
      if (!record) {
        return null;
      }

      if (!(await pathExists(record.statePath))) {
        await this.deleteActiveRecordIfMatches(channelKey, record.statePath);
        return null;
      }

      const project = await readJsonFile<ProjectState | null>(record.statePath, null);
      if (!project) {
        await this.deleteActiveRecordIfMatches(channelKey, record.statePath);
        return null;
      }
      return project;
    });
  }

  async listActiveProjects(): Promise<ProjectState[]> {
    return this.withActiveMapLock(async () => {
      const mapping = await this.readActiveMap();
      const projects: ProjectState[] = [];
      let dirty = false;

      for (const [channelKey, record] of Object.entries(mapping.channels)) {
        if (!(await pathExists(record.statePath))) {
          delete mapping.channels[channelKey];
          dirty = true;
          continue;
        }

        const project = await readJsonFile<ProjectState | null>(record.statePath, null);
        if (!project) {
          delete mapping.channels[channelKey];
          dirty = true;
          continue;
        }

        projects.push(project);
      }

      if (dirty) {
        await this.writeActiveMap(mapping);
      }

      return projects;
    });
  }

  async findActiveProjectForMessage(params: {
    channel?: string;
    channelId: string;
    accountId?: string;
    conversationId?: string;
  }): Promise<{ channelKey: string; project: ProjectState } | null> {
    return this.withActiveMapLock(async () => {
      const mapping = await this.readActiveMap();
      const accountId = params.accountId ?? "default";
      let dirty = false;
      const exactCandidates: Array<{
        channelKey: string;
        project: ProjectState;
        parsed: ReturnType<typeof parseChannelKey>;
      }> = [];
      const relaxedCandidates: Array<{
        channelKey: string;
        project: ProjectState;
        parsed: ReturnType<typeof parseChannelKey>;
      }> = [];

      for (const [channelKey, record] of Object.entries(mapping.channels)) {
        const parsed = parseChannelKey(channelKey);
        if (parsed.channelId !== params.channelId) {
          continue;
        }

        if (!(await pathExists(record.statePath))) {
          delete mapping.channels[channelKey];
          dirty = true;
          continue;
        }

        const project = await readJsonFile<ProjectState | null>(record.statePath, null);
        if (!project) {
          delete mapping.channels[channelKey];
          dirty = true;
          continue;
        }

        const candidate = { channelKey, project, parsed };
        if (parsed.accountId === accountId) {
          exactCandidates.push(candidate);
        } else {
          relaxedCandidates.push(candidate);
        }
      }

      if (dirty) {
        await this.writeActiveMap(mapping);
      }

      const candidates = exactCandidates.length > 0 ? exactCandidates : relaxedCandidates;
      if (candidates.length === 0) {
        return null;
      }

      const byProjectId = new Map<
        string,
        {
          project: ProjectState;
          aliases: Array<{
            channelKey: string;
            parsed: ReturnType<typeof parseChannelKey>;
          }>;
        }
      >();

      for (const candidate of candidates) {
        const existing = byProjectId.get(candidate.project.projectId);
        if (existing) {
          existing.aliases.push({
            channelKey: candidate.channelKey,
            parsed: candidate.parsed,
          });
          continue;
        }

        byProjectId.set(candidate.project.projectId, {
          project: candidate.project,
          aliases: [
            {
              channelKey: candidate.channelKey,
              parsed: candidate.parsed,
            },
          ],
        });
      }

      if (byProjectId.size === 1) {
        const match = Array.from(byProjectId.values())[0];
        return {
          channelKey: resolveCanonicalChannelKey(mapping, match.project, match.aliases[0]?.channelKey),
          project: match.project,
        };
      }

      const ranked = candidates
        .map((candidate) => ({
          ...candidate,
          score: scoreMessageCandidate(candidate.parsed, params),
        }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score);

      const best = ranked[0];
      if (!best) {
        return null;
      }

      return {
        channelKey: resolveCanonicalChannelKey(mapping, best.project, best.channelKey),
        project: best.project,
      };
    });
  }

  async createProject(channelKey: string): Promise<ProjectState> {
    return this.withChannelLock(channelKey, async () => {
      const existingRecord = await this.readActiveRecord(channelKey);
      if (existingRecord && (await pathExists(existingRecord.statePath))) {
        const existingProject = await readJsonFile<ProjectState | null>(existingRecord.statePath, null);
        if (existingProject && existingProject.status !== "archived") {
          throw new ActiveProjectConflictError(existingProject);
        }
      }

      const now = new Date().toISOString();
      const projectId = createProjectId();
      const storagePath = getGlobalProjectStatePath(this.stateDir, projectId);
      const project: ProjectState = {
        version: 1,
        projectId,
        channelKey,
        storagePath,
        status: "idle",
        phase: "init",
        createdAt: now,
        updatedAt: now,
        pauseRequested: false,
        consecutiveNoProgressTurns: 0,
      };

      return this.persistProjectUnlocked(project, { keepActive: true });
    });
  }

  async updateProject(
    channelKey: string,
    updater: (current: ProjectState) => ProjectState | Promise<ProjectState>,
  ): Promise<ProjectState> {
    return this.withChannelLock(channelKey, async () => {
      const record = await this.readActiveRecord(channelKey);
      if (!record) {
        throw new Error("No active project for this channel.");
      }
      const current = await readJsonFile<ProjectState | null>(record.statePath, null);
      if (!current) {
        await this.deleteActiveRecordIfMatches(channelKey, record.statePath);
        throw new Error("The active project state file could not be loaded.");
      }
      const next = await updater(current);
      next.updatedAt = new Date().toISOString();
      return this.persistProjectUnlocked(next, { keepActive: next.status !== "archived" });
    });
  }

  async clearActiveProject(channelKey: string): Promise<void> {
    await this.withChannelLock(channelKey, async () => {
      await this.deleteActiveRecordIfMatches(channelKey);
    });
  }

  async setRepoPath(
    channelKey: string,
    repoPath: string,
    rememberedProjectName?: string,
  ): Promise<ProjectState> {
    return this.updateProject(channelKey, (project) => ({
      ...project,
      repoPath,
      rememberedProjectName,
      openspecRoot: path.join(repoPath, "openspec"),
      status: "collecting_description",
      phase: "init",
    }));
  }

  async setDescription(
    channelKey: string,
    description: string,
    projectTitle: string,
    changeName: string,
  ): Promise<ProjectState> {
    return this.updateProject(channelKey, (project) => ({
      ...project,
      description,
      projectTitle,
      changeName,
      changeDir: project.repoPath ? path.join(project.repoPath, "openspec", "changes", changeName) : undefined,
      status: "bootstrapping",
      phase: "init",
    }));
  }

  async setLifecycle(
    channelKey: string,
    patch: {
      status?: ProjectStatus;
      phase?: ProjectPhase;
      pauseRequested?: boolean;
      blockedReason?: string | undefined;
      latestSummary?: string | undefined;
      currentTask?: string | undefined;
    },
  ): Promise<ProjectState> {
    return this.updateProject(channelKey, (project) => ({
      ...project,
      ...patch,
    }));
  }

  async moveActiveProjectChannel(sourceChannelKey: string, targetChannelKey: string): Promise<ProjectState | null> {
    if (!sourceChannelKey || !targetChannelKey || sourceChannelKey === targetChannelKey) {
      return this.getActiveProject(targetChannelKey);
    }

    return this.withActiveMapLock(async () => {
      const mapping = await this.readActiveMap();
      const sourceRecord = mapping.channels[sourceChannelKey];
      if (!sourceRecord) {
        return null;
      }

      if (!(await pathExists(sourceRecord.statePath))) {
        delete mapping.channels[sourceChannelKey];
        await this.writeActiveMap(mapping);
        return null;
      }

      const sourceProject = await readJsonFile<ProjectState | null>(sourceRecord.statePath, null);
      if (!sourceProject) {
        delete mapping.channels[sourceChannelKey];
        await this.writeActiveMap(mapping);
        return null;
      }

      const targetRecord = mapping.channels[targetChannelKey];
      if (targetRecord && await pathExists(targetRecord.statePath)) {
        const targetProject = await readJsonFile<ProjectState | null>(targetRecord.statePath, null);
        if (targetProject && targetProject.projectId !== sourceProject.projectId && targetProject.status !== "archived") {
          return targetProject;
        }
      }

      const nextProject: ProjectState = {
        ...sourceProject,
        channelKey: targetChannelKey,
        updatedAt: new Date().toISOString(),
      };

      await writeJsonFile(sourceRecord.statePath, nextProject);
      mapping.channels[targetChannelKey] = {
        projectId: nextProject.projectId,
        statePath: sourceRecord.statePath,
      };
      delete mapping.channels[sourceChannelKey];
      await this.writeActiveMap(mapping);
      return nextProject;
    });
  }

  private async withChannelLock<T>(channelKey: string, action: () => Promise<T>): Promise<T> {
    const lockPath = path.join(getPluginStateRoot(this.stateDir), "locks", `${sanitizeChannelKey(channelKey)}.lock`);
    return withFileLock(lockPath, action);
  }

  private async withActiveMapLock<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = path.join(getPluginStateRoot(this.stateDir), "locks", "active-projects.lock");
    return withFileLock(lockPath, action);
  }

  private async readActiveMap(): Promise<ActiveProjectMap> {
    return readJsonFile<ActiveProjectMap>(getActiveProjectMapPath(this.stateDir), {
      version: 1,
      channels: {},
    });
  }

  private async writeActiveMap(mapping: ActiveProjectMap): Promise<void> {
    await writeJsonFile(getActiveProjectMapPath(this.stateDir), mapping);
  }

  private async persistProjectUnlocked(
    project: ProjectState,
    options: { keepActive: boolean },
  ): Promise<ProjectState> {
    const targetPath = project.repoPath
      ? getRepoStatePaths(project.repoPath, this.archiveDirName).stateFile
      : project.storagePath || getGlobalProjectStatePath(this.stateDir, project.projectId);

    const nextProject: ProjectState = {
      ...project,
      storagePath: targetPath,
    };

    await ensureDir(path.dirname(targetPath));
    await writeJsonFile(targetPath, nextProject);

    if (project.storagePath && project.storagePath !== targetPath) {
      await removeIfExists(project.storagePath);
    }

    await this.withActiveMapLock(async () => {
      const mapping = await this.readActiveMap();
      if (options.keepActive) {
        mapping.channels[nextProject.channelKey] = {
          projectId: nextProject.projectId,
          statePath: targetPath,
        };
      } else {
        delete mapping.channels[nextProject.channelKey];
      }
      await this.writeActiveMap(mapping);
    });
    return nextProject;
  }

  private async readActiveRecord(channelKey: string): Promise<ActiveProjectMap["channels"][string] | undefined> {
    return this.withActiveMapLock(async () => {
      const mapping = await this.readActiveMap();
      return mapping.channels[channelKey];
    });
  }

  private async deleteActiveRecordIfMatches(channelKey: string, expectedStatePath?: string): Promise<void> {
    await this.withActiveMapLock(async () => {
      const mapping = await this.readActiveMap();
      const record = mapping.channels[channelKey];
      if (!record) {
        return;
      }
      if (expectedStatePath && record.statePath !== expectedStatePath) {
        return;
      }
      delete mapping.channels[channelKey];
      await this.writeActiveMap(mapping);
    });
  }
}

function sanitizeChannelKey(channelKey: string): string {
  return channelKey.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function parseChannelKey(channelKey: string): {
  channel: string;
  channelId: string;
  accountId: string;
  conversationId: string;
} {
  const [channel = "", channelId = "", accountId = "", ...conversationParts] = channelKey.split(":");
  return {
    channel,
    channelId,
    accountId,
    conversationId: conversationParts.join(":"),
  };
}

function resolveCanonicalChannelKey(
  mapping: ActiveProjectMap,
  project: ProjectState,
  fallbackChannelKey?: string,
): string {
  if (mapping.channels[project.channelKey]) {
    return project.channelKey;
  }
  return fallbackChannelKey ?? project.channelKey;
}

function scoreMessageCandidate(
  candidate: {
    channel: string;
    channelId: string;
    accountId: string;
    conversationId: string;
  },
  params: {
    channel?: string;
    channelId: string;
    accountId?: string;
    conversationId?: string;
  },
): number {
  let score = 0;

  if (params.channel && candidate.channel === params.channel) {
    score += 8;
  }

  const requestedConversation = normalizeConversationId(params.conversationId);
  const candidateConversation = normalizeConversationId(candidate.conversationId);
  if (requestedConversation && candidateConversation === requestedConversation) {
    score += 16;
  }

  if (requestedConversation && matchesSlashConversation(candidateConversation, requestedConversation)) {
    score += 12;
  }

  if (!requestedConversation && candidateConversation === "main") {
    score += 4;
  }

  return score;
}

function normalizeConversationId(value?: string): string {
  return value?.trim() ?? "";
}

function matchesSlashConversation(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  return left === `slash:${right}` || right === `slash:${left}`;
}
