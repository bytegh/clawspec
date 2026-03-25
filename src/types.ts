export const PROJECT_STATUSES = [
  "idle",
  "collecting_path",
  "collecting_description",
  "bootstrapping",
  "planning",
  "ready",
  "armed",
  "running",
  "paused",
  "blocked",
  "done",
  "archived",
  "cancelled",
  "error",
] as const;

export const PROJECT_PHASES = [
  "init",
  "proposal",
  "specs",
  "design",
  "tasks",
  "planning_sync",
  "implementing",
  "validating",
  "archiving",
  "cancelling",
] as const;

export const EXECUTION_STATES = ["armed", "running"] as const;
export const EXECUTION_RESULT_STATUSES = ["running", "paused", "blocked", "done", "cancelled"] as const;
export const EXECUTION_MODES = ["apply", "continue"] as const;
export const EXECUTION_ACTIONS = ["plan", "work"] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectPhase = (typeof PROJECT_PHASES)[number];
export type ExecutionState = (typeof EXECUTION_STATES)[number];
export type ExecutionResultStatus = (typeof EXECUTION_RESULT_STATUSES)[number];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type ExecutionAction = (typeof EXECUTION_ACTIONS)[number];

export type TaskCountSummary = {
  total: number;
  complete: number;
  remaining: number;
};

export type RememberedProject = {
  name: string;
  normalizedName: string;
  repoPath: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectMemoryFile = {
  version: 1;
  projects: RememberedProject[];
};

export type WorkspaceRecord = {
  path: string;
  lastUsedAt: string;
};

export type WorkspaceStateFile = {
  version: 1;
  currentWorkspace: string;
  currentWorkspaceByChannel?: Record<string, string>;
  workspaces: WorkspaceRecord[];
};

export type ActiveProjectMap = {
  version: 1;
  channels: Record<
    string,
    {
      projectId: string;
      statePath: string;
    }
  >;
};

export type ProjectExecutionState = {
  mode: ExecutionMode;
  action: ExecutionAction;
  state: ExecutionState;
  workerAgentId?: string;
  workerSlot?: string;
  armedAt: string;
  startedAt?: string;
  sessionKey?: string;
  backendId?: string;
  triggerPrompt?: string;
  lastTriggerAt?: string;
  currentArtifact?: string;
  currentTaskId?: string;
  lastHeartbeatAt?: string;
  restartCount?: number;
  lastRestartAt?: string;
  lastFailure?: string;
};

export type ExecutionControlFile = {
  version: 1;
  changeName: string;
  mode: ExecutionMode;
  state: ExecutionState;
  armedAt: string;
  startedAt?: string;
  sessionKey?: string;
  pauseRequested: boolean;
  cancelRequested: boolean;
};

export type ExecutionResult = {
  version: 1;
  changeName: string;
  mode: ExecutionMode;
  status: ExecutionResultStatus;
  timestamp: string;
  summary: string;
  progressMade: boolean;
  completedTask?: string;
  currentArtifact?: string;
  changedFiles: string[];
  notes: string[];
  blocker?: string;
  taskCounts?: TaskCountSummary;
  remainingTasks?: number;
};

export type ProjectState = {
  version: 1;
  projectId: string;
  channelKey: string;
  storagePath: string;
  status: ProjectStatus;
  phase: ProjectPhase;
  createdAt: string;
  updatedAt: string;
  workspacePath?: string;
  repoPath?: string;
  projectName?: string;
  rememberedProjectName?: string;
  projectTitle?: string;
  workerAgentId?: string;
  description?: string;
  changeName?: string;
  openspecRoot?: string;
  changeDir?: string;
  pauseRequested: boolean;
  cancelRequested?: boolean;
  blockedReason?: string;
  currentTask?: string;
  taskCounts?: TaskCountSummary;
  latestSummary?: string;
  lastNotificationKey?: string;
  execution?: ProjectExecutionState;
  lastExecutionAt?: string;
  lastExecution?: ExecutionResult;
  planningJournal?: PlanningJournalState;
  rollback?: RollbackState;
  archivePath?: string;
  boundSessionKey?: string;
  contextMode?: "attached" | "detached";
};

export type PlanningJournalEntry = {
  timestamp: string;
  changeName: string;
  role: "user" | "assistant";
  text: string;
};

export type PlanningJournalState = {
  dirty: boolean;
  entryCount: number;
  lastEntryAt?: string;
  lastSyncedAt?: string;
};

export type PlanningJournalSnapshot = {
  version: 1;
  changeName: string;
  syncedAt: string;
  entryCount: number;
  lastEntryAt?: string;
  contentHash: string;
};

export type RollbackTrackedFileKind = "modified" | "created" | "deleted";

export type RollbackTrackedFile = {
  path: string;
  kind: RollbackTrackedFileKind;
};

export type RollbackManifest = {
  version: 1;
  changeName: string;
  baselineRoot: string;
  createdAt: string;
  updatedAt: string;
  files: RollbackTrackedFile[];
  cancelledAt?: string;
  archivedAt?: string;
};

export type RollbackState = {
  baselineRoot?: string;
  manifestPath?: string;
  snapshotReady?: boolean;
  touchedFileCount?: number;
  lastUpdatedAt?: string;
};

export type ParsedTask = {
  raw: string;
  lineNumber: number;
  checked: boolean;
  taskId: string;
  description: string;
};

export type ParsedTaskList = {
  tasks: ParsedTask[];
  counts: TaskCountSummary;
};

export type OpenSpecArtifactRecord = {
  id: string;
  outputPath: string;
  status: string;
};

export type OpenSpecStatusResponse = {
  changeName: string;
  schemaName: string;
  isComplete: boolean;
  applyRequires: string[];
  artifacts: OpenSpecArtifactRecord[];
};

export type OpenSpecArtifactDependency = {
  id: string;
  done: boolean;
  path: string;
  description: string;
};

export type OpenSpecInstructionsResponse = {
  changeName: string;
  artifactId: string;
  schemaName: string;
  changeDir: string;
  outputPath: string;
  description: string;
  instruction: string;
  template: string;
  dependencies: OpenSpecArtifactDependency[];
  unlocks: string[];
};

export type OpenSpecApplyInstructionsResponse = {
  changeName: string;
  changeDir: string;
  schemaName: string;
  contextFiles: Record<string, string>;
  progress: TaskCountSummary;
  tasks: Array<{
    id: string;
    description: string;
    done: boolean;
  }>;
  state: "ready" | "blocked" | "all_done";
  instruction: string;
};

export type OpenSpecValidationResponse = {
  valid?: boolean;
  errors?: unknown[];
  warnings?: unknown[];
};

export type OpenSpecCommandResult<T = undefined> = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  parsed?: T;
};
