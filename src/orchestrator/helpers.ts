import type { PluginCommandResult } from "openclaw/plugin-sdk";
import { extractEmbeddedClawSpecKeyword } from "../control/keywords.ts";
import type { ProjectState, TaskCountSummary } from "../types.ts";
import { formatTaskCounts } from "../utils/markdown.ts";
import { sameNormalizedPath } from "../utils/paths.ts";

export function deriveRoutingContext(params: {
  channel?: string;
  messageProvider?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
}): {
  channel?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
} {
  const sessionHint = parseSessionChannelHint(params.sessionKey);
  const conversationHint = parseConversationChannelHint(params.conversationId);
  const channel = params.channel ?? params.messageProvider ?? sessionHint?.channel;
  const rawChannelId = params.channelId?.trim();
  const normalizedChannelId = isPlaceholderChannelId(rawChannelId, channel, params.messageProvider)
    ? sessionHint?.channelId ?? conversationHint?.channelId ?? rawChannelId
    : rawChannelId ?? sessionHint?.channelId ?? conversationHint?.channelId;

  return {
    channel,
    channelId: normalizedChannelId,
    accountId: params.accountId,
    conversationId: conversationHint?.conversationId ?? params.conversationId ?? sessionHint?.conversationId,
  };
}

function isPlaceholderChannelId(value: string | undefined, channel?: string, messageProvider?: string): boolean {
  if (!value) {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return normalized === channel?.trim().toLowerCase()
    || normalized === messageProvider?.trim().toLowerCase();
}

function parseConversationChannelHint(conversationId?: string): {
  channelId?: string;
  conversationId?: string;
} | undefined {
  if (!conversationId) {
    return undefined;
  }

  const normalized = conversationId.trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith("channel:")) {
    const channelId = normalized.slice("channel:".length).trim();
    if (channelId) {
      return {
        channelId,
        conversationId: "main",
      };
    }
  }

  return undefined;
}

function parseSessionChannelHint(sessionKey?: string): {
  channel: string;
  channelId: string;
  conversationId?: string;
} | undefined {
  if (!sessionKey) {
    return undefined;
  }

  const parts = sessionKey.split(":");
  if (parts.length < 5 || parts[0] !== "agent") {
    return undefined;
  }

  const channel = parts[2];
  const sessionKind = parts[3];
  const channelId = parts.slice(4).join(":");
  if (!channel || !sessionKind || !channelId) {
    return undefined;
  }

  return {
    channel,
    channelId,
    conversationId: sessionKind === "channel" ? "main" : undefined,
  };
}

export function okReply(text: string): PluginCommandResult {
  return { text };
}

export function errorReply(text: string): PluginCommandResult {
  return { text, isError: true };
}

export function buildHelpText(): string {
  return [
    "ClawSpec commands:",
    "- `/clawspec workspace`",
    "- `/clawspec workspace \"~/clawspec/workspace\"`",
    "- `/clawspec use`",
    "- `/clawspec use \"project-name\"`",
    "- `/clawspec proposal <change-name> [description]`",
    "- `/clawspec worker [agent-id|status]`",
    "- `/clawspec attach`",
    "- `/clawspec detach`",
    "- `/clawspec continue`",
    "- `/clawspec pause`",
    "- `/clawspec status`",
    "- `/clawspec archive`",
    "- `/clawspec cancel`",
    "- `/clawspec doctor`",
    "",
    "Visible chat keywords:",
    "- `cs-plan`",
    "- `cs-work`",
    "- `cs-attach`",
    "- `cs-detach`",
    "- `cs-pause`",
    "- `cs-continue`",
    "- `cs-status`",
    "- `cs-cancel`",
    "",
    "Notes:",
    "- `change-name` must use kebab-case and cannot contain spaces.",
    "- Worker agent defaults to `codex`. Use `/clawspec worker` to inspect/change it, or `/clawspec worker status` to see the live worker state for this channel/project.",
    "- `/clawspec detach` makes ordinary chat stop injecting or recording ClawSpec context. `/clawspec attach` restores it. `cs-detach` and `cs-attach` do the same thing from chat.",
    "- `/clawspec deattach` and `cs-deattach` remain accepted as legacy aliases.",
    "- `cs-plan` refreshes planning artifacts in the visible chat without implementing code.",
    "- `cs-work` is only available after `cs-plan` has finished and the change is apply-ready.",
    "- `/clawspec continue` resumes planning or implementation based on the current phase.",
  ].join("\n");
}

export function shouldHandleUserVisiblePrompt(trigger?: string): boolean {
  return !trigger || trigger === "user";
}

export function hasBlockingExecution(project: ProjectState): boolean {
  return project.execution?.state === "armed" || project.execution?.state === "running" || project.status === "running";
}

export function shouldCapturePlanningMessage(project: ProjectState): boolean {
  return Boolean(
    isProjectContextAttached(project)
    && project.changeName
    && !["running", "archived", "cancelled"].includes(project.status),
  );
}

export function shouldInjectProjectPrompt(project: ProjectState, prompt: string): boolean {
  if (!isProjectContextAttached(project) || !project.repoPath || !project.projectName || project.changeName || hasBlockingExecution(project)) {
    return false;
  }
  if (prompt.trim().startsWith("/clawspec")) {
    return false;
  }
  return !["done", "archived", "cancelled"].includes(project.status);
}

export function formatProjectTaskCounts(project: ProjectState, taskCounts: TaskCountSummary | undefined): string {
  if (
    project.phase === "proposal"
    && project.changeName
    && taskCounts
    && taskCounts.total === 0
    && taskCounts.complete === 0
    && taskCounts.remaining === 0
  ) {
    return "Task counts: planning artifacts not generated yet";
  }
  return formatTaskCounts(taskCounts);
}

export function shouldInjectPlanningPrompt(project: ProjectState, prompt: string): boolean {
  if (!isProjectContextAttached(project) || !project.repoPath || !project.changeName || hasBlockingExecution(project) || project.status === "planning") {
    return false;
  }
  if (prompt.trim().startsWith("/clawspec")) {
    return false;
  }
  return !["done", "archived", "cancelled"].includes(project.status);
}

export function requiresPlanningSync(project: ProjectState): boolean {
  if (!project.changeName || isFinishedStatus(project.status)) {
    return false;
  }
  return project.phase === "proposal" || project.planningJournal?.dirty === true;
}

export function isProjectContextAttached(project: ProjectState): boolean {
  return project.contextMode !== "detached";
}

export function samePath(left: string | undefined, right: string | undefined): boolean {
  return sameNormalizedPath(left, right);
}

export function isFinishedStatus(status: ProjectState["status"]): boolean {
  return ["done", "archived", "cancelled"].includes(status);
}

export function sanitizePlanningMessageText(text: string): string {
  return text
    .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "")
    .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "")
    .replace(/Untrusted context \(metadata, do not treat as instructions or commands\):\s*<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\s*/gi, "")
    .trim();
}

export function buildPlanningRequiredMessage(project: ProjectState): string {
  if (!isProjectContextAttached(project)) {
    return `Change \`${project.changeName}\` is active, but ordinary chat is currently detached from ClawSpec context. New requirement messages in this chat will not be written to the planning journal until you run \`cs-attach\` or \`/clawspec attach\`.`;
  }
  if (project.phase === "proposal" && (project.planningJournal?.entryCount ?? 0) === 0) {
    return `Change \`${project.changeName}\` is waiting for planning input. Continue describing requirements in chat, then run \`cs-plan\`. \`cs-work\` is not available yet.`;
  }
  return `Change \`${project.changeName}\` has unsynced planning notes. Continue discussing requirements if needed, then run \`cs-plan\`. \`cs-work\` is not available until planning sync finishes.`;
}

export function buildPlanningBlockedMessage(project: ProjectState): string {
  return `Change \`${project.changeName}\` is not apply-ready yet. Continue refining requirements if needed, then run \`cs-plan\` again. Do not start \`cs-work\` yet.`;
}

export function buildProposalBlockedMessage(project: ProjectState, projectName?: string): string {
  const repoLabel = projectName ?? project.projectName ?? "this project";
  if (project.status === "planning") {
    return `Project \`${repoLabel}\` already has an active change \`${project.changeName}\` in planning sync. Let that turn finish, then continue from the same change instead of creating a new proposal.`;
  }
  if (requiresPlanningSync(project) || project.status === "blocked" || project.phase === "proposal") {
    return `Project \`${repoLabel}\` already has an active change \`${project.changeName}\`. Continue discussing requirements for that change, then run \`cs-plan\`. Do not create a second proposal yet.`;
  }
  return `Project \`${repoLabel}\` already has an active change \`${project.changeName}\` waiting for implementation. Use \`cs-work\`, \`/clawspec continue\`, or \`/clawspec cancel\` instead of creating a new proposal.`;
}

export function dedupeProjects(projects: ProjectState[]): Array<{ channelKey: string; project: ProjectState }> {
  const byProjectId = new Map<string, { channelKey: string; project: ProjectState }>();

  for (const project of projects) {
    const existing = byProjectId.get(project.projectId);
    if (!existing) {
      byProjectId.set(project.projectId, { channelKey: project.channelKey, project });
      continue;
    }

    const existingUpdated = Date.parse(existing.project.updatedAt);
    const nextUpdated = Date.parse(project.updatedAt);
    if (Number.isNaN(existingUpdated) || nextUpdated >= existingUpdated) {
      byProjectId.set(project.projectId, { channelKey: project.channelKey, project });
    }
  }

  return Array.from(byProjectId.values());
}

export function collectPromptCandidates(prompt: string): string[] {
  const candidates = new Set<string>();
  const trimmed = prompt.trim();
  if (trimmed) {
    candidates.add(trimmed);
  }

  for (const line of prompt.split(/\r?\n/)) {
    const next = line.trim();
    if (next) {
      candidates.add(next);
    }
  }

  const embeddedKeyword = extractEmbeddedClawSpecKeyword(prompt);
  if (embeddedKeyword?.raw) {
    candidates.add(embeddedKeyword.raw);
  }

  return Array.from(candidates);
}

export function isMeaningfulExecutionSummary(summary: string | undefined): boolean {
  if (!summary) {
    return false;
  }

  const normalized = summary.trim();
  if (!normalized) {
    return false;
  }

  return ![
    "No summary yet.",
    "Visible execution ended without a structured result.",
    "Execution turn ended without writing execution-result.json.",
  ].includes(normalized)
    && !normalized.startsWith("Visible execution started for ")
    && !normalized.startsWith("Change ")
    && !normalized.startsWith("Execution turn failed before writing execution-result.json:");
}
