import os from "node:os";
import path from "node:path";

export type RepoStatePaths = {
  root: string;
  stateFile: string;
  executionControlFile: string;
  executionResultFile: string;
  workerProgressFile: string;
  progressFile: string;
  changedFilesFile: string;
  decisionLogFile: string;
  latestSummaryFile: string;
  planningJournalFile: string;
  planningJournalSnapshotFile: string;
  rollbackManifestFile: string;
  snapshotsRoot: string;
  archivesRoot: string;
};

export function getPluginStateRoot(stateDir: string): string {
  return path.join(stateDir, "clawspec");
}

export function getDefaultWorkspacePath(): string {
  return path.join(os.homedir(), "clawspec", "workspace");
}

export function expandHomeDir(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function resolveUserPath(input: string, baseDir = process.cwd()): string {
  const expanded = expandHomeDir(input);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

export function getProjectMemoryFilePath(stateDir: string): string {
  return path.join(getPluginStateRoot(stateDir), "project-memory.json");
}

export function getWorkspaceStateFilePath(stateDir: string): string {
  return path.join(getPluginStateRoot(stateDir), "workspace-state.json");
}

export function getActiveProjectMapPath(stateDir: string): string {
  return path.join(getPluginStateRoot(stateDir), "active-projects.json");
}

export function getGlobalProjectStatePath(stateDir: string, projectId: string): string {
  return path.join(getPluginStateRoot(stateDir), "projects", `${projectId}.json`);
}

export function getRepoStatePaths(repoPath: string, archiveDirName: string): RepoStatePaths {
  const root = path.join(repoPath, ".openclaw", "clawspec");
  return {
    root,
    stateFile: path.join(root, "state.json"),
    executionControlFile: path.join(root, "execution-control.json"),
    executionResultFile: path.join(root, "execution-result.json"),
    workerProgressFile: path.join(root, "worker-progress.jsonl"),
    progressFile: path.join(root, "progress.md"),
    changedFilesFile: path.join(root, "changed-files.md"),
    decisionLogFile: path.join(root, "decision-log.md"),
    latestSummaryFile: path.join(root, "latest-summary.md"),
    planningJournalFile: path.join(root, "planning-journal.jsonl"),
    planningJournalSnapshotFile: path.join(root, "planning-journal.snapshot.json"),
    rollbackManifestFile: path.join(root, "rollback-manifest.json"),
    snapshotsRoot: path.join(root, "snapshots"),
    archivesRoot: path.join(root, archiveDirName),
  };
}

export function getChangeDir(repoPath: string, changeName: string): string {
  return path.join(repoPath, "openspec", "changes", changeName);
}

export function getTasksPath(repoPath: string, changeName: string): string {
  return path.join(getChangeDir(repoPath, changeName), "tasks.md");
}

export function getChangeSnapshotRoot(repoPath: string, archiveDirName: string, changeName: string): string {
  return path.join(getRepoStatePaths(repoPath, archiveDirName).snapshotsRoot, changeName);
}

export function getChangeBaselineRoot(repoPath: string, archiveDirName: string, changeName: string): string {
  return path.join(getChangeSnapshotRoot(repoPath, archiveDirName, changeName), "baseline");
}

export function resolveProjectScopedPath(
  project: { repoPath?: string; changeDir?: string },
  targetPath: string,
): string {
  if (!targetPath || path.isAbsolute(targetPath)) {
    return targetPath;
  }

  const normalized = targetPath.replace(/^[.][\\/]/, "");
  if (/^(openspec|\.openclaw)([\\/]|$)/.test(normalized)) {
    return project.repoPath ? path.join(project.repoPath, normalized) : normalized;
  }

  if (project.changeDir) {
    return path.join(project.changeDir, normalized);
  }

  return project.repoPath ? path.join(project.repoPath, normalized) : normalized;
}
