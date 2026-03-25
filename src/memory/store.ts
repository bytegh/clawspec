import path from "node:path";
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from "../utils/fs.ts";
import type { ProjectMemoryFile, RememberedProject } from "../types.ts";

export class DuplicateRememberedProjectError extends Error {
  readonly existing: RememberedProject;

  constructor(existing: RememberedProject) {
    super(`Remembered project "${existing.name}" already exists.`);
    this.existing = existing;
  }
}

export class RememberedProjectNotFoundError extends Error {
  constructor(name: string) {
    super(`Remembered project "${name}" was not found.`);
  }
}

export class RememberedProjectPathInvalidError extends Error {
  readonly entry: RememberedProject;

  constructor(entry: RememberedProject) {
    super(`Remembered project "${entry.name}" points to an invalid path: ${entry.repoPath}`);
    this.entry = entry;
  }
}

export class ProjectMemoryStore {
  readonly filePath: string;
  private initPromise: Promise<void> | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async initialize(): Promise<void> {
    this.initPromise ??= this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    if (!(await pathExists(this.filePath))) {
      await this.writeRegistry({ version: 1, projects: [] });
    }
  }

  async list(): Promise<RememberedProject[]> {
    const registry = await this.readRegistry();
    return [...registry.projects].sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(name: string): Promise<RememberedProject | null> {
    const normalizedName = normalizeName(name);
    const registry = await this.readRegistry();
    return registry.projects.find((entry) => entry.normalizedName === normalizedName) ?? null;
  }

  async remember(
    name: string,
    repoPath: string,
    options?: { overwrite?: boolean },
  ): Promise<{ entry: RememberedProject; created: boolean; overwritten: boolean }> {
    const overwrite = options?.overwrite === true;
    const normalizedName = normalizeName(name);
    const registry = await this.readRegistry();
    const now = new Date().toISOString();
    const existing = registry.projects.find((entry) => entry.normalizedName === normalizedName);
    if (existing && !overwrite) {
      throw new DuplicateRememberedProjectError(existing);
    }

    const entry: RememberedProject = {
      name: name.trim(),
      normalizedName,
      repoPath: path.resolve(repoPath),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    registry.projects = registry.projects.filter((candidate) => candidate.normalizedName !== normalizedName);
    registry.projects.push(entry);
    await this.writeRegistry(registry);

    return {
      entry,
      created: !existing,
      overwritten: Boolean(existing),
    };
  }

  async resolveForUse(name: string): Promise<RememberedProject> {
    const entry = await this.get(name);
    if (!entry) {
      throw new RememberedProjectNotFoundError(name);
    }
    if (!(await pathExists(entry.repoPath))) {
      throw new RememberedProjectPathInvalidError(entry);
    }
    return entry;
  }

  private async readRegistry(): Promise<ProjectMemoryFile> {
    return readJsonFile<ProjectMemoryFile>(this.filePath, {
      version: 1,
      projects: [],
    });
  }

  private async writeRegistry(value: ProjectMemoryFile): Promise<void> {
    await writeJsonFile(this.filePath, value);
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
