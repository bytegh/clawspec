import path from "node:path";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  PluginCommandContext,
  PluginCommandResult,
  PluginLogger,
} from "openclaw/plugin-sdk";
import { ProjectMemoryStore } from "../memory/store.ts";
import { OpenSpecClient, OpenSpecCommandError } from "../openspec/cli.ts";
import { parseTasksFile } from "../openspec/tasks.ts";
import { PlanningJournalStore } from "../planning/journal.ts";
import { RollbackStore } from "../rollback/store.ts";
import { ActiveProjectConflictError, ProjectStateStore } from "../state/store.ts";
import {
  extractEmbeddedClawSpecKeyword,
  parseClawSpecKeyword,
  type ClawSpecKeywordIntent,
} from "../control/keywords.ts";
import type {
  ExecutionControlFile,
  ExecutionMode,
  ExecutionResult,
  OpenSpecApplyInstructionsResponse,
  OpenSpecCommandResult,
  OpenSpecStatusResponse,
  ProjectState,
  TaskCountSummary,
} from "../types.ts";
import { splitSubcommand, tokenizeArgs } from "../utils/args.ts";
import { buildChannelKeyFromCommand, buildLegacyChannelKeyFromCommand } from "../utils/channel-key.ts";
import {
  appendUtf8,
  directoryExists,
  ensureDir,
  listDirectories,
  normalizeSlashes,
  pathExists,
  readJsonFile,
  readUtf8,
  removeIfExists,
  tryReadUtf8,
  writeJsonFile,
  writeUtf8,
} from "../utils/fs.ts";
import {
  formatCommandOutputSection,
  formatExecutionSummary,
  heading,
} from "../utils/markdown.ts";
import {
  getChangeDir,
  getRepoStatePaths,
  getTasksPath,
  resolveUserPath,
  type RepoStatePaths,
} from "../utils/paths.ts";
import { BLOCKING_EXECUTION_MSG, SELECT_PROJECT_FIRST_MSG } from "../utils/messages.ts";
import {
  buildHelpText,
  buildPlanningBlockedMessage,
  buildPlanningRequiredMessage,
  buildProposalBlockedMessage,
  collectPromptCandidates,
  dedupeProjects,
  deriveRoutingContext,
  errorReply,
  formatProjectTaskCounts,
  hasBlockingExecution,
  isFinishedStatus,
  isMeaningfulExecutionSummary,
  isProjectContextAttached,
  okReply,
  requiresPlanningSync,
  samePath,
  sanitizePlanningMessageText,
  shouldCapturePlanningMessage,
  shouldHandleUserVisiblePrompt,
  shouldInjectPlanningPrompt,
  shouldInjectProjectPrompt,
} from "./helpers.ts";
import { slugToTitle } from "../utils/slug.ts";
import { WorkspaceStore } from "../workspace/store.ts";
import { isExecutionTriggerText, readExecutionResult } from "../execution/state.ts";
import { createWorkerSessionKey, matchesExecutionSession } from "../execution/session.ts";
import {
  buildWorkerAgentSetupHint,
  buildWorkerAgentSetupMessage,
  getConfiguredDefaultWorkerAgent,
  listConfiguredWorkerAgents,
} from "../acp/openclaw-config.ts";
import {
  buildExecutionPrependContext,
  buildExecutionSystemContext,
  buildProjectPrependContext,
  buildProjectSystemContext,
  buildPlanningPrependContext,
  buildPlanningSystemContext,
  buildPluginReplyPrependContext,
  buildPluginReplySystemContext,
} from "../worker/prompts.ts";
import { loadClawSpecSkillBundle } from "../worker/skills.ts";
import type { WatcherManager } from "../watchers/manager.ts";
import type { AcpWorkerStatus } from "../acp/client.ts";

type PromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};

type PromptBuildContext = {
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channel?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
};

type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

type ClawSpecServiceOptions = {
  api: OpenClawPluginApi;
  config: OpenClawConfig;
  logger: PluginLogger;
  stateStore: ProjectStateStore;
  memoryStore: ProjectMemoryStore;
  openSpec: OpenSpecClient;
  archiveDirName: string;
  defaultWorkspace: string;
  defaultWorkerAgentId?: string;
  workspaceStore: WorkspaceStore;
  allowedChannels?: string[];
  maxAutoContinueTurns?: number;
  maxNoProgressTurns?: number;
  workerWaitTimeoutMs?: number;
  subagentLane?: string;
  watcherManager?: WatcherManager;
};

type ProjectCatalogEntry = {
  label: string;
  repoPath: string;
  source: "workspace";
};

export class ClawSpecService {
  readonly api: OpenClawPluginApi;
  readonly config: OpenClawConfig;
  readonly logger: PluginLogger;
  readonly stateStore: ProjectStateStore;
  readonly memoryStore: ProjectMemoryStore;
  readonly openSpec: OpenSpecClient;
  readonly archiveDirName: string;
  readonly defaultWorkspace: string;
  readonly defaultWorkerAgentId?: string;
  readonly workspaceStore: WorkspaceStore;
  readonly allowedChannels?: string[];
  readonly watcherManager?: WatcherManager;
  readonly recentOutboundMessages = new Map<string, Array<{ text: string; timestamp: number }>>();

  constructor(options: ClawSpecServiceOptions) {
    this.api = options.api;
    this.config = options.config;
    this.logger = options.logger;
    this.stateStore = options.stateStore;
    this.memoryStore = options.memoryStore;
    this.openSpec = options.openSpec;
    this.archiveDirName = options.archiveDirName;
    this.defaultWorkspace = options.defaultWorkspace;
    this.defaultWorkerAgentId = options.defaultWorkerAgentId;
    this.workspaceStore = options.workspaceStore;
    this.allowedChannels = options.allowedChannels;
    this.watcherManager = options.watcherManager;
  }

  async handleProjectCommand(ctx: PluginCommandContext): Promise<PluginCommandResult> {
    if (this.allowedChannels && this.allowedChannels.length > 0 && !this.allowedChannels.includes(ctx.channel)) {
      return errorReply(`ClawSpec is disabled for channel \`${ctx.channel}\`.`);
    }

    const { subcommand, rest } = splitSubcommand(ctx.args);
    const channelKey = buildChannelKeyFromCommand(ctx);
    const legacyChannelKey = buildLegacyChannelKeyFromCommand(ctx);

    if (legacyChannelKey !== channelKey) {
      await this.stateStore.moveActiveProjectChannel(legacyChannelKey, channelKey);
    }

    try {
      switch (subcommand) {
        case "":
        case "help":
          return okReply(buildHelpText());
        case "workspace":
          return await this.workspaceProject(channelKey, rest);
        case "use":
          return await this.useProject(channelKey, rest);
        case "proposal":
          return await this.proposalProject(channelKey, rest);
        case "worker":
          return await this.workerProject(channelKey, rest);
        case "attach":
          return await this.attachProject(channelKey);
        case "deattach":
        case "detach":
          return await this.detachProject(channelKey);
        case "continue":
          return await this.continueProject(channelKey);
        case "pause":
          return await this.pauseProject(channelKey);
        case "status":
          return await this.projectStatus(channelKey);
        case "archive":
          return await this.archiveProject(channelKey);
        case "cancel":
          return await this.cancelProject(channelKey);
        default:
          return errorReply(`Unknown subcommand \`${subcommand}\`.\n\n${buildHelpText()}`);
      }
    } catch (error) {
      this.logger.error(`[clawspec] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      return errorReply(error instanceof Error ? error.message : String(error));
    }
  }

  async handleBeforePromptBuild(
    event: PromptBuildEvent,
    ctx: PromptBuildContext,
  ): Promise<{ prependContext?: string; prependSystemContext?: string } | void> {
    if (!shouldHandleUserVisiblePrompt(ctx.trigger)) {
      this.logger.debug?.(
        `[clawspec] skipping prompt injection for non-user trigger "${ctx.trigger ?? "unknown"}".`,
      );
      return;
    }

    const keyword = extractEmbeddedClawSpecKeyword(event.prompt);
    if (keyword) {
      this.logger.debug?.(
        `[clawspec] detected control keyword "${keyword.command}" for prompt build (session=${ctx.sessionKey ?? "unknown"}).`,
      );
      const keywordResult = await this.handleKeywordPrompt(keyword, event, ctx);
      if (keywordResult) {
        return keywordResult;
      }
    }

    const promptProject = await this.resolveProjectForPromptContext(ctx);
    if (!promptProject) {
      return;
    }

    const boundProject = await this.bindProjectSession(promptProject.channelKey, promptProject.project, ctx.sessionKey);
    if (!isProjectContextAttached(boundProject)) {
      return;
    }
    if (shouldInjectProjectPrompt(boundProject, event.prompt)) {
      return await this.buildProjectDiscussionInjection(boundProject, event.prompt);
    }
    if (!shouldInjectPlanningPrompt(boundProject, event.prompt)) {
      return;
    }
    return await this.buildPlanningDiscussionInjection(boundProject, event.prompt);
  }

  private async handleKeywordPrompt(
    keyword: ClawSpecKeywordIntent,
    event: PromptBuildEvent,
    ctx: PromptBuildContext,
  ): Promise<{ prependContext?: string; prependSystemContext?: string } | void> {
    const match = await this.resolveControlProjectForPromptContext(ctx);

    switch (keyword.kind) {
      case "plan": {
        if (!match?.project.repoPath || !match.project.changeName) {
          return this.buildPluginReplyInjection(
            event.prompt,
            "Select a project and create a change first with `/clawspec use <project-name>` and `/clawspec proposal <change-name> [description]`.",
          );
        }
        const planningSync = await this.startVisiblePlanningSync(match.channelKey, match.project, ctx, event.prompt, "apply");
        if ("prependContext" in planningSync || "prependSystemContext" in planningSync) {
          return planningSync;
        }
        return this.buildPluginReplyInjection(event.prompt, planningSync.text ?? "");
      }
      case "work":
      case "continue": {
        if (!match?.project.repoPath || !match.project.changeName) {
          return this.buildPluginReplyInjection(
            event.prompt,
            "Select a project and create a change first with `/clawspec use <project-name>` and `/clawspec proposal <change-name> [description]`.",
          );
        }
        if (["archived", "cancelled"].includes(match.project.status)) {
          return this.buildPluginReplyInjection(
            event.prompt,
            `Change \`${match.project.changeName}\` is no longer active. Create a new proposal before starting implementation again.`,
          );
        }
        if (match.project.status === "planning" || match.project.execution?.action === "plan") {
          return this.buildPluginReplyInjection(
            event.prompt,
            `Planning sync for \`${match.project.changeName}\` is still running. Wait for it to finish before starting implementation.`,
          );
        }
        if (keyword.kind === "work" && requiresPlanningSync(match.project)) {
          return this.buildPluginReplyInjection(
            event.prompt,
            buildPlanningRequiredMessage(match.project),
          );
        }
        if (match.project.execution?.state === "running" || match.project.status === "running") {
          return this.buildPluginReplyInjection(
            event.prompt,
            `Background execution for \`${match.project.changeName}\` is already running.`,
          );
        }
        const result = keyword.kind === "continue"
          ? await this.continueProject(match.channelKey)
          : await this.queueWorkProject(match.channelKey, "apply");
        return this.buildPluginReplyInjection(event.prompt, result.text ?? "");
      }
      case "attach": {
        if (!match) {
          return this.buildPluginReplyInjection(event.prompt, "No active ClawSpec project is bound to this chat.");
        }
        const result = await this.attachProject(match.channelKey, ctx.sessionKey);
        return this.buildPluginReplyInjection(event.prompt, result.text ?? "");
      }
      case "detach": {
        if (!match) {
          return this.buildPluginReplyInjection(event.prompt, "No active ClawSpec project is bound to this chat.");
        }
        const result = await this.detachProject(match.channelKey);
        return this.buildPluginReplyInjection(event.prompt, result.text ?? "");
      }
      case "pause": {
        if (!match) {
          return this.buildPluginReplyInjection(event.prompt, "No active ClawSpec project is bound to this chat.");
        }
        const result = await this.pauseProject(match.channelKey);
        return this.buildPluginReplyInjection(event.prompt, result.text ?? "");
      }
      case "status": {
        if (!match) {
          return this.buildPluginReplyInjection(event.prompt, "No active ClawSpec project is bound to this chat.");
        }
        const result = await this.projectStatus(match.channelKey);
        return this.buildPluginReplyInjection(event.prompt, result.text ?? "");
      }
      case "cancel": {
        if (!match) {
          return this.buildPluginReplyInjection(event.prompt, "No active ClawSpec project is bound to this chat.");
        }
        const result = await this.cancelProject(match.channelKey);
        return this.buildPluginReplyInjection(event.prompt, result.text ?? "");
      }
    }
  }

  private async resolveProjectForPromptContext(ctx: PromptBuildContext): Promise<{
    channelKey: string;
    project: ProjectState;
  } | null> {
    return this.resolveProjectForPromptContextInternal(ctx, { allowDetached: false });
  }

  private async resolveProjectForPromptContextInternal(
    ctx: PromptBuildContext,
    options: { allowDetached: boolean },
  ): Promise<{
    channelKey: string;
    project: ProjectState;
  } | null> {
    if (ctx.sessionKey) {
      const projects = dedupeProjects(await this.stateStore.listActiveProjects());
      const bySession = projects.find((entry) =>
        entry.project.boundSessionKey === ctx.sessionKey
        || entry.project.execution?.sessionKey === ctx.sessionKey
      );
      if (bySession) {
        if (options.allowDetached || isProjectContextAttached(bySession.project)) {
          this.logger.debug?.(
            `[clawspec] prompt context matched by session: session=${ctx.sessionKey} channel=${bySession.channelKey} change=${bySession.project.changeName ?? "none"}.`,
          );
          return bySession;
        }
        this.logger.debug?.(
          `[clawspec] prompt context skipped because project context is detached: session=${ctx.sessionKey} channel=${bySession.channelKey} change=${bySession.project.changeName ?? "none"}.`,
        );
        return null;
      }
    }

    const routingContext = deriveRoutingContext(ctx);
    if (routingContext.channelId) {
      const match = await this.stateStore.findActiveProjectForMessage({
        channel: routingContext.channel,
        channelId: routingContext.channelId,
        accountId: routingContext.accountId,
        conversationId: routingContext.conversationId,
      });
      if (match) {
        if (options.allowDetached || isProjectContextAttached(match.project)) {
          this.logger.debug?.(
            `[clawspec] prompt context matched by channel: channelId=${routingContext.channelId} account=${routingContext.accountId ?? "default"} conversation=${routingContext.conversationId ?? "main"} mapped=${match.channelKey} change=${match.project.changeName ?? "none"}.`,
          );
          return match;
        }
        this.logger.debug?.(
          `[clawspec] prompt context skipped because project context is detached: channel=${routingContext.channel ?? "unknown"} channelId=${routingContext.channelId} account=${routingContext.accountId ?? "default"} conversation=${routingContext.conversationId ?? "main"} mapped=${match.channelKey} change=${match.project.changeName ?? "none"}.`,
        );
        return null;
      }
      const activeProjects = dedupeProjects(await this.stateStore.listActiveProjects());
      const attachedProjects = activeProjects.filter((entry) => isProjectContextAttached(entry.project));
      if (attachedProjects.length > 0) {
        this.logger.warn(
          `[clawspec] prompt context found no active project: channel=${routingContext.channel ?? "unknown"} channelId=${routingContext.channelId} account=${routingContext.accountId ?? "default"} conversation=${routingContext.conversationId ?? "main"} session=${ctx.sessionKey ?? "unknown"} active=${attachedProjects.map((entry) => entry.channelKey).join(", ")}.`,
        );
      } else {
        this.logger.debug?.(
          `[clawspec] prompt context found no active project: channelId=${routingContext.channelId} account=${routingContext.accountId ?? "default"} conversation=${routingContext.conversationId ?? "main"} session=${ctx.sessionKey ?? "unknown"}.`,
        );
      }
    }

    return null;
  }

  private async resolveControlProjectForPromptContext(ctx: PromptBuildContext): Promise<{
    channelKey: string;
    project: ProjectState;
  } | null> {
    const direct = await this.resolveProjectForPromptContextInternal(ctx, { allowDetached: true });
    if (direct) {
      return direct;
    }

    return null;
  }

  private async startVisibleExecution(
    project: ProjectState,
    ctx: PromptBuildContext,
    userPrompt: string,
    mode: ExecutionMode,
  ): Promise<{ prependContext?: string; prependSystemContext?: string }> {
    const repoStatePaths = getRepoStatePaths(project.repoPath!, this.archiveDirName);
    await this.ensureProjectSupportFiles(project);

    if (project.status === "planning") {
      return this.buildPluginReplyInjection(
        userPrompt,
        `Planning sync for \`${project.changeName}\` is still in progress. Wait for it to finish, then send \`cs-work\` again.`,
      );
    }

    if (requiresPlanningSync(project)) {
      await removeIfExists(repoStatePaths.executionControlFile);
      await this.stateStore.updateProject(project.channelKey, (current) => ({
        ...current,
        status: "ready",
        phase: current.phase,
        execution: undefined,
        latestSummary: buildPlanningRequiredMessage(current),
      }));
      return this.buildPluginReplyInjection(userPrompt, buildPlanningRequiredMessage(project));
    }

    const startedAt = new Date().toISOString();
    const runningProject = await this.stateStore.updateProject(project.channelKey, (current) => ({
      ...current,
      status: "running",
      phase: current.planningJournal?.dirty ? "planning_sync" : "implementing",
      latestSummary: `Visible execution started for ${current.changeName}.`,
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: undefined,
      boundSessionKey: ctx.sessionKey ?? current.boundSessionKey,
      execution: {
        mode,
        action: current.planningJournal?.dirty ? "plan" : "work",
        state: "running",
        armedAt: current.execution?.armedAt ?? startedAt,
        startedAt,
        sessionKey: ctx.sessionKey ?? current.execution?.sessionKey ?? current.boundSessionKey,
        triggerPrompt: userPrompt,
        lastTriggerAt: startedAt,
      },
    }));

    await writeJsonFile(repoStatePaths.executionControlFile, this.buildExecutionControl(runningProject));
    await removeIfExists(repoStatePaths.executionResultFile);

    const importedSkills = await loadClawSpecSkillBundle(["apply", "propose"]);
    return {
      prependSystemContext: buildExecutionSystemContext(runningProject.repoPath!, importedSkills),
      prependContext: buildExecutionPrependContext({
        project: runningProject,
        mode,
        userPrompt,
        repoStatePaths,
      }),
    };
  }

  private async buildPlanningDiscussionInjection(
    project: ProjectState,
    userPrompt: string,
  ): Promise<{ prependContext?: string; prependSystemContext?: string }> {
    const repoStatePaths = getRepoStatePaths(project.repoPath!, this.archiveDirName);
    await this.ensureProjectSupportFiles(project);
    const planningContext = {
      paths: [repoStatePaths.stateFile],
      scaffoldOnly: false,
    };
    const importedSkills = await loadClawSpecSkillBundle(["explore"]);
    return {
      prependSystemContext: buildPlanningSystemContext({
        repoPath: project.repoPath!,
        importedSkills,
        mode: "discussion",
      }),
      prependContext: buildPlanningPrependContext({
        project,
        userPrompt,
        repoStatePaths,
        contextPaths: planningContext.paths,
        scaffoldOnly: planningContext.scaffoldOnly,
        mode: "discussion",
        nextActionHint: requiresPlanningSync(project) ? "plan" : "work",
      }),
    };
  }

  private async buildProjectDiscussionInjection(
    project: ProjectState,
    userPrompt: string,
  ): Promise<{ prependContext?: string; prependSystemContext?: string }> {
    return {
      prependSystemContext: buildProjectSystemContext({
        repoPath: project.repoPath!,
      }),
      prependContext: buildProjectPrependContext({
        project,
        userPrompt,
      }),
    };
  }

  private async buildPlanningSyncInjection(
    project: ProjectState,
    userPrompt: string,
  ): Promise<{ prependContext?: string; prependSystemContext?: string }> {
    const repoStatePaths = getRepoStatePaths(project.repoPath!, this.archiveDirName);
    await this.ensureProjectSupportFiles(project);
    const planningContext = await this.collectPlanningContextPaths(project, repoStatePaths);
    const importedSkills = await loadClawSpecSkillBundle(["explore", "propose"]);
    return {
      prependSystemContext: buildPlanningSystemContext({
        repoPath: project.repoPath!,
        importedSkills,
        mode: "sync",
      }),
      prependContext: buildPlanningPrependContext({
        project,
        userPrompt,
        repoStatePaths,
        contextPaths: planningContext.paths,
        scaffoldOnly: planningContext.scaffoldOnly,
        mode: "sync",
      }),
    };
  }

  private async preparePlanningSync(channelKey: string): Promise<
    | { result: PluginCommandResult }
    | { project: ProjectState; outputs: OpenSpecCommandResult[]; repoStatePaths: RepoStatePaths }
  > {
    const project = await this.requireActiveProject(channelKey);
    if (!project.repoPath || !project.projectName || !project.changeName) {
      return {
        result: errorReply("Select a project and create a change first with `/clawspec use` and `/clawspec proposal`."),
      };
    }
    if (["archived", "cancelled"].includes(project.status)) {
      return {
        result: errorReply(`Change \`${project.changeName}\` is no longer active. Create a new proposal before running planning sync again.`),
      };
    }
    if (project.status === "planning" || project.execution?.action === "plan") {
      return {
        result: errorReply(`Planning sync for \`${project.changeName}\` is already running.`),
      };
    }
    if (hasBlockingExecution(project)) {
      return {
        result: errorReply(BLOCKING_EXECUTION_MSG),
      };
    }

    const outputs: OpenSpecCommandResult[] = [];
    const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
    const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);

    try {
      await this.ensureProjectSupportFiles(project);
      const hasUnsyncedChanges = await journalStore.hasUnsyncedChanges(
        project.changeName,
        repoStatePaths.planningJournalSnapshotFile,
        project.planningJournal?.lastSyncedAt,
      );
      if (!hasUnsyncedChanges) {
        const isDetached = !isProjectContextAttached(project);
        if (isDetached) {
          const snapshot = await journalStore.readSnapshot(repoStatePaths.planningJournalSnapshotFile);
          const digest = await journalStore.digest(project.changeName);
          const latestSummary = `No new planning notes were captured for ${project.changeName} because chat context is detached.`;
          await this.stateStore.updateProject(channelKey, (current) => ({
            ...current,
            planningJournal: {
              dirty: false,
              entryCount: digest.entryCount,
              lastEntryAt: digest.lastEntryAt,
              lastSyncedAt: snapshot?.syncedAt ?? current.planningJournal?.lastSyncedAt,
            },
            latestSummary,
          }));
          return {
            result: okReply(
              [
                heading("No New Planning Notes"),
                "",
                `Change: \`${project.changeName}\``,
                "This chat is currently detached from ClawSpec context, so ordinary requirement messages are not being written to the planning journal.",
                "Next step: run `cs-attach` or `/clawspec attach`, resend the requirement, then run `cs-plan` again.",
              ].join("\n"),
            ),
          };
        }

        await this.stateStore.updateProject(channelKey, (current) => ({
          ...current,
          latestSummary: `Manual planning review requested for ${project.changeName}.`,
        }));
      }
      const statusResult = await this.openSpec.status(project.repoPath, project.changeName);
      outputs.push(statusResult);
    } catch (error) {
      if (error instanceof OpenSpecCommandError) {
        return {
          result: errorReply(
            [
              heading("Planning Preparation Failed"),
              "",
              `Change: \`${project.changeName}\``,
              "",
              formatCommandOutputSection([error.result]),
            ].join("\n"),
          ),
        };
      }
      throw error;
    }

    await removeIfExists(repoStatePaths.executionControlFile);
    await removeIfExists(repoStatePaths.executionResultFile);
    await removeIfExists(repoStatePaths.workerProgressFile);
    return {
      project,
      outputs,
      repoStatePaths,
    };
  }

  private async startVisiblePlanningSync(
    channelKey: string,
    project: ProjectState,
    ctx: PromptBuildContext,
    userPrompt: string,
    mode: ExecutionMode,
  ): Promise<{ prependContext?: string; prependSystemContext?: string } | PluginCommandResult> {
    void project;
    void mode;

    const prepared = await this.preparePlanningSync(channelKey);
    if ("result" in prepared) {
      return prepared.result;
    }

    const startedAt = new Date().toISOString();
    const runningProject = await this.stateStore.updateProject(channelKey, (current) => ({
      ...current,
      status: "planning",
      phase: "planning_sync",
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: undefined,
      latestSummary: `Planning sync started for ${current.changeName} in the visible chat.`,
      boundSessionKey: ctx.sessionKey ?? current.boundSessionKey,
      execution: undefined,
      lastExecutionAt: startedAt,
    }));

    return await this.buildPlanningSyncInjection(runningProject, userPrompt);
  }

  private async collectPlanningContextPaths(
    project: ProjectState,
    repoStatePaths: RepoStatePaths,
  ): Promise<{ paths: string[]; scaffoldOnly: boolean }> {
    const paths = [
      repoStatePaths.stateFile,
      repoStatePaths.planningJournalFile,
    ];

    if (!project.changeDir) {
      return {
        paths,
        scaffoldOnly: true,
      };
    }

    const scaffoldPath = path.join(project.changeDir, ".openspec.yaml");
    if (await pathExists(scaffoldPath)) {
      paths.push(scaffoldPath);
    }

    const proposalPath = path.join(project.changeDir, "proposal.md");
    const designPath = path.join(project.changeDir, "design.md");
    const specsRoot = path.join(project.changeDir, "specs");
    const tasksPath = project.repoPath && project.changeName
      ? getTasksPath(project.repoPath, project.changeName)
      : undefined;

    let hasPlanningArtifacts = false;

    if (await pathExists(proposalPath)) {
      paths.push(proposalPath);
      hasPlanningArtifacts = true;
    }
    if (await pathExists(designPath)) {
      paths.push(designPath);
      hasPlanningArtifacts = true;
    }
    if (await directoryExists(specsRoot)) {
      paths.push(path.join(project.changeDir, "specs", "**", "*.md"));
      hasPlanningArtifacts = true;
    }
    if (tasksPath && await pathExists(tasksPath)) {
      paths.push(tasksPath);
      hasPlanningArtifacts = true;
    }

    return {
      paths,
      scaffoldOnly: !hasPlanningArtifacts,
    };
  }

  private buildPluginReplyInjection(
    userPrompt: string,
    resultText: string,
    followUp?: string,
  ): { prependContext?: string; prependSystemContext?: string } {
    return {
      prependSystemContext: buildPluginReplySystemContext(),
      prependContext: buildPluginReplyPrependContext({
        userPrompt,
        resultText,
        followUp,
      }),
    };
  }

  async handleAgentEnd(event: AgentEndEvent, ctx: PromptBuildContext): Promise<void> {
    const runningProject = await this.findRunningProjectBySessionKey(ctx.sessionKey);
    if (runningProject?.repoPath && runningProject.changeName) {
      const project = runningProject;
      const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
      const executionResult = await readExecutionResult(repoStatePaths.executionResultFile);
      const taskCounts = await this.loadTaskCounts(project);
      const fallbackSummary = executionResult
        ? undefined
        : await this.readMeaningfulExecutionSummary(repoStatePaths);

      if (executionResult) {
        await this.updateSupportFilesFromExecutionResult(project, executionResult);
      } else if (!fallbackSummary) {
        await this.writeLatestSummary(
          repoStatePaths,
          event.success
            ? "Execution turn ended without writing execution-result.json."
            : `Execution turn failed before writing execution-result.json: ${event.error ?? "unknown error"}`,
        );
      }

      await removeIfExists(repoStatePaths.executionControlFile);

      if (executionResult?.status === "cancelled" || (project.cancelRequested && !executionResult)) {
        await this.finalizeCancellation(project, executionResult);
        return;
      }

      const nextTaskCounts = executionResult?.taskCounts ?? taskCounts;
      const nextStatus = this.resolvePostRunStatus(project, executionResult, nextTaskCounts, event);
      const nextPhase = nextStatus === "done"
        ? "validating"
        : nextStatus === "blocked"
          ? "implementing"
          : nextStatus === "paused"
            ? "implementing"
            : "ready";
      const latestSummary = executionResult?.summary
        ?? fallbackSummary
        ?? (event.success ? "Visible execution ended without a structured result." : `Execution failed: ${event.error ?? "unknown error"}`);
      const blockedReason = executionResult?.status === "blocked"
        ? executionResult.blocker ?? executionResult.summary
        : nextStatus === "blocked"
          ? (fallbackSummary ?? (event.success ? "Visible execution ended without a structured result." : `Execution failed: ${event.error ?? "unknown error"}`))
          : undefined;

      await this.stateStore.updateProject(project.channelKey, (current) => ({
        ...current,
        status: nextStatus,
        phase: nextPhase,
        pauseRequested: false,
        cancelRequested: false,
        blockedReason,
        taskCounts: nextTaskCounts,
        latestSummary,
        execution: undefined,
        lastExecution: executionResult ?? current.lastExecution,
        lastExecutionAt: executionResult?.timestamp ?? new Date().toISOString(),
      }));
      return;
    }

    const planningProject = await this.findPlanningProjectBySessionKey(ctx.sessionKey);
    if (planningProject) {
      await this.finalizePlanningTurn(planningProject, event);
      return;
    }

    const discussionProject = await this.findDiscussionProjectBySessionKey(ctx.sessionKey);
    if (discussionProject) {
      await this.captureAssistantPlanningMessage(discussionProject, event);
    }
  }

  async recordPlanningMessage(channelKey: string, text: string): Promise<void> {
    const project = await this.stateStore.getActiveProject(channelKey);
    if (!project) {
      return;
    }
    await this.captureIncomingMessage(channelKey, project, text);
  }

  async recordPlanningMessageFromContext(params: {
    channel?: string;
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
    from?: string;
    metadata?: Record<string, unknown>;
  }, text: string): Promise<void> {
    const routingContext = deriveRoutingContext(params);
    if (!routingContext.channelId) {
      return;
    }
    if (this.shouldIgnoreInboundPlanningMessage(params, text)) {
      return;
    }
    const match = await this.stateStore.findActiveProjectForMessage({
      channel: routingContext.channel,
      channelId: routingContext.channelId,
      accountId: routingContext.accountId,
      conversationId: routingContext.conversationId,
    });
    if (!match) {
      const activeProjects = dedupeProjects(await this.stateStore.listActiveProjects());
      if (activeProjects.length > 0) {
        this.logger.warn(
          `[clawspec] planning message ignored because no active project matched: channel=${routingContext.channel ?? "unknown"} channelId=${routingContext.channelId} account=${routingContext.accountId ?? "default"} conversation=${routingContext.conversationId ?? "main"} session=${params.sessionKey ?? "unknown"} active=${activeProjects.map((entry) => entry.channelKey).join(", ")}.`,
        );
      } else {
        this.logger.debug?.(
          `[clawspec] planning message ignored because no active project matched: channelId=${routingContext.channelId} account=${routingContext.accountId ?? "default"} conversation=${routingContext.conversationId ?? "main"}.`,
        );
      }
      return;
    }
    if (!isProjectContextAttached(match.project)) {
      this.logger.debug?.(
        `[clawspec] planning message ignored because context is detached for channel=${match.channelKey} change=${match.project.changeName ?? "none"}.`,
      );
      return;
    }
    this.logger.debug?.(
      `[clawspec] planning message captured for channel=${match.channelKey} change=${match.project.changeName ?? "none"}.`,
    );
    await this.captureIncomingMessage(match.channelKey, match.project, text);
  }

  recordOutboundMessageFromContext(params: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
  }, text: string): void {
    const normalized = sanitizePlanningMessageText(text).trim();
    if (!params.channelId || !normalized) {
      return;
    }
    const scopeKey = this.buildMessageScopeKey(params);
    const now = Date.now();
    const entries = (this.recentOutboundMessages.get(scopeKey) ?? [])
      .filter((entry) => now - entry.timestamp < 120_000);
    entries.push({ text: normalized, timestamp: now });
    this.recentOutboundMessages.set(scopeKey, entries.slice(-20));
  }

  async startProject(channelKey: string): Promise<PluginCommandResult> {
    try {
      const workspacePath = await this.workspaceStore.getCurrentWorkspace(channelKey);
      const project = await this.ensureSessionProject(channelKey, workspacePath);
      return okReply(
        [
          heading("Project Started"),
          "",
          `Project id: \`${project.projectId}\``,
          `Current workspace: \`${project.workspacePath ?? workspacePath}\``,
          "Next step: `/clawspec use` to browse projects or `/clawspec use <project-name>` to select one.",
        ].join("\n"),
      );
    } catch (error) {
      if (error instanceof ActiveProjectConflictError) {
        return okReply(await this.renderStatus(error.project, "Project session already exists in this channel."));
      }
      throw error;
    }
  }

  async workspaceProject(channelKey: string, rawArgs: string): Promise<PluginCommandResult> {
    const currentWorkspace = await this.workspaceStore.getCurrentWorkspace(channelKey);
    const project = await this.ensureSessionProject(channelKey, currentWorkspace);
    const requested = rawArgs.trim();

    if (!requested) {
      return okReply(await this.buildWorkspaceText(project));
    }
    if (hasBlockingExecution(project)) {
      return errorReply(BLOCKING_EXECUTION_MSG);
    }

    const nextWorkspace = resolveUserPath(requested, project.workspacePath ?? this.defaultWorkspace);
    if (project.changeName && !isFinishedStatus(project.status) && project.repoPath) {
      return errorReply(
        `Current project \`${project.projectName ?? path.basename(project.repoPath)}\` still has an unfinished change \`${project.changeName}\`. Use \`/clawspec continue\`, \`/clawspec pause\`, or \`/clawspec cancel\` first.`,
      );
    }

    await this.workspaceStore.useWorkspace(nextWorkspace, channelKey);
    const updated = await this.stateStore.updateProject(channelKey, (current) => ({
      ...current,
      contextMode: "attached",
      workspacePath: nextWorkspace,
      repoPath: undefined,
      projectName: undefined,
      projectTitle: undefined,
      description: undefined,
      changeName: undefined,
      changeDir: undefined,
      openspecRoot: undefined,
      currentTask: undefined,
      taskCounts: undefined,
      latestSummary: `Switched workspace to ${nextWorkspace}.`,
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: undefined,
      execution: undefined,
      boundSessionKey: undefined,
      planningJournal: undefined,
      rollback: undefined,
      status: "idle",
      phase: "init",
    }));

    return okReply(await this.buildWorkspaceText(updated, "Workspace switched."));
  }

  async useProject(channelKey: string, rawArgs: string): Promise<PluginCommandResult> {
    const workspacePath = await this.workspaceStore.getCurrentWorkspace(channelKey);
    const project = await this.ensureSessionProject(channelKey, workspacePath);
    const input = rawArgs.trim();

    if (!input) {
      return okReply(await this.buildWorkspaceText(project));
    }
    if (hasBlockingExecution(project)) {
      return errorReply(BLOCKING_EXECUTION_MSG);
    }
    if (project.changeName && !isFinishedStatus(project.status) && project.repoPath) {
      return errorReply(
        `Project \`${project.projectName ?? path.basename(project.repoPath)}\` still has an unfinished change \`${project.changeName}\`. Use \`/clawspec continue\` or \`/clawspec cancel\` first.`,
      );
    }

    const repoPath = this.resolveWorkspaceProjectPath(project.workspacePath ?? workspacePath, input);
    const projectName = normalizeSlashes(path.relative(project.workspacePath ?? workspacePath, repoPath) || path.basename(repoPath));
    const projectExisted = await directoryExists(repoPath);
    if (!projectExisted) {
      await ensureDir(repoPath);
    }

    const outputs: OpenSpecCommandResult[] = [];
    if (!(await pathExists(path.join(repoPath, "openspec", "config.yaml")))) {
      try {
        const initResult = await this.openSpec.init(repoPath);
        outputs.push(initResult);
      } catch (error) {
        if (error instanceof OpenSpecCommandError) {
          return errorReply(
            [
              heading("Project Use Failed"),
              "",
              `Project: \`${projectName}\``,
              `Workspace: \`${project.workspacePath ?? workspacePath}\``,
              "",
              formatCommandOutputSection([error.result]),
            ].join("\n"),
          );
        }
        throw error;
      }
    }

    const repoStatePath = getRepoStatePaths(repoPath, this.archiveDirName).stateFile;
    const repoState = await readJsonFile<ProjectState | null>(repoStatePath, null);
    const resumedRepoState = Boolean(
      repoState
      && samePath(repoState.repoPath, repoPath)
      && repoState.changeName
      && !isFinishedStatus(repoState.status),
    );

    const updated = await this.stateStore.updateProject(channelKey, (current) => {
      const base = resumedRepoState && repoState
        ? {
            ...repoState,
            channelKey: current.channelKey,
            storagePath: current.storagePath,
          }
        : current;
      const sameRepo = samePath(base.repoPath, repoPath);
      return {
        ...base,
        contextMode: "attached",
        workspacePath: project.workspacePath ?? workspacePath,
        workerAgentId: base.workerAgentId ?? current.workerAgentId,
        repoPath,
        projectName,
        projectTitle: sameRepo ? base.projectTitle : projectName,
        openspecRoot: path.join(repoPath, "openspec"),
        changeName: sameRepo ? base.changeName : undefined,
        changeDir: sameRepo && base.changeName ? getChangeDir(repoPath, base.changeName) : undefined,
        description: sameRepo ? base.description : undefined,
        currentTask: sameRepo ? base.currentTask : undefined,
        taskCounts: sameRepo ? base.taskCounts : undefined,
        pauseRequested: false,
        cancelRequested: false,
        blockedReason: undefined,
        execution: sameRepo ? base.execution : undefined,
        planningJournal: sameRepo ? base.planningJournal : undefined,
        rollback: sameRepo ? base.rollback : undefined,
        latestSummary: resumedRepoState
          ? base.latestSummary ?? `Resumed active change ${base.changeName}.`
          : projectExisted
            ? `Using project ${projectName}.`
            : `Created project folder ${projectName}.`,
        status: sameRepo ? base.status : "idle",
        phase: sameRepo ? base.phase : "init",
      };
    });

    await this.ensureProjectSupportFiles(updated);

    return okReply(
      [
        heading("Project Selected"),
        "",
        `Workspace: \`${updated.workspacePath ?? workspacePath}\``,
        `Project: \`${projectName}\``,
        `Repo path: \`${repoPath}\``,
        resumedRepoState && updated.changeName
          ? `Action: resumed active change \`${updated.changeName}\` for this project.`
          : projectExisted
            ? "Action: reused existing project directory."
            : "Action: created new project directory.",
        outputs.length > 0 ? "OpenSpec init: completed." : "OpenSpec init: already present.",
        outputs.length > 0 ? "" : "",
        formatCommandOutputSection(outputs),
        outputs.length > 0 ? "" : "",
        resumedRepoState && updated.changeName
          ? `Next step: ${requiresPlanningSync(updated) ? "`cs-plan`" : "`cs-work`"}`
          : "Next step: `/clawspec proposal <change-name> [description]`",
      ].filter((line, index, array) => !(line === "" && array[index - 1] === "")).join("\n"),
    );
  }

  async proposalProject(channelKey: string, rawArgs: string): Promise<PluginCommandResult> {
    const workspacePath = await this.workspaceStore.getCurrentWorkspace(channelKey);
    const project = await this.ensureSessionProject(channelKey, workspacePath);
    if (!project.repoPath || !project.projectName) {
      return errorReply(SELECT_PROJECT_FIRST_MSG);
    }
    if (hasBlockingExecution(project)) {
      return errorReply(BLOCKING_EXECUTION_MSG);
    }
    if (project.changeName && !isFinishedStatus(project.status)) {
      return errorReply(buildProposalBlockedMessage(project, project.projectName));
    }
    const repoActive = await this.findUnfinishedProjectForRepo(project.repoPath, project.projectId);
    if (repoActive?.project.changeName) {
      return errorReply(buildProposalBlockedMessage(repoActive.project, project.projectName));
    }

    const tokens = tokenizeArgs(rawArgs);
    const changeName = tokens[0]?.trim();
    const description = tokens.slice(1).join(" ").trim();
    if (!changeName) {
      return errorReply("Usage: `/clawspec proposal <change-name> [description]`\n`change-name` must be kebab-case and cannot contain spaces.");
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeName)) {
      return errorReply(
        "`change-name` must use kebab-case and cannot contain spaces, for example `add-project-workspace`.\nIf you want to include a description, put it after the change name.",
      );
    }

    const changeDir = getChangeDir(project.repoPath, changeName);
    if (await pathExists(changeDir)) {
      return errorReply(
        `OpenSpec change \`${changeName}\` already exists in project \`${project.projectName}\`. Use \`/clawspec continue\` if this is the active change, otherwise choose a new change name.`,
      );
    }

    const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
    const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
    const rollbackStore = new RollbackStore(project.repoPath, this.archiveDirName, changeName);
    const outputs: OpenSpecCommandResult[] = [];

    try {
      await this.ensureProjectSupportFiles(project);
      await this.resetRunSupportFiles(repoStatePaths, `Change ${changeName} is ready for planning discussion.`);
      const manifest = await rollbackStore.initializeBaseline();
      await journalStore.clear();

      const newChangeResult = await this.openSpec.newChange(project.repoPath, changeName, description || undefined);
      outputs.push(newChangeResult);
      await journalStore.writeSnapshot(repoStatePaths.planningJournalSnapshotFile, changeName);

      try {
        const statusResult = await this.openSpec.status(project.repoPath, changeName);
        outputs.push(statusResult);
      } catch (error) {
        if (error instanceof OpenSpecCommandError) {
          outputs.push(error.result);
        } else {
          throw error;
        }
      }

      await this.stateStore.updateProject(channelKey, (current) => ({
        ...current,
        contextMode: "attached",
        projectTitle: description ? description : slugToTitle(changeName),
        description: description || undefined,
        changeName,
        changeDir,
        openspecRoot: path.join(project.repoPath!, "openspec"),
        currentTask: undefined,
        taskCounts: undefined,
        pauseRequested: false,
        cancelRequested: false,
        blockedReason: undefined,
        latestSummary: `Proposal scaffold is ready for ${changeName}.`,
        execution: undefined,
        lastExecution: undefined,
        boundSessionKey: current.boundSessionKey ?? project.boundSessionKey,
        planningJournal: {
          dirty: false,
          entryCount: 0,
          lastSyncedAt: new Date().toISOString(),
        },
        rollback: {
          baselineRoot: manifest.baselineRoot,
          manifestPath: rollbackStore.manifestPath,
          snapshotReady: true,
          touchedFileCount: 0,
          lastUpdatedAt: manifest.updatedAt,
        },
        status: "ready",
        phase: "proposal",
      }));

      return okReply(
        [
          heading("Proposal Ready"),
          "",
          `Project: \`${project.projectName}\``,
          `Change: \`${changeName}\``,
          `Repo path: \`${project.repoPath}\``,
          "",
          "OpenSpec scaffold created. Continue discussing the requirement in this chat.",
          "When the requirement is clear enough, say `cs-plan` to refresh proposal/design/tasks in this chat.",
          "`cs-work` becomes available only after planning sync finishes successfully.",
          "When planning is ready, use `cs-work` to start implementation. Use `/clawspec continue` later if you pause or get blocked.",
          "",
          formatCommandOutputSection(outputs),
        ].filter((line, index, array) => !(line === "" && array[index - 1] === "")).join("\n"),
      );
    } catch (error) {
      if (error instanceof OpenSpecCommandError) {
        return errorReply(
          [
            heading("Proposal Failed"),
            "",
            `Change: \`${changeName}\``,
            "",
            formatCommandOutputSection([error.result]),
          ].join("\n"),
        );
      }

      await rollbackStore.clear().catch(() => undefined);
      await journalStore.clear().catch(() => undefined);
      throw error;
    }
  }

  async detachProject(channelKey: string): Promise<PluginCommandResult> {
    const project = await this.requireActiveProject(channelKey);
    if (!project.repoPath || !project.projectName) {
      return errorReply(SELECT_PROJECT_FIRST_MSG);
    }
    if (!isProjectContextAttached(project)) {
      return okReply(
        [
          heading("Context Detached"),
          "",
          `Project: \`${project.projectName}\``,
          `Change: ${project.changeName ? `\`${project.changeName}\`` : "_none_"}`,
          "Normal chat is already detached from ClawSpec context in this channel.",
          "Use `cs-attach` or `/clawspec attach` when you want ordinary chat to re-enter project mode.",
        ].join("\n"),
      );
    }

    const updated = await this.stateStore.updateProject(channelKey, (current) => ({
      ...current,
      contextMode: "detached",
    }));

    return okReply(
      [
        heading("Context Detached"),
        "",
        `Project: \`${updated.projectName ?? project.projectName}\``,
        `Change: ${updated.changeName ? `\`${updated.changeName}\`` : "_none_"}`,
        "Normal chat is now detached from ClawSpec context in this channel.",
        "Background implementation can keep running, and watcher updates will still appear here.",
        "Use `cs-attach` or `/clawspec attach` to reattach this chat to the active project context.",
      ].join("\n"),
    );
  }

  async attachProject(channelKey: string, sessionKey?: string): Promise<PluginCommandResult> {
    const project = await this.requireActiveProject(channelKey);
    if (!project.repoPath || !project.projectName) {
      return errorReply(SELECT_PROJECT_FIRST_MSG);
    }
    if (isProjectContextAttached(project)) {
      return okReply(
        [
          heading("Context Attached"),
          "",
          `Project: \`${project.projectName}\``,
          `Change: ${project.changeName ? `\`${project.changeName}\`` : "_none_"}`,
          "This chat is already attached to the active ClawSpec project context.",
        ].join("\n"),
      );
    }

    const updated = await this.stateStore.updateProject(channelKey, (current) => ({
      ...current,
      contextMode: "attached",
      boundSessionKey: sessionKey ?? current.boundSessionKey,
    }));

    const nextStep = updated.changeName
      ? requiresPlanningSync(updated)
        ? "Next: keep describing requirements or run `cs-plan`."
        : "Next: continue the project discussion here or run `cs-work`."
      : "Next: run `/clawspec proposal <change-name> [description]` when you want to start a structured change.";

    return okReply(
      [
        heading("Context Attached"),
        "",
        `Project: \`${updated.projectName ?? project.projectName}\``,
        `Change: ${updated.changeName ? `\`${updated.changeName}\`` : "_none_"}`,
        "Ordinary chat in this channel is attached to the active ClawSpec context again.",
        nextStep,
      ].join("\n"),
    );
  }

  async workerProject(channelKey: string, rawArgs: string): Promise<PluginCommandResult> {
    const workspacePath = await this.workspaceStore.getCurrentWorkspace(channelKey);
    const project = await this.ensureSessionProject(channelKey, workspacePath);
    const requestedAgent = rawArgs.trim();
    const availableAgents = this.listAvailableWorkerAgents();
    const currentAgent = project.workerAgentId ?? this.getDefaultWorkerAgentId();
    const defaultAgent = this.getDefaultWorkerAgentId();

    if (requestedAgent.toLowerCase() === "status") {
      return okReply(await this.buildWorkerStatusText(project, availableAgents));
    }

    if (!requestedAgent) {
      const lines = [
        heading("Worker Agent"),
        "",
        `Current worker agent: ${formatWorkerAgent(currentAgent)}`,
        `Default worker agent: ${formatWorkerAgent(defaultAgent)}`,
        availableAgents.length > 0 ? `Available agents: ${availableAgents.map((agentId) => `\`${agentId}\``).join(", ")}` : "",
        !defaultAgent && !project.workerAgentId
          ? `OpenClaw ACP default is missing. ${buildWorkerAgentSetupHint("work")}`
          : "",
        "",
        "Use `/clawspec worker <agent-id>` to change the ACP worker agent for this channel/project context.",
      ].filter(Boolean);
      return okReply(lines.join("\n"));
    }

    if (hasBlockingExecution(project) || project.status === "planning") {
      return errorReply(BLOCKING_EXECUTION_MSG);
    }

    if (availableAgents.length > 0 && !availableAgents.includes(requestedAgent)) {
      return errorReply(
        `Unknown worker agent \`${requestedAgent}\`. Available agents: ${availableAgents.map((agentId) => `\`${agentId}\``).join(", ")}`,
      );
    }

    const updated = await this.stateStore.updateProject(channelKey, (current) => ({
      ...current,
      workerAgentId: requestedAgent,
      latestSummary: `Worker agent set to ${requestedAgent}.`,
    }));

    return okReply(
      [
        heading("Worker Agent Updated"),
        "",
        `Worker agent: ${formatWorkerAgent(updated.workerAgentId)}`,
        "Future background implementation turns will use this ACP agent.",
      ].join("\n"),
    );
  }

  async queuePlanningProject(channelKey: string, mode: ExecutionMode): Promise<PluginCommandResult> {
    void mode;
    const prepared = await this.preparePlanningSync(channelKey);
    if ("result" in prepared) {
      return prepared.result;
    }

    const updated = await this.stateStore.updateProject(channelKey, (current) => ({
      ...current,
      status: "ready",
      phase: current.phase === "planning_sync" ? "proposal" : current.phase,
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: undefined,
      latestSummary: `Planning is ready to run for ${current.changeName}. Waiting for cs-plan in chat.`,
      execution: undefined,
    }));

    return okReply(
      [
        heading("Planning Ready"),
        "",
        `Change: \`${updated.changeName}\``,
        "Planning now runs in the visible chat instead of the background worker.",
        "Next step: say `cs-plan` in this chat to refresh proposal/design/tasks.",
        "",
        formatCommandOutputSection(prepared.outputs),
      ].filter((line, index, array) => !(line === "" && array[index - 1] === "")).join("\n"),
    );
  }

  async queueWorkProject(channelKey: string, mode: ExecutionMode): Promise<PluginCommandResult> {
    const project = await this.requireActiveProject(channelKey);
    if (!project.repoPath || !project.projectName || !project.changeName) {
      return errorReply("Select a project and create a change first with `/clawspec use` and `/clawspec proposal`.");
    }
    if (!this.watcherManager) {
      return errorReply("ClawSpec watcher manager is not available.");
    }
    if (project.status === "planning" || project.execution?.action === "plan") {
      return errorReply(`Planning sync for \`${project.changeName}\` is still running. Wait for it to finish before starting implementation.`);
    }
    if (hasBlockingExecution(project)) {
      return errorReply(BLOCKING_EXECUTION_MSG);
    }
    const workerConfig = this.validateWorkerAgentConfiguration(project, "work");
    if (!workerConfig.ok) {
      return workerConfig.result;
    }

    const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
    const outputs: OpenSpecCommandResult[] = [];
    let statusResult: OpenSpecCommandResult<OpenSpecStatusResponse>;
    let applyResult: OpenSpecCommandResult<OpenSpecApplyInstructionsResponse>;

    try {
      await this.ensureProjectSupportFiles(project);
      statusResult = await this.openSpec.status(project.repoPath, project.changeName);
      applyResult = await this.openSpec.instructionsApply(project.repoPath, project.changeName);
      outputs.push(statusResult, applyResult);
    } catch (error) {
      if (error instanceof OpenSpecCommandError) {
        return errorReply(
          [
            heading("Execution Preparation Failed"),
            "",
            `Change: \`${project.changeName}\``,
            "",
            formatCommandOutputSection([error.result]),
          ].join("\n"),
        );
      }
      throw error;
    }

    const apply = applyResult.parsed!;
    const taskCounts = apply.progress;
    if (apply.state === "all_done") {
      await this.stateStore.updateProject(channelKey, (current) => ({
        ...current,
        status: "done",
        phase: "validating",
        taskCounts,
        latestSummary: `All tasks for ${current.changeName} are already complete.`,
        execution: undefined,
      }));
      return okReply(
        [
          heading("Implementation Complete"),
          "",
          `Change: \`${project.changeName}\``,
          `Schema: \`${statusResult.parsed?.schemaName ?? apply.schemaName}\``,
          `Progress: ${taskCounts.complete}/${taskCounts.total} tasks complete`,
          "",
          "All tasks are already complete. You can archive this change with `/clawspec archive`.",
          "",
          formatCommandOutputSection(outputs),
        ].join("\n"),
      );
    }

    if (requiresPlanningSync(project) || apply.state === "blocked") {
      return errorReply(
        [
          heading("Planning Sync Required"),
          "",
          `Change: \`${project.changeName}\``,
          requiresPlanningSync(project)
            ? buildPlanningRequiredMessage(project)
            : buildPlanningBlockedMessage(project),
          "",
          formatCommandOutputSection(outputs),
        ].filter((line, index, array) => !(line === "" && array[index - 1] === "")).join("\n"),
      );
    }

    const armedAt = new Date().toISOString();
    const workerAgentId = workerConfig.agentId;

    await removeIfExists(repoStatePaths.executionResultFile);
    const remainingTasks = apply.tasks.filter((task) => !task.done);
    const nextTask = remainingTasks[0];
    const nextProject = await this.stateStore.updateProject(channelKey, (current) => ({
      ...current,
      status: "armed",
      phase: "implementing",
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: undefined,
      taskCounts,
      currentTask: nextTask ? `${nextTask.id} ${nextTask.description}` : undefined,
      latestSummary: `Execution queued for ${current.changeName}.`,
      lastNotificationKey: undefined,
      lastNotificationText: undefined,
      execution: {
        mode,
        action: "work",
        state: "armed",
        workerAgentId,
        workerSlot: "primary",
        armedAt,
        sessionKey: createWorkerSessionKey(current, {
          workerSlot: "primary",
          workerAgentId,
          attemptKey: armedAt,
        }),
      },
    }));
    await this.writeExecutionControl(nextProject);
    await this.watcherManager.wake(channelKey);

    const remainingOverview = remainingTasks.slice(0, 5).map((task) => `- [ ] ${task.id} ${task.description}`);
    return okReply(
      [
        heading("Execution Queued"),
        "",
        `Change: \`${nextProject.changeName}\``,
        `Schema: \`${statusResult.parsed?.schemaName ?? apply.schemaName}\``,
        `Mode: \`${mode}\``,
        `Progress: ${taskCounts.complete}/${taskCounts.total} tasks complete`,
        `Planning journal: ${nextProject.planningJournal?.dirty ? "dirty" : "clean"}`,
        "Background implementation started. You will receive short progress updates here.",
        remainingOverview.length > 0 ? "" : "",
        remainingOverview.length > 0 ? "Remaining tasks overview:" : "",
        ...remainingOverview,
        "",
        "Next step: wait for progress updates or use `/clawspec pause` if you need to stop after the current safe boundary.",
        "",
        formatCommandOutputSection(outputs),
      ].filter((line, index, array) => !(line === "" && array[index - 1] === "")).join("\n"),
    );
  }

  async continueProject(channelKey: string): Promise<PluginCommandResult> {
    const project = await this.requireActiveProject(channelKey);
    if (!project.changeName || !project.repoPath) {
      return errorReply("No active change to continue.");
    }

    if (
      project.phase === "planning_sync"
      || project.phase === "proposal"
      || project.status === "planning"
      || requiresPlanningSync(project)
    ) {
      return await this.queuePlanningProject(channelKey, "continue");
    }

    return await this.queueWorkProject(channelKey, "continue");
  }

  async armExecutionProject(channelKey: string, mode: ExecutionMode): Promise<PluginCommandResult> {
    return mode === "apply"
      ? await this.queueWorkProject(channelKey, mode)
      : await this.continueProject(channelKey);
  }

  async pauseProject(channelKey: string): Promise<PluginCommandResult> {
    const project = await this.requireActiveProject(channelKey);
    if (!project.changeName || !project.repoPath) {
      return errorReply("No active change to pause.");
    }
    if (!this.watcherManager) {
      return errorReply("ClawSpec watcher manager is not available.");
    }

    const hasBackgroundExecution = project.execution?.state === "armed"
      || project.execution?.state === "running"
      || project.status === "running"
      || (project.status === "planning" && project.execution?.action === "plan");

    if (hasBackgroundExecution) {
      const updated = await this.stateStore.updateProject(channelKey, (current) => ({
        ...current,
        pauseRequested: true,
        cancelRequested: false,
        latestSummary: `Pause requested for ${current.changeName}.`,
      }));
      await this.writeExecutionControl(updated);
      if (updated.execution?.state === "running") {
        await this.watcherManager.interrupt(channelKey, "paused by user");
      }
      await this.watcherManager.wake(channelKey);
      return okReply(
        [
          heading("Pause Requested"),
          "",
          `Change: \`${project.changeName}\``,
          "Background execution will pause at the next safe boundary.",
        ].join("\n"),
      );
    }

    if (project.status === "paused") {
      return okReply("Execution is already paused.");
    }

    return errorReply("No armed or active background execution is available to pause.");
  }

  async projectStatus(channelKey: string): Promise<PluginCommandResult> {
    let project = await this.requireActiveProject(channelKey);
    const outputs: OpenSpecCommandResult[] = [];
    let applyResult: OpenSpecApplyInstructionsResponse | undefined;

    if (project.repoPath && project.changeName) {
      const recoveredSummary = await this.readMeaningfulExecutionSummary(
        getRepoStatePaths(project.repoPath, this.archiveDirName),
      );
      if (
        recoveredSummary
        && (!isMeaningfulExecutionSummary(project.latestSummary) || (project.status === "blocked" && !project.blockedReason))
      ) {
        project = await this.stateStore.updateProject(channelKey, (current) => ({
          ...current,
          blockedReason: current.status === "blocked"
            ? (current.blockedReason ?? recoveredSummary)
            : current.blockedReason,
          latestSummary: recoveredSummary,
        }));
      }

      try {
        const statusResult = await this.openSpec.status(project.repoPath, project.changeName);
        outputs.push(statusResult);
      } catch (error) {
        if (error instanceof OpenSpecCommandError) {
          outputs.push(error.result);
        } else {
          throw error;
        }
      }

      try {
        const applyInstructions = await this.openSpec.instructionsApply(project.repoPath, project.changeName);
        outputs.push(applyInstructions);
        applyResult = applyInstructions.parsed;
        project = await this.reconcileProjectFromApplyInstructions(channelKey, project, applyInstructions.parsed);
      } catch (error) {
        if (error instanceof OpenSpecCommandError) {
          outputs.push(error.result);
        } else {
          throw error;
        }
      }
    }

    return okReply(await this.renderStatus(project, undefined, outputs, applyResult));
  }

  async archiveProject(channelKey: string): Promise<PluginCommandResult> {
    const project = await this.requireActiveProject(channelKey);
    if (!project.repoPath || !project.projectName || !project.changeName) {
      return errorReply("No active change to archive.");
    }
    if (hasBlockingExecution(project)) {
      return errorReply(BLOCKING_EXECUTION_MSG);
    }

    const taskCounts = await this.loadTaskCounts(project);
    if ((taskCounts?.remaining ?? 1) > 0) {
      return errorReply("Not all tasks are complete yet. Finish implementation or use `/clawspec status` to inspect progress.");
    }

    const outputs: OpenSpecCommandResult[] = [];
    try {
      const validateResult = await this.openSpec.validate(project.repoPath, project.changeName);
      outputs.push(validateResult);
      const archivePath = await this.writeArchiveBundle(project, taskCounts!);
      const archiveResult = await this.openSpec.archive(project.repoPath, project.changeName);
      outputs.push(archiveResult);

      const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
      const rollbackStore = new RollbackStore(project.repoPath, this.archiveDirName, project.changeName);
      await rollbackStore.clear();
      await this.clearChangeRuntimeFiles(repoStatePaths);
      await this.resetRunSupportFiles(repoStatePaths, `Archived change ${project.changeName}.`);

      await this.stateStore.updateProject(channelKey, (current) => ({
        ...current,
        status: "archived",
        phase: "archiving",
        changeName: undefined,
        changeDir: undefined,
        description: undefined,
        currentTask: undefined,
        taskCounts: undefined,
        pauseRequested: false,
        cancelRequested: false,
        blockedReason: undefined,
        latestSummary: `Archived change ${project.changeName}.`,
        execution: undefined,
        planningJournal: {
          dirty: false,
          entryCount: 0,
        },
        rollback: undefined,
        archivePath,
      }));

      return okReply(
        [
          heading("Archive Complete"),
          "",
          `Project: \`${project.projectName}\``,
          `Archive bundle: \`${archivePath}\``,
          "",
          formatCommandOutputSection(outputs),
        ].filter((line, index, array) => !(line === "" && array[index - 1] === "")).join("\n"),
      );
    } catch (error) {
      if (error instanceof OpenSpecCommandError) {
        return errorReply(
          [
            heading("Archive Failed"),
            "",
            `Change: \`${project.changeName}\``,
            "",
            formatCommandOutputSection([error.result]),
          ].join("\n"),
        );
      }
      throw error;
    }
  }

  async cancelProject(channelKey: string): Promise<PluginCommandResult> {
    const project = await this.requireActiveProject(channelKey);
    if (!project.repoPath || !project.projectName || !project.changeName) {
      return errorReply("No active change to cancel.");
    }

    const hasBackgroundExecution = project.execution?.state === "armed"
      || project.execution?.state === "running"
      || project.status === "running"
      || (project.status === "planning" && project.execution?.action === "plan");

    if (this.watcherManager && hasBackgroundExecution) {
      const updated = await this.stateStore.updateProject(channelKey, (current) => ({
        ...current,
        cancelRequested: true,
        pauseRequested: false,
        latestSummary: `Cancellation requested for ${current.changeName}.`,
      }));
      await this.writeExecutionControl(updated);
      if (updated.execution?.state === "running") {
        await this.watcherManager.interrupt(channelKey, "cancelled by user");
      }
      await this.watcherManager.wake(channelKey);
      return okReply(
        [
          heading("Cancellation Requested"),
          "",
          `Change: \`${project.changeName}\``,
          "Background execution will stop at the next safe boundary, then cleanup will run.",
        ].join("\n"),
      );
    }

    await this.finalizeCancellation(project);
    return okReply(
      [
        heading("Change Cancelled"),
        "",
        `Project: \`${project.projectName}\``,
        "Rollback restored tracked files, removed the change directory, and cleared change-scoped runtime files.",
      ].join("\n"),
    );
  }

  private async captureIncomingMessage(channelKey: string, project: ProjectState, text: string): Promise<ProjectState> {
    const trimmed = sanitizePlanningMessageText(text).trim();
    if (!trimmed || trimmed.startsWith("/clawspec") || !project.repoPath || !project.changeName) {
      return project;
    }
    if (!isProjectContextAttached(project)) {
      return project;
    }
    if (parseClawSpecKeyword(trimmed)) {
      return project;
    }

    const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
    const timestamp = new Date().toISOString();
    const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
    const shouldAppendJournal = !isExecutionTriggerText(trimmed);

    await this.stateStore.updateProject(channelKey, (current) => {
      if (current.execution?.state !== "armed") {
        return current;
      }
      return {
        ...current,
        execution: {
          ...current.execution,
          triggerPrompt: trimmed,
          lastTriggerAt: timestamp,
        },
      };
    });

    if (!shouldAppendJournal || !shouldCapturePlanningMessage(project)) {
      return project;
    }

    await this.ensureProjectSupportFiles(project);
    const existingEntries = await journalStore.list(project.changeName);
    const lastEntry = existingEntries[existingEntries.length - 1];
    if (lastEntry?.role === "user" && lastEntry.text === trimmed) {
      return project;
    }

    await journalStore.append({
      timestamp,
      changeName: project.changeName,
      role: "user",
      text: trimmed,
    });

    return await this.stateStore.updateProject(channelKey, (current) => ({
      ...current,
      planningJournal: {
        dirty: true,
        entryCount: (current.planningJournal?.entryCount ?? 0) + 1,
        lastEntryAt: timestamp,
        lastSyncedAt: current.planningJournal?.lastSyncedAt,
      },
    }));
  }

  private shouldIgnoreInboundPlanningMessage(params: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    metadata?: Record<string, unknown>;
  }, text: string): boolean {
    const normalized = sanitizePlanningMessageText(text).trim();
    if (!normalized || !params.channelId) {
      return true;
    }

    const metadata = params.metadata;
    const selfFlags = [
      metadata?.fromSelf,
      metadata?.isSelf,
      metadata?.self,
      metadata?.isBot,
      metadata?.fromBot,
      metadata?.bot,
    ];
    if (selfFlags.some((value) => value === true)) {
      return true;
    }

    const scopeKey = this.buildMessageScopeKey(params);
    const now = Date.now();
    const entries = (this.recentOutboundMessages.get(scopeKey) ?? [])
      .filter((entry) => now - entry.timestamp < 120_000);
    if (entries.length === 0) {
      return false;
    }
    this.recentOutboundMessages.set(scopeKey, entries);
    return entries.some((entry) => entry.text === normalized);
  }

  private buildMessageScopeKey(params: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
  }): string {
    return [
      params.channelId ?? "",
      params.accountId ?? "default",
      params.conversationId ?? "main",
    ].join(":");
  }

  private async ensureSessionProject(channelKey: string, workspacePath: string): Promise<ProjectState> {
    const existing = await this.stateStore.getActiveProject(channelKey);
    if (existing) {
      if (existing.workspacePath) {
        return existing;
      }
      return await this.stateStore.updateProject(channelKey, (current) => ({
        ...current,
        contextMode: current.contextMode ?? "attached",
        workspacePath: current.workspacePath ?? workspacePath,
        status: current.status || "idle",
        phase: current.phase || "init",
      }));
    }

    const created = await this.stateStore.createProject(channelKey);
    return await this.stateStore.updateProject(channelKey, (current) => ({
      ...created,
      ...current,
      contextMode: current.contextMode ?? "attached",
      workspacePath,
      status: "idle",
      phase: "init",
    }));
  }

  private listAvailableWorkerAgents(): string[] {
    const configured = listConfiguredWorkerAgents(this.config);
    if (configured.length > 0) {
      return configured;
    }
    return this.defaultWorkerAgentId ? [this.defaultWorkerAgentId] : [];
  }

  private async buildWorkerStatusText(project: ProjectState, availableAgents: string[]): Promise<string> {
    const configuredAgent = this.getEffectiveWorkerAgentId(project);
    const defaultAgent = this.getDefaultWorkerAgentId();
    const execution = project.execution;
    const taskCounts = project.taskCounts;
    const runtimeStatus = this.watcherManager?.getWorkerRuntimeStatus
      ? await this.watcherManager.getWorkerRuntimeStatus(project)
      : undefined;
    const transportMode = describeWorkerTransportMode(project);
    const runtimeState = describeWorkerRuntimeState(project, runtimeStatus);
    const startupWait = describeExecutionStartupWait(execution);
    const runtimePid = typeof runtimeStatus?.details?.pid === "number" && Number.isFinite(runtimeStatus.details.pid)
      ? runtimeStatus.details.pid
      : undefined;
    const nextAction = execution?.action === "plan"
      ? "Planning is active. Let the current chat turn finish."
      : execution?.action === "work"
        ? "Wait for worker updates or use `/clawspec pause`."
        : !isProjectContextAttached(project)
          ? "Use `/clawspec attach` or `cs-attach` when you want ordinary chat to re-enter project mode."
        : project.status === "ready" && project.phase === "proposal"
          ? "Keep describing requirements, then run `cs-plan`."
          : project.status === "ready" && project.phase === "tasks"
            ? "Run `cs-work` when you want implementation to start."
            : project.status === "blocked"
              ? "Review the blocker, then use `cs-plan`, `cs-work`, or `/clawspec continue` as appropriate."
              : project.status === "paused"
                ? "Run `/clawspec continue` when you are ready to resume."
                : "Idle.";
    const lines = [
      heading("Worker Status"),
      "",
      `Project: \`${project.projectName ?? "none"}\``,
      `Change: \`${project.changeName ?? "none"}\``,
      `Context: \`${isProjectContextAttached(project) ? "attached" : "detached"}\``,
      `Phase: \`${project.phase}\``,
      `Lifecycle: \`${project.status}\``,
      `Configured worker agent: ${formatWorkerAgent(configuredAgent)}`,
      `Default worker agent: ${formatWorkerAgent(defaultAgent)}`,
      availableAgents.length > 0 ? `Available agents: ${availableAgents.map((agentId) => `\`${agentId}\``).join(", ")}` : "",
      !configuredAgent ? `Worker setup: ${buildWorkerAgentSetupHint("work")}` : "",
      `Execution state: \`${execution?.state ?? "idle"}\``,
      `Worker transport: \`${transportMode}\``,
      `Action: \`${execution?.action ?? "none"}\``,
      `Worker slot: \`${execution?.workerSlot ?? "primary"}\``,
      execution?.workerAgentId ? `Running agent: \`${execution.workerAgentId}\`` : "",
      execution?.startupPhase ? `Startup phase: \`${execution.startupPhase}\`` : "",
      execution?.connectedAt ? `Connected at: \`${execution.connectedAt}\`` : "",
      execution?.firstProgressAt ? `First visible progress: \`${execution.firstProgressAt}\`` : "",
      startupWait ? `Startup wait: \`${startupWait}\`` : "",
      execution?.currentArtifact ? `Current artifact: \`${execution.currentArtifact}\`` : "",
      execution?.currentTaskId ? `Current task: \`${execution.currentTaskId}\`` : "",
      taskCounts ? `Progress: ${taskCounts.complete}/${taskCounts.total} complete, ${taskCounts.remaining} remaining` : "",
      execution?.sessionKey ? `Session: \`${execution.sessionKey}\`` : "",
      `Runtime status: \`${runtimeState}\``,
      runtimePid != null ? `Runtime pid: \`${runtimePid}\`` : "",
      runtimeStatus?.summary ? `Runtime summary: ${runtimeStatus.summary}` : "",
      execution?.lastHeartbeatAt ? `Last heartbeat: \`${execution.lastHeartbeatAt}\`` : "",
      execution?.restartCount ? `Restart attempts: \`${execution.restartCount}\`` : "",
      execution?.progressOffset != null ? `Progress offset: \`${execution.progressOffset}\`` : "",
      execution?.lastFailure ? `Last worker failure: ${execution.lastFailure}` : "",
      project.latestSummary ? `Latest summary: ${project.latestSummary}` : "",
      `Next: ${nextAction}`,
    ];
    return lines.filter(Boolean).join("\n");
  }

  private async findUnfinishedProjectForRepo(
    repoPath: string,
    excludeProjectId?: string,
  ): Promise<{ channelKey: string; project: ProjectState } | null> {
    const projects = dedupeProjects(await this.stateStore.listActiveProjects());
    return projects.find((entry) =>
      samePath(entry.project.repoPath, repoPath)
      && !isFinishedStatus(entry.project.status)
      && entry.project.projectId !== excludeProjectId
    ) ?? null;
  }

  private async requireActiveProject(channelKey: string): Promise<ProjectState> {
    const project = await this.stateStore.getActiveProject(channelKey);
    if (!project) {
      throw new Error("No active project in this channel. Start one with `/clawspec workspace` and `/clawspec use`.");
    }
    return project;
  }

  private async resolveArmedProjectForPrompt(prompt: string, sessionKey?: string): Promise<ProjectState | undefined> {
    const projects = dedupeProjects(await this.stateStore.listActiveProjects()).map((entry) => entry.project);
    const promptCandidates = collectPromptCandidates(prompt);

    const bySession = projects.find((project) =>
      project.execution?.state === "armed"
      && sessionKey
      && matchesExecutionSession(project, sessionKey)
    );
    if (bySession) {
      return bySession;
    }

    const promptMatches = projects
      .filter((project) =>
        project.execution?.state === "armed"
        && promptCandidates.some((candidate) => project.execution?.triggerPrompt === candidate)
      )
      .sort((left, right) => (right.execution?.lastTriggerAt ?? "").localeCompare(left.execution?.lastTriggerAt ?? ""));
    if (promptMatches.length > 0) {
      if (promptMatches.length > 1) {
        this.logger.warn(`[clawspec] multiple armed projects matched trigger prompt "${prompt}", using the most recent match.`);
      }
      return promptMatches[0];
    }

    const allArmed = projects.filter((project) => project.execution?.state === "armed");
    return allArmed.length === 1 ? allArmed[0] : undefined;
  }

  private async findRunningProjectBySessionKey(sessionKey?: string): Promise<ProjectState | undefined> {
    if (!sessionKey) {
      return undefined;
    }
    const projects = await this.stateStore.listActiveProjects();
    return projects.find((project) =>
      project.execution?.state === "running"
      && matchesExecutionSession(project, sessionKey)
    );
  }

  private async findPlanningProjectBySessionKey(sessionKey?: string): Promise<ProjectState | undefined> {
    if (!sessionKey) {
      return undefined;
    }
    const projects = dedupeProjects(await this.stateStore.listActiveProjects()).map((entry) => entry.project);
    return projects.find((project) =>
      project.status === "planning"
      && project.phase === "planning_sync"
      && project.boundSessionKey === sessionKey
    );
  }

  private async findDiscussionProjectBySessionKey(sessionKey?: string): Promise<ProjectState | undefined> {
    if (!sessionKey) {
      return undefined;
    }
    const projects = dedupeProjects(await this.stateStore.listActiveProjects()).map((entry) => entry.project);
    return projects.find((project) =>
      project.boundSessionKey === sessionKey
      && Boolean(project.repoPath)
      && Boolean(project.changeName)
      && isProjectContextAttached(project)
      && !hasBlockingExecution(project)
      && project.status !== "planning"
      && !isFinishedStatus(project.status)
    );
  }

  private async captureAssistantPlanningMessage(project: ProjectState, event: AgentEndEvent): Promise<void> {
    if (!project.repoPath || !project.changeName || !event.success) {
      return;
    }

    const latestUserText = sanitizePlanningMessageText(extractLatestMessageTextByRole(event.messages, "user") ?? "").trim();
    if (
      !latestUserText
      || latestUserText.startsWith("/clawspec")
      || Boolean(parseClawSpecKeyword(latestUserText))
      || isExecutionTriggerText(latestUserText)
    ) {
      return;
    }

    const latestAssistantText = sanitizePlanningMessageText(extractLatestMessageTextByRole(event.messages, "assistant") ?? "").trim();
    if (!latestAssistantText || isPassiveAssistantPlanningMessage(latestAssistantText)) {
      return;
    }

    await this.ensureProjectSupportFiles(project);
    const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
    const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
    const existingEntries = await journalStore.list(project.changeName);
    const lastEntry = existingEntries[existingEntries.length - 1];
    if (lastEntry?.role === "assistant" && lastEntry.text === latestAssistantText) {
      return;
    }

    const timestamp = new Date().toISOString();
    await journalStore.append({
      timestamp,
      changeName: project.changeName,
      role: "assistant",
      text: latestAssistantText,
    });

    await this.stateStore.updateProject(project.channelKey, (current) => ({
      ...current,
      planningJournal: {
        dirty: true,
        entryCount: (current.planningJournal?.entryCount ?? 0) + 1,
        lastEntryAt: timestamp,
        lastSyncedAt: current.planningJournal?.lastSyncedAt,
      },
    }));
  }

  private async finalizePlanningTurn(project: ProjectState, event: AgentEndEvent): Promise<void> {
    if (!project.repoPath || !project.changeName) {
      return;
    }

    const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
    const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
    const timestamp = new Date().toISOString();
    let status: ProjectState["status"] = "ready";
    let phase: ProjectState["phase"] = "tasks";
    let blockedReason: string | undefined;
    let latestSummary = `Planning sync finished for ${project.changeName}. Say \`cs-work\` to start implementation.`;
    let taskCounts = project.taskCounts;
    let currentTask = project.currentTask;
    let journalDirty = false;
    let lastSyncedAt = timestamp;

    await removeIfExists(repoStatePaths.executionControlFile);
    await removeIfExists(repoStatePaths.executionResultFile);
    await removeIfExists(repoStatePaths.workerProgressFile);

    if (!event.success) {
      status = "blocked";
      phase = "planning_sync";
      blockedReason = `Planning sync failed: ${event.error ?? "unknown error"}`;
      latestSummary = blockedReason;
      journalDirty = true;
      lastSyncedAt = project.planningJournal?.lastSyncedAt;
    } else {
      try {
        const apply = (await this.openSpec.instructionsApply(project.repoPath, project.changeName)).parsed;
        taskCounts = apply.progress;
        const nextTask = apply.tasks.find((task) => !task.done);
        currentTask = nextTask ? `${nextTask.id} ${nextTask.description}` : undefined;

        if (apply.state === "blocked") {
          status = "blocked";
          phase = "proposal";
          blockedReason = buildPlanningBlockedMessage(project);
          latestSummary = blockedReason;
          journalDirty = true;
          lastSyncedAt = project.planningJournal?.lastSyncedAt;
        } else if (apply.state === "all_done") {
          status = "done";
          phase = "validating";
          latestSummary = `Planning sync finished and all tasks for ${project.changeName} are already complete.`;
          currentTask = undefined;
        }
      } catch (error) {
        status = "blocked";
        phase = "planning_sync";
        blockedReason = error instanceof OpenSpecCommandError
          ? `Planning sync finished, but \`${error.result.command}\` failed. Review the OpenSpec output and run \`cs-plan\` again.`
          : `Planning sync finished, but apply readiness could not be checked: ${error instanceof Error ? error.message : String(error)}`;
        latestSummary = blockedReason;
        journalDirty = true;
        lastSyncedAt = project.planningJournal?.lastSyncedAt;
      }
    }

    if (!journalDirty) {
      await journalStore.writeSnapshot(repoStatePaths.planningJournalSnapshotFile, project.changeName, timestamp);
    }
    await this.writeLatestSummary(repoStatePaths, latestSummary);

    await this.stateStore.updateProject(project.channelKey, (current) => ({
      ...current,
      status,
      phase,
      blockedReason,
      taskCounts,
      currentTask,
      latestSummary,
      pauseRequested: false,
      cancelRequested: false,
      execution: undefined,
      boundSessionKey: current.boundSessionKey,
      planningJournal: {
        dirty: journalDirty,
        entryCount: current.planningJournal?.entryCount ?? 0,
        lastEntryAt: current.planningJournal?.lastEntryAt,
        lastSyncedAt,
      },
    }));
  }

  private resolvePostRunStatus(
    project: ProjectState,
    result: ExecutionResult | null,
    taskCounts: TaskCountSummary | undefined,
    event: AgentEndEvent,
  ): ProjectState["status"] {
    void project;

    if (result?.status === "done" || (taskCounts?.remaining ?? 1) === 0) {
      return "done";
    }
    if (result?.status === "paused") {
      return "paused";
    }
    if (result?.status === "blocked") {
      return "blocked";
    }
    if (result?.status === "running") {
      return "ready";
    }
    if (!event.success) {
      return "blocked";
    }
    return "ready";
  }

  private async writeExecutionControl(project: ProjectState): Promise<void> {
    if (!project.repoPath || !project.changeName || !project.execution) {
      return;
    }
    const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
    await writeJsonFile(repoStatePaths.executionControlFile, this.buildExecutionControl(project));
  }

  private buildExecutionControl(project: ProjectState): ExecutionControlFile {
    const execution = project.execution;
    return {
      version: 1,
      changeName: project.changeName ?? "",
      mode: execution?.mode ?? "apply",
      state: execution?.state ?? "armed",
      armedAt: execution?.armedAt ?? new Date().toISOString(),
      startedAt: execution?.startedAt,
      sessionKey: execution?.sessionKey ?? project.boundSessionKey,
      pauseRequested: project.pauseRequested,
      cancelRequested: project.cancelRequested === true,
    };
  }

  private async loadTaskCounts(project: ProjectState): Promise<TaskCountSummary | undefined> {
    if (!project.repoPath || !project.changeName) {
      return project.taskCounts;
    }
    const tasksPath = getTasksPath(project.repoPath, project.changeName);
    if (!(await pathExists(tasksPath))) {
      return project.taskCounts;
    }
    return (await parseTasksFile(tasksPath)).counts;
  }

  private async writeArchiveBundle(project: ProjectState, taskCounts: TaskCountSummary): Promise<string> {
    const repoStatePaths = getRepoStatePaths(project.repoPath!, this.archiveDirName);
    const archivePath = path.join(repoStatePaths.archivesRoot, project.projectId);
    await ensureDir(archivePath);

    const resumeContext = [
      "# Resume Context",
      "",
      `Project: ${project.projectTitle ?? project.projectName ?? project.projectId}`,
      `Repo path: ${project.repoPath}`,
      `Change name: ${project.changeName ?? "_unknown_"}`,
      `Completed tasks: ${taskCounts.complete}`,
      `Remaining tasks: ${taskCounts.remaining}`,
      `Latest summary: ${project.latestSummary ?? "_none_"}`,
    ].join("\n");
    await writeUtf8(path.join(archivePath, "resume-context.md"), `${resumeContext}\n`);

    const sessionSummary = [
      "# Session Summary",
      "",
      `Project id: ${project.projectId}`,
      `Project: ${project.projectName ?? project.projectId}`,
      `Change: ${project.changeName ?? "_none_"}`,
      `Task counts: ${taskCounts.complete}/${taskCounts.total}`,
      `Latest summary: ${project.latestSummary ?? "_none_"}`,
    ].join("\n");
    await writeUtf8(path.join(archivePath, "session-summary.md"), `${sessionSummary}\n`);

    const changedFiles = (await tryReadUtf8(repoStatePaths.changedFilesFile)) ?? "# Changed Files\n";
    await writeUtf8(path.join(archivePath, "changed-files.md"), changedFiles);

    const decisionLog = (await tryReadUtf8(repoStatePaths.decisionLogFile)) ?? "# Decision Log\n";
    await writeUtf8(path.join(archivePath, "decision-log.md"), decisionLog);

    await writeJsonFile(path.join(archivePath, "run-metadata.json"), {
      projectId: project.projectId,
      projectName: project.projectName,
      repoPath: project.repoPath,
      changeName: project.changeName,
      taskCounts,
      latestSummary: project.latestSummary,
      archivedAt: new Date().toISOString(),
    });

    return archivePath;
  }

  private async updateSupportFilesFromExecutionResult(project: ProjectState, result: ExecutionResult): Promise<void> {
    if (!project.repoPath) {
      return;
    }

    const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
    const progressBlock = [
      `## ${result.timestamp}`,
      "",
      `- status: ${result.status}`,
      `- summary: ${result.summary}`,
      result.completedTask ? `- completed: ${result.completedTask}` : "",
      result.currentArtifact ? `- artifact: ${result.currentArtifact}` : "",
      typeof result.remainingTasks === "number" ? `- remaining: ${result.remainingTasks}` : "",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n");
    await appendUtf8(repoStatePaths.progressFile, `${progressBlock}\n`);

    await this.mergeChangedFiles(repoStatePaths, result.changedFiles);
    if (result.notes.length > 0) {
      const notesBlock = [
        `## ${result.timestamp}`,
        "",
        ...result.notes.map((note) => `- ${note}`),
        "",
      ].join("\n");
      await appendUtf8(repoStatePaths.decisionLogFile, notesBlock);
    }

    await this.writeLatestSummary(repoStatePaths, result.summary);

    if (project.changeName && result.changedFiles.length > 0) {
      const rollbackStore = new RollbackStore(project.repoPath, this.archiveDirName, project.changeName);
      const manifest = await rollbackStore.readManifest();
      if (manifest) {
        await rollbackStore.recordTouchedFiles(result.changedFiles);
      }
    }
  }

  private async mergeChangedFiles(repoStatePaths: RepoStatePaths, changedFiles: string[]): Promise<void> {
    const existing = ((await tryReadUtf8(repoStatePaths.changedFilesFile)) ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^- /, "").trim())
      .filter((line) => line.length > 0 && line !== "# Changed Files");
    const merged = new Set(existing);
    changedFiles.forEach((entry) => {
      const normalized = normalizeSlashes(entry).replace(/^\.\//, "");
      if (normalized) {
        merged.add(normalized);
      }
    });

    const body = ["# Changed Files", ""]
      .concat(Array.from(merged).sort((left, right) => left.localeCompare(right)).map((entry) => `- ${entry}`))
      .join("\n");
    await writeUtf8(repoStatePaths.changedFilesFile, `${body}\n`);
  }

  private async writeLatestSummary(repoStatePaths: RepoStatePaths, summary: string): Promise<void> {
    await writeUtf8(repoStatePaths.latestSummaryFile, `${summary}\n`);
  }

  private async reconcileProjectFromApplyInstructions(
    channelKey: string,
    project: ProjectState,
    apply: OpenSpecApplyInstructionsResponse,
  ): Promise<ProjectState> {
    const nextTask = apply.tasks.find((task) => !task.done);
    const nextCurrentTask = nextTask ? `${nextTask.id} ${nextTask.description}` : undefined;

    if (project.status === "planning" && project.phase === "planning_sync" && project.planningJournal?.dirty !== true) {
      if (apply.state === "all_done") {
        return await this.stateStore.updateProject(channelKey, (current) => ({
          ...current,
          status: "done",
          phase: "validating",
          blockedReason: undefined,
          taskCounts: apply.progress,
          currentTask: undefined,
          latestSummary: `Planning sync finished and all tasks for ${current.changeName} are already complete.`,
          planningJournal: {
            dirty: false,
            entryCount: current.planningJournal?.entryCount ?? 0,
            lastEntryAt: current.planningJournal?.lastEntryAt,
            lastSyncedAt: new Date().toISOString(),
          },
        }));
      }

      if (apply.state === "ready") {
        return await this.stateStore.updateProject(channelKey, (current) => ({
          ...current,
          status: "ready",
          phase: "tasks",
          blockedReason: undefined,
          taskCounts: apply.progress,
          currentTask: nextCurrentTask,
          latestSummary: `Planning sync finished for ${current.changeName}. Say \`cs-work\` to start implementation.`,
          planningJournal: {
            dirty: false,
            entryCount: current.planningJournal?.entryCount ?? 0,
            lastEntryAt: current.planningJournal?.lastEntryAt,
            lastSyncedAt: new Date().toISOString(),
          },
        }));
      }

      if (apply.state === "blocked") {
        return await this.stateStore.updateProject(channelKey, (current) => ({
          ...current,
          status: "blocked",
          phase: "proposal",
          blockedReason: buildPlanningBlockedMessage(current),
          taskCounts: apply.progress,
          currentTask: nextCurrentTask,
          latestSummary: buildPlanningBlockedMessage(current),
        }));
      }
    }

    if (project.status === "blocked" && apply.state === "all_done") {
      return await this.stateStore.updateProject(channelKey, (current) => ({
        ...current,
        status: "done",
        phase: "validating",
        blockedReason: undefined,
        taskCounts: apply.progress,
        currentTask: undefined,
        latestSummary: `All tasks for ${current.changeName} are complete. Use \`/clawspec archive\` when you are ready.`,
      }));
    }

    if (
      project.taskCounts?.total !== apply.progress.total
      || project.taskCounts?.complete !== apply.progress.complete
      || project.taskCounts?.remaining !== apply.progress.remaining
      || project.currentTask !== nextCurrentTask
    ) {
      return await this.stateStore.updateProject(channelKey, (current) => ({
        ...current,
        taskCounts: apply.progress,
        currentTask: nextCurrentTask,
      }));
    }

    return project;
  }

  private async bindProjectSession(
    channelKey: string,
    project: ProjectState,
    sessionKey?: string,
  ): Promise<ProjectState> {
    if (!sessionKey || project.boundSessionKey === sessionKey) {
      return project;
    }

    return await this.stateStore.updateProject(channelKey, (current) => ({
      ...current,
      boundSessionKey: sessionKey,
    }));
  }

  private async readMeaningfulExecutionSummary(repoStatePaths: RepoStatePaths): Promise<string | undefined> {
    const latestSummary = ((await tryReadUtf8(repoStatePaths.latestSummaryFile)) ?? "")
      .trim();
    if (isMeaningfulExecutionSummary(latestSummary)) {
      return latestSummary;
    }

    const progressLines = ((await tryReadUtf8(repoStatePaths.progressFile)) ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .reverse();
    const progressSummary = progressLines.find((line) =>
      line.startsWith("- Blocked")
      || line.startsWith("- blocked")
      || line.startsWith("- summary:")
    );
    if (!progressSummary) {
      return undefined;
    }

    return progressSummary
      .replace(/^- summary:\s*/i, "")
      .replace(/^- blocked(?: at [^:]+)?:\s*/i, "")
      .trim();
  }

  private async clearChangeRuntimeFiles(repoStatePaths: RepoStatePaths): Promise<void> {
    await removeIfExists(repoStatePaths.executionControlFile);
    await removeIfExists(repoStatePaths.executionResultFile);
    await removeIfExists(repoStatePaths.workerProgressFile);
    await removeIfExists(repoStatePaths.planningJournalFile);
    await removeIfExists(repoStatePaths.planningJournalSnapshotFile);
    await removeIfExists(repoStatePaths.rollbackManifestFile);
  }

  private async resetRunSupportFiles(repoStatePaths: RepoStatePaths, latestSummary: string): Promise<void> {
    await ensureDir(repoStatePaths.root);
    await removeIfExists(repoStatePaths.executionControlFile);
    await removeIfExists(repoStatePaths.executionResultFile);
    await writeUtf8(repoStatePaths.progressFile, "# Progress\n");
    await writeUtf8(repoStatePaths.workerProgressFile, "");
    await writeUtf8(repoStatePaths.changedFilesFile, "# Changed Files\n");
    await writeUtf8(repoStatePaths.decisionLogFile, "# Decision Log\n");
    await writeUtf8(repoStatePaths.latestSummaryFile, `${latestSummary}\n`);
  }

  private async finalizeCancellation(project: ProjectState, result?: ExecutionResult | null): Promise<void> {
    if (!project.repoPath || !project.changeName) {
      return;
    }

    const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
    const rollbackStore = new RollbackStore(project.repoPath, this.archiveDirName, project.changeName);
    await rollbackStore.restoreTouchedFiles().catch(() => undefined);
    await removeIfExists(getChangeDir(project.repoPath, project.changeName));
    await rollbackStore.clear().catch(() => undefined);
    await this.clearChangeRuntimeFiles(repoStatePaths);
    await this.resetRunSupportFiles(repoStatePaths, `Cancelled change ${project.changeName}.`);

    const timestamp = result?.timestamp ?? new Date().toISOString();
    const lastExecution = result ?? {
      version: 1 as const,
      changeName: project.changeName,
      mode: project.execution?.mode ?? "continue",
      status: "cancelled" as const,
      timestamp,
      summary: `Cancelled change ${project.changeName}.`,
      progressMade: false,
      changedFiles: [],
      notes: [],
      taskCounts: project.taskCounts,
      remainingTasks: project.taskCounts?.remaining,
    };

    await this.stateStore.updateProject(project.channelKey, (current) => ({
      ...current,
      status: "idle",
      phase: "cancelling",
      changeName: undefined,
      changeDir: undefined,
      description: undefined,
      currentTask: undefined,
      taskCounts: undefined,
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: undefined,
      latestSummary: `Cancelled change ${project.changeName}.`,
      execution: undefined,
      lastExecution,
      lastExecutionAt: timestamp,
      planningJournal: {
        dirty: false,
        entryCount: 0,
      },
      rollback: undefined,
      boundSessionKey: current.boundSessionKey ?? project.boundSessionKey,
    }));
  }

  private async ensureProjectSupportFiles(project: ProjectState): Promise<void> {
    if (!project.repoPath) {
      return;
    }
    const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
    await ensureDir(repoStatePaths.root);
    if (!(await pathExists(repoStatePaths.progressFile))) {
      await writeUtf8(repoStatePaths.progressFile, "# Progress\n");
    }
    if (!(await pathExists(repoStatePaths.changedFilesFile))) {
      await writeUtf8(repoStatePaths.changedFilesFile, "# Changed Files\n");
    }
    if (!(await pathExists(repoStatePaths.decisionLogFile))) {
      await writeUtf8(repoStatePaths.decisionLogFile, "# Decision Log\n");
    }
    if (!(await pathExists(repoStatePaths.latestSummaryFile))) {
      await writeUtf8(repoStatePaths.latestSummaryFile, "No summary yet.\n");
    }
    if (!(await pathExists(repoStatePaths.planningJournalFile))) {
      await writeUtf8(repoStatePaths.planningJournalFile, "");
    }
  }

  private async buildWorkspaceText(project: ProjectState, note?: string): Promise<string> {
    const workspacePath = project.workspacePath ?? await this.workspaceStore.getCurrentWorkspace();
    const workspaces = await this.workspaceStore.list();
    const catalog = await this.buildWorkspaceCatalog(workspacePath);

    const lines = [
      heading("Workspace"),
      "",
      note ?? "",
      note ? "" : "",
      `Current workspace: \`${workspacePath}\``,
      project.projectName ? `Active project: \`${project.projectName}\`` : "Active project: _none_",
      project.changeName ? `Active change: \`${project.changeName}\` (${project.status})` : "Active change: _none_",
      "",
      "Known workspaces:",
      ...workspaces.map((entry) => `- ${samePath(entry.path, workspacePath) ? "* " : ""}\`${entry.path}\``),
      "",
      "Projects in workspace:",
      ...(catalog.length > 0
        ? catalog.map((entry) => `- \`${entry.label}\`${samePath(entry.repoPath, project.repoPath) ? " (active)" : ""}`)
        : ["- _none yet_"]),
      "",
      "Use `/clawspec use <project-name>` to select or create a project in this workspace.",
    ];

    return lines.filter((line, index, array) => !(line === "" && array[index - 1] === "")).join("\n");
  }

  private async buildWorkspaceCatalog(workspacePath: string): Promise<ProjectCatalogEntry[]> {
    const dirs = await listDirectories(workspacePath);
    return dirs.map((dirName) => ({
      label: dirName,
      repoPath: path.join(workspacePath, dirName),
      source: "workspace",
    }));
  }

  private resolveWorkspaceProjectPath(workspacePath: string, input: string): string {
    const resolved = resolveUserPath(input, workspacePath);
    const relative = path.relative(workspacePath, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("`/clawspec use` only accepts a project path inside the current workspace.");
    }
    return resolved;
  }

  private async renderStatus(
    project: ProjectState,
    note?: string,
    commandOutputs: OpenSpecCommandResult[] = [],
    applyResult?: OpenSpecApplyInstructionsResponse,
  ): Promise<string> {
    const taskCounts = applyResult?.progress ?? await this.loadTaskCounts(project);
    const executionStatus = project.execution
      ? `${project.execution.state} (${project.execution.mode})`
      : project.status === "planning"
        ? "visible-chat"
        : "idle";
    const workerAgent = this.getEffectiveWorkerAgentId(project);
    const showLastExecution = !project.execution;
    const latestExecutionSummary = showLastExecution && project.lastExecution
      ? formatExecutionSummary(project.lastExecution)
      : undefined;
    const nextStepHint = project.status === "planning"
      ? `Planning sync is in progress for \`${project.changeName}\`. Let the current chat turn finish, then check status again.`
      : !isProjectContextAttached(project)
        ? "Chat context is detached from ClawSpec. Use `/clawspec attach` or `cs-attach` when you want ordinary chat to re-enter project mode."
      : requiresPlanningSync(project)
        ? buildPlanningRequiredMessage(project)
        : project.status === "blocked"
          ? ((project.phase === "proposal" || project.phase === "planning_sync")
            ? buildPlanningBlockedMessage(project)
            : project.blockedReason ?? `Change \`${project.changeName}\` is blocked. Review the latest status, then continue once the blocker is resolved.`)
          : (!isFinishedStatus(project.status) && project.changeName && !hasBlockingExecution(project))
            ? `Change \`${project.changeName}\` is ready for implementation. Use \`cs-work\` or \`/clawspec continue\` when you want to resume.`
            : undefined;

    const lines = [
      heading("Project Status"),
      "",
      note ?? "",
      note ? "" : "",
      `Workspace: \`${project.workspacePath ?? "_unset_"}\``,
      `Project: ${project.projectName ? `\`${project.projectName}\`` : "_unset_"}`,
      `Repo path: ${project.repoPath ? `\`${project.repoPath}\`` : "_unset_"}`,
      `Change: ${project.changeName ? `\`${project.changeName}\`` : "_none_"}`,
      `Context: \`${isProjectContextAttached(project) ? "attached" : "detached"}\``,
      `Worker agent: ${formatWorkerAgent(workerAgent)}`,
      `Lifecycle: \`${project.status}\``,
      `Phase: \`${project.phase}\``,
      `Execution: \`${executionStatus}\``,
      formatProjectTaskCounts(project, taskCounts),
      `Planning journal: ${project.planningJournal?.dirty ? "dirty" : "clean"} (${project.planningJournal?.entryCount ?? 0} entries)`,
      !workerAgent ? `Worker setup: ${buildWorkerAgentSetupHint("work")}` : "",
      nextStepHint ? `Next step: ${nextStepHint}` : "",
      project.latestSummary ? `Latest summary: ${project.latestSummary}` : "Latest summary: _none_",
      project.blockedReason ? `Blocked reason: ${project.blockedReason}` : "",
      project.execution?.state === "armed"
        ? "Execution is queued in the background. Watch for progress updates here or use `/clawspec pause`."
        : "",
      latestExecutionSummary ? "" : "",
      latestExecutionSummary ? "Last execution:" : "",
      latestExecutionSummary ?? "",
      commandOutputs.length > 0 ? "" : "",
      formatCommandOutputSection(commandOutputs),
    ];

    return lines.filter((line, index, array) => !(line === "" && array[index - 1] === "")).join("\n");
  }

  private getDefaultWorkerAgentId(): string | undefined {
    return getConfiguredDefaultWorkerAgent(this.config) ?? this.defaultWorkerAgentId;
  }

  private getEffectiveWorkerAgentId(project: ProjectState): string | undefined {
    return project.execution?.workerAgentId ?? project.workerAgentId ?? this.getDefaultWorkerAgentId();
  }

  private validateWorkerAgentConfiguration(
    project: ProjectState,
    action: "plan" | "work",
  ): { ok: true; agentId: string } | { ok: false; result: PluginCommandResult } {
    const workerAgentId = this.getEffectiveWorkerAgentId(project);
    if (workerAgentId) {
      return { ok: true, agentId: workerAgentId };
    }
    return {
      ok: false,
      result: errorReply(
        [
          heading("Worker Setup Required"),
          "",
          buildWorkerAgentSetupMessage(action),
          "ClawSpec manages the `acpx` command automatically; only the OpenClaw ACP agent selection is missing.",
        ].join("\n"),
      ),
    };
  }
}

function formatWorkerAgent(agentId: string | undefined): string {
  return agentId ? `\`${agentId}\`` : "_not configured_";
}

function describeWorkerTransportMode(project: ProjectState): string {
  const execution = project.execution;
  if (!execution) {
    return "idle";
  }
  if (execution.state === "armed" && (execution.restartCount ?? 0) > 0) {
    return "restart-pending";
  }
  if (execution.state === "armed") {
    return "queued";
  }
  if (
    execution.state === "running"
    && typeof project.latestSummary === "string"
    && /monitoring the running .*worker/i.test(project.latestSummary)
  ) {
    return "adopted-monitoring";
  }
  if (execution.state === "running") {
    return "monitoring";
  }
  return execution.state;
}

function describeWorkerRuntimeState(project: ProjectState, runtimeStatus?: AcpWorkerStatus): string {
  if (!project.execution?.sessionKey) {
    return "no-session";
  }
  if (!runtimeStatus) {
    return "unknown";
  }

  const detailState = typeof runtimeStatus.details?.status === "string"
    ? runtimeStatus.details.status.trim().toLowerCase()
    : "";
  const summary = runtimeStatus.summary.trim().toLowerCase();

  if (detailState === "alive" || detailState === "running") {
    return "alive";
  }
  if (detailState === "dead" && summary.includes("no-session")) {
    return "no-session";
  }
  if (detailState === "dead") {
    return "dead";
  }
  if (summary.includes("status=alive") || summary.includes("status=running")) {
    return "alive";
  }
  if (summary.includes("no-session")) {
    return "no-session";
  }
  if (summary.includes("status=dead")) {
    return "dead";
  }
  return "unknown";
}

function describeExecutionStartupWait(execution: ProjectState["execution"]): string | undefined {
  if (!execution?.connectedAt || execution.firstProgressAt) {
    return undefined;
  }
  const connectedAt = Date.parse(execution.connectedAt);
  if (Number.isNaN(connectedAt)) {
    return undefined;
  }
  const elapsedMs = Math.max(0, Date.now() - connectedAt);
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function extractLatestMessageTextByRole(
  messages: unknown[],
  role: "user" | "assistant",
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = unwrapMessageEnvelope(messages[index]);
    if (!candidate) {
      continue;
    }

    const candidateRole = typeof candidate.role === "string"
      ? candidate.role.trim().toLowerCase()
      : "";
    if (candidateRole !== role) {
      continue;
    }

    const text = extractMessageText(candidate).trim();
    if (text) {
      return text;
    }
  }

  return undefined;
}

function unwrapMessageEnvelope(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (isRecord(value.message) && typeof value.message.role === "string") {
    return value.message;
  }

  return value;
}

function extractMessageText(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => extractMessageText(entry, depth + 1).trim())
      .filter((entry) => entry.length > 0)
      .join("\n")
      .trim();
  }

  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.text === "string" && value.text.trim().length > 0) {
    return value.text;
  }

  if (typeof value.value === "string" && value.value.trim().length > 0) {
    return value.value;
  }

  const nested = [
    value.content,
    value.parts,
    value.value,
    value.message,
  ];

  for (const entry of nested) {
    const text = extractMessageText(entry, depth + 1).trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function isPassiveAssistantPlanningMessage(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }

  const collapsed = normalized.replace(/\s+/g, " ").trim();
  if (/^[▶✓⚠↻ℹ]/u.test(collapsed)) {
    return true;
  }
  if (/^[^[]+\[[#-]{4,}\]\s+\d+\/\d+\b/u.test(collapsed)) {
    return true;
  }

  const lower = collapsed.toLowerCase();
  if ([
    "project started",
    "project selected",
    "proposal ready",
    "planning ready",
    "worker status",
    "project status",
    "worker agent",
    "context attached",
    "context detached",
    "change cancelled",
    "change archived",
    "cancellation requested",
    "workspace switched",
    "no new planning notes",
    "planning preparation failed",
    "execution preparation failed",
  ].some((prefix) => lower.startsWith(prefix))) {
    return true;
  }

  if (
    lower.startsWith("execution started for ")
    || lower.startsWith("working on task ")
    || lower.startsWith("completed task ")
    || lower.startsWith("blocked: ")
    || lower.startsWith("all tasks complete")
    || lower.startsWith("planning sync for ")
    || lower.startsWith("background execution for ")
  ) {
    return true;
  }

  if (
    /^select a project\b/i.test(collapsed)
    || /^no active clawspec project is bound to this chat\b/i.test(collapsed)
    || /^change `[^`]+` is (?:active|waiting|ready|blocked|not apply-ready)\b/i.test(collapsed)
    || /^normal chat is (?:already )?detached\b/i.test(collapsed)
    || /^ordinary chat .* detached\b/i.test(collapsed)
  ) {
    return true;
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 && lines.every(isWorkflowControlLine);
}

function isWorkflowControlLine(line: string): boolean {
  const lower = line.trim().toLowerCase();
  if (!lower) {
    return true;
  }

  return lower.startsWith("next:")
    || lower.startsWith("next step:")
    || lower.startsWith("use `cs-")
    || lower.startsWith("run `cs-")
    || lower.startsWith("say `cs-")
    || lower.startsWith("use `/clawspec")
    || lower.startsWith("run `/clawspec")
    || lower.startsWith("say `/clawspec")
    || lower.startsWith("continue describing requirements")
    || lower.startsWith("planning now runs in the visible chat")
    || lower.startsWith("when the requirement is clear enough")
    || lower.startsWith("`cs-work` becomes available")
    || lower.startsWith("command fallback:")
    || lower === "`cs-work` is not available yet.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
