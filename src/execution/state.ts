import type {
  ExecutionControlFile,
  ExecutionResult,
  ExecutionResultStatus,
  ExecutionState,
} from "../types.ts";
import { pathExists, readJsonFile } from "../utils/fs.ts";

export async function readExecutionControl(filePath: string): Promise<ExecutionControlFile | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }
  return normalizeExecutionControl(await readJsonFile<unknown>(filePath, null));
}

export async function readExecutionResult(filePath: string): Promise<ExecutionResult | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }
  return normalizeExecutionResult(await readJsonFile<unknown>(filePath, null));
}

export function isExecutionTriggerText(text: string): boolean {
  return /^(continue|go|start|run|proceed|ok|okay)$/i.test(text.trim());
}

function normalizeExecutionControl(value: unknown): ExecutionControlFile | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const maybe = value as Record<string, unknown>;
  if (
    maybe.version !== 1 ||
    typeof maybe.changeName !== "string" ||
    !isExecutionState(maybe.state) ||
    !isExecutionMode(maybe.mode) ||
    typeof maybe.armedAt !== "string" ||
    typeof maybe.pauseRequested !== "boolean" ||
    typeof maybe.cancelRequested !== "boolean"
  ) {
    return null;
  }

  return {
    version: 1,
    changeName: maybe.changeName,
    mode: maybe.mode,
    state: maybe.state,
    armedAt: maybe.armedAt,
    startedAt: typeof maybe.startedAt === "string" ? maybe.startedAt : undefined,
    sessionKey: typeof maybe.sessionKey === "string" ? maybe.sessionKey : undefined,
    pauseRequested: maybe.pauseRequested,
    cancelRequested: maybe.cancelRequested,
  };
}

function normalizeExecutionResult(value: unknown): ExecutionResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const maybe = value as Record<string, unknown>;
  if (
    maybe.version !== 1 ||
    typeof maybe.changeName !== "string" ||
    !isExecutionMode(maybe.mode) ||
    !isExecutionResultStatus(maybe.status) ||
    typeof maybe.timestamp !== "string" ||
    typeof maybe.summary !== "string" ||
    typeof maybe.progressMade !== "boolean"
  ) {
    return null;
  }

  return {
    version: 1,
    changeName: maybe.changeName,
    mode: maybe.mode,
    status: maybe.status,
    timestamp: maybe.timestamp,
    summary: maybe.summary,
    progressMade: maybe.progressMade,
    completedTask: typeof maybe.completedTask === "string" ? maybe.completedTask : undefined,
    currentArtifact: typeof maybe.currentArtifact === "string" ? maybe.currentArtifact : undefined,
    changedFiles: Array.isArray(maybe.changedFiles)
      ? maybe.changedFiles.filter((entry): entry is string => typeof entry === "string")
      : [],
    notes: Array.isArray(maybe.notes)
      ? maybe.notes.filter((entry): entry is string => typeof entry === "string")
      : [],
    blocker: typeof maybe.blocker === "string" ? maybe.blocker : undefined,
    taskCounts: normalizeTaskCounts(maybe.taskCounts),
    remainingTasks: typeof maybe.remainingTasks === "number" ? Math.trunc(maybe.remainingTasks) : undefined,
  };
}

function normalizeTaskCounts(value: unknown): ExecutionResult["taskCounts"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const maybe = value as Record<string, unknown>;
  if (
    typeof maybe.total !== "number" ||
    typeof maybe.complete !== "number" ||
    typeof maybe.remaining !== "number"
  ) {
    return undefined;
  }
  return {
    total: Math.trunc(maybe.total),
    complete: Math.trunc(maybe.complete),
    remaining: Math.trunc(maybe.remaining),
  };
}

function isExecutionState(value: unknown): value is ExecutionState {
  return value === "armed" || value === "running";
}

function isExecutionMode(value: unknown): value is ExecutionControlFile["mode"] {
  return value === "apply" || value === "continue";
}

function isExecutionResultStatus(value: unknown): value is ExecutionResultStatus {
  return value === "running" || value === "paused" || value === "blocked" || value === "done" || value === "cancelled";
}
