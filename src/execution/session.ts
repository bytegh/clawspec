import type { ProjectState } from "../types.ts";

export function buildWorkerSessionKey(
  project: ProjectState,
  workerSlot = "primary",
  workerAgentId?: string,
): string {
  return `clawspec:${project.projectId}:${project.changeName ?? "none"}:${workerSlot}:${normalizeWorkerAgentId(workerAgentId ?? project.workerAgentId ?? "default")}`;
}

export function createWorkerSessionKey(
  project: ProjectState,
  options?: {
    workerSlot?: string;
    workerAgentId?: string;
    attemptKey?: string;
  },
): string {
  const base = buildWorkerSessionKey(
    project,
    options?.workerSlot,
    options?.workerAgentId,
  );
  const attemptKey = normalizeSessionAttemptKey(options?.attemptKey);
  return `${base}:${attemptKey}`;
}

export function matchesExecutionSession(project: ProjectState, sessionKey?: string): boolean {
  if (!sessionKey) {
    return false;
  }

  const executionSessionKey = project.execution?.sessionKey;
  if (!executionSessionKey) {
    return false;
  }

  if (executionSessionKey === sessionKey) {
    return true;
  }

  return executionSessionKey === project.boundSessionKey
    && project.boundSessionKey === sessionKey;
}

function normalizeWorkerAgentId(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function normalizeSessionAttemptKey(value?: string): string {
  const normalized = (value ?? new Date().toISOString())
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized.length > 0 ? normalized : "run";
}
