import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { getNextIncompleteTask, parseTasksFile } from "../openspec/tasks.ts";
import { OpenSpecClient } from "../openspec/cli.ts";
import { PlanningJournalStore } from "../planning/journal.ts";
import { buildWorkerSessionKey, createWorkerSessionKey } from "../execution/session.ts";
import { readExecutionResult } from "../execution/state.ts";
import { RollbackStore } from "../rollback/store.ts";
import { ProjectStateStore } from "../state/store.ts";
import type {
  ExecutionControlFile,
  ExecutionResult,
  ExecutionResultStatus,
  OpenSpecApplyInstructionsResponse,
  ProjectExecutionState,
  ProjectState,
  TaskCountSummary,
} from "../types.ts";
import {
  appendUtf8,
  ensureDir,
  listDirectoryFiles,
  normalizeSlashes,
  pathExists,
  removeIfExists,
  toPosixRelative,
  tryReadUtf8,
  writeJsonFile,
  writeUtf8,
} from "../utils/fs.ts";
import { getChangeDir, getRepoStatePaths, getTasksPath, resolveProjectScopedPath } from "../utils/paths.ts";
import { loadClawSpecSkillBundle } from "../worker/skills.ts";
import { buildAcpImplementationTurnPrompt, buildAcpPlanningTurnPrompt } from "../worker/prompts.ts";
import { AcpWorkerClient } from "../acp/client.ts";
import { ClawSpecNotifier } from "./notifier.ts";

type WatcherManagerOptions = {
  stateStore: ProjectStateStore;
  openSpec: OpenSpecClient;
  archiveDirName: string;
  logger: PluginLogger;
  notifier: ClawSpecNotifier;
  acpClient: AcpWorkerClient;
  pollIntervalMs: number;
};

type ExecutionWatcherOptions = {
  channelKey: string;
  stateStore: ProjectStateStore;
  openSpec: OpenSpecClient;
  archiveDirName: string;
  logger: PluginLogger;
  notifier: ClawSpecNotifier;
  acpClient: AcpWorkerClient;
  onIdle: () => void;
};

type WorkerProgressFlushResult = {
  offset: number;
  lastEvent?: WorkerProgressEvent;
  hadActivity: boolean;
};

export class WatcherManager {
  readonly stateStore: ProjectStateStore;
  readonly openSpec: OpenSpecClient;
  readonly archiveDirName: string;
  readonly logger: PluginLogger;
  readonly notifier: ClawSpecNotifier;
  readonly acpClient: AcpWorkerClient;
  readonly pollIntervalMs: number;
  readonly watchers = new Map<string, ExecutionWatcher>();
  pollTimer?: NodeJS.Timeout;
  stopping = false;

  constructor(options: WatcherManagerOptions) {
    this.stateStore = options.stateStore;
    this.openSpec = options.openSpec;
    this.archiveDirName = options.archiveDirName;
    this.logger = options.logger;
    this.notifier = options.notifier;
    this.acpClient = options.acpClient;
    this.pollIntervalMs = options.pollIntervalMs;
  }

  async start(): Promise<void> {
    if (this.pollTimer) {
      return;
    }
    this.stopping = false;
    await this.recoverStaleProjects();
    await this.recoverActiveWatchers();
    this.pollTimer = setInterval(() => {
      void this.recoverActiveWatchers().catch((error) => {
        this.logger.warn(
          `[clawspec] watcher recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    const watchers = [...this.watchers.values()];
    for (const watcher of watchers) {
      await watcher.shutdown();
    }
    this.watchers.clear();
    await this.haltProjectsForGatewayStop();
  }

  async wake(channelKey: string): Promise<void> {
    this.getOrCreate(channelKey).kick();
  }

  async interrupt(channelKey: string, reason: string): Promise<void> {
    const watcher = this.watchers.get(channelKey);
    if (!watcher) {
      return;
    }
    await watcher.interrupt(reason);
  }

  private async recoverActiveWatchers(): Promise<void> {
    const projects = await this.stateStore.listActiveProjects();
    for (const project of projects) {
      if (!shouldWatchProject(project)) {
        continue;
      }
      this.getOrCreate(project.channelKey).kick();
    }
  }

  private async recoverStaleProjects(): Promise<void> {
    const projects = await this.stateStore.listActiveProjects();
    for (const project of projects) {
      if (!needsStartupRecovery(project)) {
        continue;
      }
      try {
        await this.recoverProject(project);
      } catch (error) {
        this.logger.warn(
          `[clawspec] startup recovery failed for ${project.changeName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async recoverProject(project: ProjectState): Promise<void> {
    const repoStatePaths = getRepoStatePaths(project.repoPath!, this.archiveDirName);

    const executionResult = await readExecutionResult(repoStatePaths.executionResultFile);
    const taskCounts = await loadTaskCounts(project) ?? project.taskCounts;

    await removeIfExists(repoStatePaths.executionControlFile);
    await removeIfExists(repoStatePaths.executionResultFile);
    await cleanupTmpFiles(path.dirname(repoStatePaths.stateFile));

    if (project.execution?.sessionKey) {
      try {
        await this.acpClient.closeSession(project.execution.sessionKey, "gateway restart recovery");
      } catch (error) {
        this.logger.warn(
          `[clawspec] failed to close stale session during recovery: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const isAllDone = taskCounts && taskCounts.remaining === 0;
    if (isAllDone) {
      const summary = `All tasks for ${project.changeName} are complete (recovered after gateway restart).`;
      await writeLatestSummary(repoStatePaths, summary);
      await this.stateStore.updateProject(project.channelKey, (current) => ({
        ...current,
        status: "done",
        phase: "validating",
        pauseRequested: false,
        cancelRequested: false,
        blockedReason: undefined,
        execution: undefined,
        taskCounts,
        latestSummary: summary,
        lastExecution: executionResult ?? current.lastExecution,
        lastExecutionAt: executionResult?.timestamp ?? new Date().toISOString(),
      }));
      await this.notifier.send(
        project.channelKey,
        `Gateway restarted. All tasks for \`${project.changeName}\` are already complete. Next: use \`/clawspec archive\`.`,
      );
      this.logger.info(`[clawspec] recovered ${project.changeName}: all tasks done.`);
      return;
    }

    const action: ProjectExecutionState["action"] =
      project.phase === "planning_sync" || project.status === "planning" ? "plan" : "work";
    const workerAgentId = project.workerAgentId ?? this.acpClient.agentId;
    const armedAt = new Date().toISOString();
    const sessionKey = createWorkerSessionKey(project, {
      workerSlot: "primary",
      workerAgentId,
      attemptKey: armedAt,
    });
    const taskLabel = project.currentTask ?? (taskCounts ? `${taskCounts.complete + 1}` : undefined);
    const summary = action === "plan"
      ? `Recovered after gateway restart. Resuming planning sync for ${project.changeName}.`
      : `Recovered after gateway restart. Resuming implementation for ${project.changeName}${taskLabel ? ` (task ${taskLabel.split(" ")[0]})` : ""}.`;

    await writeLatestSummary(repoStatePaths, summary);
    const recovered = await this.stateStore.updateProject(project.channelKey, (current) => ({
      ...current,
      status: action === "plan" ? "planning" : "armed",
      phase: action === "plan" ? "planning_sync" : "implementing",
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: undefined,
      taskCounts: taskCounts ?? current.taskCounts,
      latestSummary: summary,
      lastExecution: executionResult ?? current.lastExecution,
      lastExecutionAt: executionResult?.timestamp ?? current.lastExecutionAt,
      execution: {
        mode: current.execution?.mode ?? "apply",
        action,
        state: "armed",
        workerAgentId,
        workerSlot: "primary",
        armedAt,
        sessionKey,
        restartCount: current.execution?.restartCount,
        lastRestartAt: current.execution?.lastRestartAt,
        lastFailure: current.execution?.lastFailure,
      },
    }));

    await writeExecutionControlFile(repoStatePaths.executionControlFile, recovered);

    const notifyMessage = action === "plan"
      ? `Gateway restarted. Resuming planning sync for \`${project.changeName}\` via background worker.`
      : `Gateway restarted. Resuming implementation for \`${project.changeName}\`${taskLabel ? ` (task ${taskLabel.split(" ")[0]})` : ""} via background worker.`;
    await this.notifier.send(project.channelKey, notifyMessage);
    this.logger.info(`[clawspec] recovered ${project.changeName}: re-armed for ${action}.`);
  }

  private getOrCreate(channelKey: string): ExecutionWatcher {
    if (this.stopping) {
      throw new Error("Watcher manager is stopping.");
    }
    const existing = this.watchers.get(channelKey);
    if (existing) {
      return existing;
    }

    const watcher = new ExecutionWatcher({
      channelKey,
      stateStore: this.stateStore,
      openSpec: this.openSpec,
      archiveDirName: this.archiveDirName,
      logger: this.logger,
      notifier: this.notifier,
      acpClient: this.acpClient,
      onIdle: () => {
        this.watchers.delete(channelKey);
      },
    });
    this.watchers.set(channelKey, watcher);
    return watcher;
  }

  private async haltProjectsForGatewayStop(): Promise<void> {
    const projects = await this.stateStore.listActiveProjects();
    const sessionKeys = new Set<string>();

    for (const project of projects) {
      if (!project.repoPath || !project.changeName) {
        continue;
      }

      if (project.execution?.sessionKey) {
        sessionKeys.add(project.execution.sessionKey);
      }

      const taskCounts = await loadTaskCounts(project) ?? project.taskCounts;
      const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);

      if (taskCounts?.remaining === 0) {
        const summary = `All tasks for ${project.changeName} are complete.`;
        await writeLatestSummary(repoStatePaths, summary);
        await this.stateStore.updateProject(project.channelKey, (current) => ({
          ...current,
          status: "done",
          phase: "validating",
          taskCounts: taskCounts ?? current.taskCounts,
          latestSummary: summary,
          blockedReason: undefined,
          pauseRequested: false,
          execution: undefined,
        }));
        continue;
      }

      if (!project.execution) {
        continue;
      }

      const action = project.execution.action;
      const summary = action === "plan"
        ? `Gateway stopped. Planning sync for ${project.changeName} was halted and will resume after restart.`
        : `Gateway stopped. Implementation for ${project.changeName} was halted and will resume after restart.`;
      await writeLatestSummary(repoStatePaths, summary);
      await this.stateStore.updateProject(project.channelKey, (current) => ({
        ...current,
        status: action === "plan" ? "planning" : "armed",
        phase: action === "plan" ? "planning_sync" : "implementing",
        taskCounts: taskCounts ?? current.taskCounts,
        latestSummary: summary,
        blockedReason: undefined,
        pauseRequested: false,
        execution: current.execution
          ? {
              ...current.execution,
              state: "armed",
              startedAt: undefined,
              lastHeartbeatAt: undefined,
            }
          : current.execution,
      }));
    }

    for (const sessionKey of sessionKeys) {
      try {
        await this.acpClient.closeSession(sessionKey, "gateway service stopping");
      } catch (error) {
        this.logger.warn(
          `[clawspec] failed to close session during gateway stop: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

class ExecutionWatcher {
  readonly channelKey: string;
  readonly stateStore: ProjectStateStore;
  readonly openSpec: OpenSpecClient;
  readonly archiveDirName: string;
  readonly logger: PluginLogger;
  readonly notifier: ClawSpecNotifier;
  readonly acpClient: AcpWorkerClient;
  readonly onIdle: () => void;
  timer?: NodeJS.Timeout;
  inFlight = false;
  disposed = false;
  shutdownRequested = false;

  constructor(options: ExecutionWatcherOptions) {
    this.channelKey = options.channelKey;
    this.stateStore = options.stateStore;
    this.openSpec = options.openSpec;
    this.archiveDirName = options.archiveDirName;
    this.logger = options.logger;
    this.notifier = options.notifier;
    this.acpClient = options.acpClient;
    this.onIdle = options.onIdle;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.dispose();
  }

  kick(delayMs = 0): void {
    if (this.disposed || this.shutdownRequested || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delayMs);
  }

  async interrupt(reason: string): Promise<void> {
    const project = await this.stateStore.getActiveProject(this.channelKey);
    const sessionKey = project?.execution?.sessionKey;
    if (!sessionKey) {
      return;
    }
    await this.acpClient.cancelSession(sessionKey, reason);
  }

  private async run(): Promise<void> {
    if (this.disposed || this.shutdownRequested || this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      const project = await this.stateStore.getActiveProject(this.channelKey);
      if (!project || !shouldWatchProject(project)) {
        this.onIdle();
        this.dispose();
        return;
      }

      const shouldContinue = await this.processProject(project);
      if (shouldContinue && !this.disposed) {
        this.kick(200);
      }
    } catch (error) {
      if (this.shutdownRequested) {
        return;
      }
      this.logger.error(`[clawspec] watcher failed for ${this.channelKey}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      const project = await this.stateStore.getActiveProject(this.channelKey);
      if (project?.repoPath && project.changeName && project.status !== "done") {
        await this.blockProject(project, `Watcher failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async processProject(project: ProjectState): Promise<boolean> {
    if (this.shutdownRequested) {
      return false;
    }
    if (!project.repoPath || !project.changeName) {
      this.onIdle();
      this.dispose();
      return false;
    }

    if (project.cancelRequested && project.execution?.state !== "running") {
      await this.finalizeCancellation(project);
      return false;
    }

    if (project.pauseRequested && project.execution?.state !== "running") {
      await this.pauseProject(project, "Execution paused before the next background step started.");
      return false;
    }

    if (project.execution?.action === "plan" || project.status === "planning") {
      return await this.processPlanning(project);
    }

    if (project.execution?.action === "work") {
      return await this.processImplementation(project);
    }

    this.onIdle();
    this.dispose();
    return false;
  }

  private async processPlanning(project: ProjectState): Promise<boolean> {
    const repoStatePaths = getRepoStatePaths(project.repoPath!, this.archiveDirName);
    await ensureSupportFiles(repoStatePaths);
    const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);

    const status = (await this.openSpec.status(project.repoPath!, project.changeName!)).parsed!;
    const artifactsById = new Map(status.artifacts.map((artifact) => [artifact.id, artifact]));
    const requiredIds = status.applyRequires.length > 0
      ? status.applyRequires
      : status.artifacts.map((artifact) => artifact.id);
    const pendingRequiredIds = requiredIds.filter((artifactId) => artifactsById.get(artifactId)?.status !== "done");

    // When ALL tasks were previously completed (project was "done") but the
    // journal has new unsynced notes, force re-generation of the last required
    // artifact so that new requirements get incorporated into tasks.
    const journalDirtyBeforeRun = project.planningJournal?.dirty === true;
    const forcedArtifactIds = journalDirtyBeforeRun
      ? orderedPlanningArtifactIds(status.artifacts.map((artifact) => artifact.id))
      : [];
    const nextForcedArtifactId = journalDirtyBeforeRun
      ? nextPlanningArtifactId(forcedArtifactIds, project.execution?.currentArtifact)
      : undefined;
    if (nextForcedArtifactId) {
      this.logger.info(`[clawspec] journal dirty - forcing re-generation of ${nextForcedArtifactId}`);
    }
    const wasPreviouslyDone = false;
    if (pendingRequiredIds.length === 0 && journalDirtyBeforeRun && wasPreviouslyDone && requiredIds.length > 0) {
      const forceArtifactId = requiredIds[requiredIds.length - 1]!;
      this.logger.info(`[clawspec] journal dirty with all tasks done — forcing re-generation of ${forceArtifactId}`);
      pendingRequiredIds.push(forceArtifactId);
    }

    if (!nextForcedArtifactId && pendingRequiredIds.length === 0) {
      const apply = (await this.openSpec.instructionsApply(project.repoPath!, project.changeName!)).parsed!;
      const latest = await this.stateStore.getActiveProject(this.channelKey) ?? project;
      const startedAt = latest.execution?.startedAt;
      const newNotesArrived = Boolean(
        latest.planningJournal?.dirty
        && latest.planningJournal.lastEntryAt
        && startedAt
        && Date.parse(latest.planningJournal.lastEntryAt) > Date.parse(startedAt)
      );
      const nextTask = nextTaskLabel(apply);
      const summary = apply.state === "all_done"
        ? `Planning ready and all tasks for ${project.changeName} are already complete.`
        : apply.state === "blocked"
          ? `Planning finished, but ${project.changeName} is still not apply-ready.`
          : newNotesArrived
            ? `Planning refreshed for ${project.changeName}, but new notes arrived. Run cs-plan again before cs-work.`
            : `Planning ready for ${project.changeName}. Use cs-work when you want implementation to start.`;
      const nextStatus: ProjectState["status"] = apply.state === "all_done"
        ? "done"
        : apply.state === "blocked"
          ? "blocked"
          : "ready";
      const nextPhase: ProjectState["phase"] = apply.state === "all_done"
        ? "validating"
        : apply.state === "blocked"
          ? "proposal"
          : "tasks";
      const blockedReason = apply.state === "blocked" ? summary : undefined;
      const planningSynced = apply.state !== "blocked";
      const journalDirty = newNotesArrived || !planningSynced;
      const syncedAt = new Date().toISOString();

      await removeIfExists(repoStatePaths.executionControlFile);
      await removeIfExists(repoStatePaths.executionResultFile);
      await writeLatestSummary(repoStatePaths, summary);
      if (planningSynced && !newNotesArrived) {
        await journalStore.writeSnapshot(repoStatePaths.planningJournalSnapshotFile, project.changeName!, syncedAt);
      }
      await this.closeSession(latest.execution?.sessionKey ?? project.execution?.sessionKey);

      const finalized = await this.stateStore.updateProject(this.channelKey, (current) => ({
        ...current,
        status: nextStatus,
        phase: nextPhase,
        pauseRequested: false,
        cancelRequested: false,
        blockedReason,
        currentTask: nextTask,
        taskCounts: apply.progress,
        latestSummary: summary,
        execution: undefined,
        lastExecutionAt: current.lastExecutionAt ?? syncedAt,
        planningJournal: {
          dirty: journalDirty,
          entryCount: current.planningJournal?.entryCount ?? 0,
          lastEntryAt: current.planningJournal?.lastEntryAt,
          lastSyncedAt: journalDirty ? current.planningJournal?.lastSyncedAt : syncedAt,
        },
      }));

    await this.notify(
      finalized,
      nextStatus === "blocked"
          ? buildWatcherStatusMessage("⚠", finalized, `Planning blocked. ${summary} Next: review the blocker, then run \`cs-plan\` again.`)
          : nextStatus === "done"
            ? buildWatcherStatusMessage("🏁", finalized, "Planning complete. All tasks are already done. Next: use `/clawspec archive` when you are ready.")
            : newNotesArrived
              ? buildWatcherStatusMessage("📝", finalized, "Planning refreshed, but new notes arrived. Next: run `cs-plan` again before `cs-work`.")
              : buildWatcherStatusMessage("✅", finalized, "Planning ready. Next: run `cs-work` to start implementation."),
        `plan-finished:${finalized.changeName}:${nextStatus}:${syncedAt}:${journalDirty ? "dirty" : "clean"}`,
      );
      return false;
    }

    const selectedArtifactId = nextForcedArtifactId
      ?? status.artifacts.find((artifact) =>
        pendingRequiredIds.includes(artifact.id) && artifact.status === "ready")?.id
      ?? status.artifacts.find((artifact) => artifact.status === "ready")?.id;

    if (!selectedArtifactId) {
      await this.blockProject(project, "Planning sync cannot continue because OpenSpec has no ready artifact to build next.");
      return false;
    }

    const instructions = (await this.openSpec.instructionsArtifact(
      project.repoPath!,
      selectedArtifactId,
      project.changeName!,
    )).parsed!;
    const runningProject = await this.setRunningState(project, {
      action: "plan",
      currentArtifact: selectedArtifactId,
      workerSlot: "primary",
    });

    await removeIfExists(repoStatePaths.executionResultFile);
    await this.notify(
      runningProject,
      buildWatcherStatusMessage("📝", runningProject, `Planning ${selectedArtifactId}.`),
      `plan-start:${runningProject.changeName}:${selectedArtifactId}:${runningProject.execution?.startedAt ?? "unknown"}`,
    );

    const importedSkills = await loadClawSpecSkillBundle(["explore", "propose"]);
    const { runError } = await this.runAcpTurnWithTracking(
      runningProject,
      repoStatePaths,
      buildAcpPlanningTurnPrompt({ project: runningProject, repoStatePaths, instructions, importedSkills }),
    );
    if (this.shutdownRequested) {
      return false;
    }

    const { result, latest, requestedCancel, requestedPause } = await this.resolvePostRunState(
      runningProject, repoStatePaths, runError,
      {
        summary: `Updated ${selectedArtifactId}.`,
        currentArtifact: selectedArtifactId,
        changedFiles: [toRepoRelative(project, instructions.outputPath)],
        notes: [`Updated ${selectedArtifactId}.`],
        taskCounts: (await this.stateStore.getActiveProject(this.channelKey))?.taskCounts ?? project.taskCounts,
      },
    );

    if (await this.recoverWorkerFailureIfNeeded(
      runningProject,
      latest,
      repoStatePaths,
      runError,
      result,
      requestedCancel,
      requestedPause,
    )) {
      return false;
    }

    if (await this.dispatchTerminalResult(latest, result, requestedCancel, requestedPause)) {
      return false;
    }

    const queued = await this.stateStore.updateProject(this.channelKey, (current) => {
      const rearmedAt = current.execution?.armedAt ?? new Date().toISOString();
      return {
        ...current,
        status: "planning",
        phase: "planning_sync",
        pauseRequested: false,
        cancelRequested: false,
        blockedReason: undefined,
        latestSummary: result.summary,
        lastExecution: result,
        lastExecutionAt: result.timestamp,
        execution: {
          mode: current.execution?.mode ?? "apply",
          action: "plan",
          state: "armed",
          workerAgentId: current.execution?.workerAgentId ?? current.workerAgentId ?? this.acpClient.agentId,
          workerSlot: current.execution?.workerSlot ?? "primary",
          armedAt: rearmedAt,
          startedAt: undefined,
          sessionKey: current.execution?.sessionKey ?? createWorkerSessionKey(current, {
            workerSlot: current.execution?.workerSlot ?? "primary",
            workerAgentId: current.execution?.workerAgentId ?? current.workerAgentId ?? this.acpClient.agentId,
            attemptKey: rearmedAt,
          }),
          currentArtifact: selectedArtifactId,
          currentTaskId: undefined,
          restartCount: 0,
          lastRestartAt: undefined,
          lastFailure: undefined,
        },
      };
    });
    await this.writeExecutionControl(this.channelKey);
    const nextPlanningStep = nextForcedArtifactId
      ? (nextPlanningArtifactId(forcedArtifactIds, selectedArtifactId) ?? await this.describeNextPlanningStep(queued))
      : await this.describeNextPlanningStep(queued);

    await this.notify(
      queued,
      buildWatcherStatusMessage("📝", queued, `Updated ${selectedArtifactId}. Next: ${nextPlanningStep}`),
      `plan-done:${queued.changeName}:${selectedArtifactId}:${result.timestamp}`,
    );
    return true;
  }

  private async processImplementation(project: ProjectState): Promise<boolean> {
    const repoStatePaths = getRepoStatePaths(project.repoPath!, this.archiveDirName);
    await ensureSupportFiles(repoStatePaths);

    const apply = (await this.openSpec.instructionsApply(project.repoPath!, project.changeName!)).parsed!;
    if (apply.state === "blocked") {
      await this.blockProject(project, `Implementation is not ready because ${project.changeName} still needs planning sync.`);
      return false;
    }

    if (apply.state === "all_done" || apply.progress.remaining === 0) {
      await this.finalizeCompletedImplementation(project, repoStatePaths, apply.progress, project.lastExecution);
      return false;
    }

    const remainingTasks = apply.tasks.filter((task) => !task.done);
    if (remainingTasks.length === 0) {
      await this.blockProject(project, "OpenSpec apply returned ready, but no pending task could be found.");
      return false;
    }

    const firstTask = remainingTasks[0]!;
    if (shouldAnnounceExecutionStartup(project)) {
      await this.notify(
        project,
        buildWatcherStatusMessage(
          "🛰️",
          project,
          `Watcher active. Starting ${resolveWorkerAgent(project, this.acpClient.agentId)} worker for task ${firstTask.id}.`,
          apply.progress,
        ),
        `work-starting:${project.changeName}:${project.execution?.sessionKey ?? project.execution?.armedAt ?? "unknown"}`,
      );
    }
    const runningProject = await this.setRunningState(project, {
      action: "work",
      currentTaskId: firstTask.id,
      workerSlot: "primary",
    });
    await removeIfExists(repoStatePaths.executionResultFile);
    await writeUtf8(repoStatePaths.workerProgressFile, "");

    const importedSkills = await loadClawSpecSkillBundle(["apply"]);
    const { runError } = await this.runAcpTurnWithTracking(
      runningProject,
      repoStatePaths,
      buildAcpImplementationTurnPrompt({
        project: runningProject, repoStatePaths, apply,
        task: firstTask, tasks: remainingTasks,
        mode: runningProject.execution?.mode ?? "apply", importedSkills,
      }),
    );
    if (this.shutdownRequested) {
      return false;
    }

    const { result, latest, requestedCancel, requestedPause } = await this.resolvePostRunState(
      runningProject, repoStatePaths, runError,
      {
        summary: `Completed ${remainingTasks.length} tasks.`,
        completedTask: `${firstTask.id} ${firstTask.description}`,
        notes: [`Completed ${remainingTasks.length} tasks.`],
        taskCounts: apply.progress,
        remainingTasks: apply.progress.remaining,
      },
    );

    if (await this.recoverWorkerFailureIfNeeded(
      runningProject,
      latest,
      repoStatePaths,
      runError,
      result,
      requestedCancel,
      requestedPause,
    )) {
      return false;
    }

    if (await this.dispatchTerminalResult(latest, result, requestedCancel, requestedPause)) {
      return false;
    }

    const refreshedApply = (await this.openSpec.instructionsApply(project.repoPath!, project.changeName!)).parsed!;
    const latestAfterTask = await this.stateStore.getActiveProject(this.channelKey) ?? latest;
    const newPlanningNotes = latestAfterTask.planningJournal?.dirty === true;

    if (refreshedApply.state === "all_done" || refreshedApply.progress.remaining === 0 || result.status === "done") {
      await this.finalizeCompletedImplementation(latestAfterTask, repoStatePaths, refreshedApply.progress, result);
      return false;
    }

    if (newPlanningNotes) {
      await removeIfExists(repoStatePaths.executionControlFile);
      await removeIfExists(repoStatePaths.executionResultFile);
      await this.closeSession(latestAfterTask.execution?.sessionKey ?? runningProject.execution?.sessionKey);
      const halted = await this.stateStore.updateProject(this.channelKey, (current) => ({
        ...current,
        status: "ready",
        phase: "tasks",
        pauseRequested: false,
        cancelRequested: false,
        blockedReason: undefined,
        currentTask: nextTaskLabel(refreshedApply),
        taskCounts: refreshedApply.progress,
        latestSummary: `New planning notes arrived for ${current.changeName}. Run cs-plan before cs-work continues.`,
        execution: undefined,
        lastExecution: result,
        lastExecutionAt: result.timestamp,
      }));
      await writeLatestSummary(repoStatePaths, halted.latestSummary ?? "Planning sync required.");
      await this.notify(
        halted,
        buildWatcherStatusMessage("📝", halted, "New notes arrived. Next: run `cs-plan` before `cs-work` continues."),
        `work-needs-plan:${halted.changeName}:${result.timestamp}`,
      );
      return false;
    }

    const queued = await this.stateStore.updateProject(this.channelKey, (current) => {
      const rearmedAt = current.execution?.armedAt ?? new Date().toISOString();
      return {
        ...current,
        status: "armed",
        phase: "implementing",
        pauseRequested: false,
        cancelRequested: false,
        blockedReason: undefined,
        currentTask: nextTaskLabel(refreshedApply),
        taskCounts: refreshedApply.progress,
        latestSummary: result.summary,
        lastExecution: result,
        lastExecutionAt: result.timestamp,
        execution: {
          mode: current.execution?.mode ?? "apply",
          action: "work",
          state: "armed",
          workerAgentId: current.execution?.workerAgentId ?? current.workerAgentId ?? this.acpClient.agentId,
          workerSlot: current.execution?.workerSlot ?? "primary",
          armedAt: rearmedAt,
          startedAt: undefined,
          sessionKey: current.execution?.sessionKey ?? createWorkerSessionKey(current, {
            workerSlot: current.execution?.workerSlot ?? "primary",
            workerAgentId: current.execution?.workerAgentId ?? current.workerAgentId ?? this.acpClient.agentId,
            attemptKey: rearmedAt,
          }),
          currentArtifact: undefined,
          currentTaskId: nextTaskLabel(refreshedApply)?.split(" ")[0],
          restartCount: 0,
          lastRestartAt: undefined,
          lastFailure: undefined,
        },
      };
    });
    await this.writeExecutionControl(this.channelKey);
    return true;
  }

  /**
   * Shared ACP turn execution with activity tracking.
   * Used by both processPlanning and processImplementation.
   */
  private async runAcpTurnWithTracking(
    project: ProjectState,
    repoStatePaths: ReturnType<typeof getRepoStatePaths>,
    prompt: string,
  ): Promise<{ runError: unknown }> {
    let runError: unknown;
    let workerProgressOffset = 0;
    let stopWatchingTerminal = false;
    let sessionCancelRequested = false;
    let forcedRunError: unknown;
    let lastMeaningfulActivityAt = Date.now();
    let observedWorkerActivity = false;
    let nextStatusPollAt = 0;
    let runTurnSettled = false;
    const sessionKey = project.execution?.sessionKey ?? createWorkerSessionKey(project, {
      workerSlot: project.execution?.workerSlot ?? "primary",
      workerAgentId: project.execution?.workerAgentId ?? resolveWorkerAgent(project, this.acpClient.agentId),
      attemptKey: project.execution?.armedAt,
    });
    const workerAgentId = project.execution?.workerAgentId ?? resolveWorkerAgent(project, this.acpClient.agentId);
    const abortController = new AbortController();
    const flushProgress = async () => {
      const flushed = await this.flushWorkerProgress(project, repoStatePaths, workerProgressOffset);
      workerProgressOffset = flushed.offset;
      if (flushed.hadActivity) {
        lastMeaningfulActivityAt = Date.now();
        observedWorkerActivity = true;
        await this.touchHeartbeat(this.channelKey);
      }
    };
    const watchTerminalResult = (async (): Promise<"terminal" | "forced" | undefined> => {
      while (!stopWatchingTerminal) {
        const persisted = await readExecutionResult(repoStatePaths.executionResultFile);
        if (persisted && isTerminalExecutionStatus(persisted.status)) {
          await flushProgress();
          if (!sessionCancelRequested) {
            sessionCancelRequested = true;
            await this.acpClient.cancelSession(sessionKey, "terminal execution result captured");
          }
          return "terminal";
        }
        const now = Date.now();
        if (now >= nextStatusPollAt) {
          nextStatusPollAt = now + WORKER_STATUS_POLL_INTERVAL_MS;
          const status = this.acpClient.getSessionStatus
            ? await this.acpClient.getSessionStatus({
              sessionKey,
              cwd: project.repoPath!,
              agentId: workerAgentId,
            })
            : undefined;
          if (
            isDeadAcpRuntimeStatus(status)
            && (observedWorkerActivity || !isQueueOwnerUnavailableStatus(status))
            && !persisted
            && now - lastMeaningfulActivityAt >= DEAD_SESSION_GRACE_MS
          ) {
            await flushProgress();
            forcedRunError = new Error(
              describeDeadWorkerStatus(status) ?? "ACP worker session became unavailable during execution.",
            );
            if (!sessionCancelRequested) {
              sessionCancelRequested = true;
              abortController.abort();
              await this.acpClient.cancelSession(sessionKey, "dead background worker session detected");
            }
            this.logger.warn(
              `[clawspec] forcing worker restart for ${project.changeName}: ${forcedRunError instanceof Error ? forcedRunError.message : String(forcedRunError)}`,
            );
            return "forced";
          }
          if (
            !persisted
            && !observedWorkerActivity
            && now - lastMeaningfulActivityAt >= WORKER_STARTUP_GRACE_MS
            && shouldAbortWorkerStartup(status)
          ) {
            await flushProgress();
            forcedRunError = new Error(
              describeWorkerStartupTimeout(status)
              ?? "ACP worker startup timed out before reporting progress.",
            );
            if (!sessionCancelRequested) {
              sessionCancelRequested = true;
              abortController.abort();
              await this.acpClient.cancelSession(sessionKey, "worker startup timed out");
            }
            this.logger.warn(
              `[clawspec] worker startup timed out for ${project.changeName}: ${forcedRunError instanceof Error ? forcedRunError.message : String(forcedRunError)}`,
            );
            return "forced";
          }
        }
        await delay(250);
      }
      return undefined;
    })();
    const runTurnPromise = this.acpClient.runTurn({
      sessionKey,
      cwd: project.repoPath!,
      agentId: workerAgentId,
      text: prompt,
      signal: abortController.signal,
      onReady: async () => {
        await this.notify(
          project,
          buildWatcherStatusMessage(
            "🤖",
            project,
            `ACP worker connected with ${workerAgentId}. Waiting for the first task update.`,
            project.taskCounts,
          ),
          `work-ready:${project.changeName}:${sessionKey}`,
        );
      },
      onEvent: async (event) => {
        if (isMeaningfulAcpRuntimeEvent(event)) {
          lastMeaningfulActivityAt = Date.now();
          observedWorkerActivity = true;
          await this.touchHeartbeat(this.channelKey);
        }
        await flushProgress();
      },
    })
      .then(() => ({ kind: "completed" as const }))
      .catch((error) => ({ kind: "error" as const, error }))
      .finally(() => {
        runTurnSettled = true;
      });
    try {
      const winner = await Promise.race([
        runTurnPromise,
        watchTerminalResult.then((reason) => ({ kind: "watch" as const, reason })),
      ]);
      if (winner.kind === "error") {
        runError = forcedRunError ?? winner.error;
      } else if (winner.kind === "watch" && forcedRunError) {
        runError = forcedRunError;
      }
    } finally {
      stopWatchingTerminal = true;
      await watchTerminalResult.catch(() => undefined);
      if (sessionCancelRequested && !runTurnSettled) {
        await Promise.race([
          runTurnPromise.catch(() => undefined),
          delay(RUN_TURN_SETTLE_GRACE_MS),
        ]);
      }
    }
    if (!runError && forcedRunError) {
      runError = forcedRunError;
    }
    await flushProgress();
    return { runError };
  }

  /**
   * Shared post-run state resolution: reads latest state, detects cancel/pause,
   * resolves execution result, and updates support files.
   */
  private async resolvePostRunState(
    runningProject: ProjectState,
    repoStatePaths: ReturnType<typeof getRepoStatePaths>,
    runError: unknown,
    fallback: Partial<ExecutionResult>,
  ): Promise<{
    result: ExecutionResult;
    latest: ProjectState;
    requestedCancel: boolean;
    requestedPause: boolean;
  }> {
    const latest = await this.stateStore.getActiveProject(this.channelKey) ?? runningProject;
    const requestedCancel = latest.cancelRequested === true;
    const requestedPause = latest.pauseRequested === true;
    const fallbackMessage = runError instanceof Error ? runError.message : String(runError ?? "");

    const fallbackStatus: ExecutionResultStatus = requestedCancel
      ? "cancelled"
      : requestedPause
        ? "paused"
        : runError
          ? "blocked"
          : "running";

    const mergedFallback: Partial<ExecutionResult> = {
      ...fallback,
      notes: runError ? [fallbackMessage] : fallback.notes,
      blocker: runError && !requestedCancel && !requestedPause ? fallbackMessage : undefined,
      progressMade: fallback.progressMade ?? !runError,
    };

    if (runError) {
      mergedFallback.summary = `Execution failed: ${fallbackMessage}`;
    }

    const result = await this.resolveExecutionResult(
      runningProject,
      repoStatePaths,
      fallbackStatus,
      mergedFallback,
    );

    const shouldDeferSupportUpdate = Boolean(
      runError
      && !requestedCancel
      && !requestedPause
      && result.status === "blocked"
      && isRecoverableAcpFailure(fallbackMessage)
      && !(await readExecutionResult(repoStatePaths.executionResultFile)),
    );

    if (!shouldDeferSupportUpdate) {
      await this.updateSupportFiles(runningProject, result);
    }
    return { result, latest, requestedCancel, requestedPause };
  }

  private async flushWorkerProgress(
    project: ProjectState,
    repoStatePaths: ReturnType<typeof getRepoStatePaths>,
    startOffset: number,
  ): Promise<WorkerProgressFlushResult> {
    const raw = await tryReadUtf8(repoStatePaths.workerProgressFile);
    if (!raw) {
      return {
        offset: startOffset,
        hadActivity: false,
      };
    }

    const safeOffset = Math.min(Math.max(startOffset, 0), raw.length);
    if (safeOffset >= raw.length) {
      return {
        offset: raw.length,
        hadActivity: false,
      };
    }

    const chunk = raw.slice(safeOffset);
    const lastNewlineIndex = chunk.lastIndexOf("\n");
    const consumableChunk = lastNewlineIndex === -1 ? "" : chunk.slice(0, lastNewlineIndex + 1);
    const lines = consumableChunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return {
        offset: safeOffset,
        hadActivity: false,
      };
    }

    let lastEvent: WorkerProgressEvent | undefined;
    for (const line of lines) {
      const event = parseWorkerProgressEvent(line);
      if (event) {
        lastEvent = event;
      }
      const message = event ? formatWorkerProgressMessage(project, event) : undefined;
      if (!message) {
        continue;
      }
      await this.notifier.send(project.channelKey, message);
    }

    if (lastEvent) {
      await this.syncWorkerProgressState(project, lastEvent);
    }

    return {
      offset: safeOffset + consumableChunk.length,
      lastEvent,
      hadActivity: lines.length > 0,
    };
  }

  private async syncWorkerProgressState(project: ProjectState, event: WorkerProgressEvent): Promise<void> {
    const taskSnapshot = await loadTaskSnapshot(project);
    const fallbackCounts = deriveCountsFromWorkerEvent(project.taskCounts, event);
    const taskCounts = taskSnapshot?.counts ?? fallbackCounts ?? project.taskCounts;
    const nextTask = taskSnapshot?.nextTask;
    const heartbeatAt = asWorkerEventTimestamp(event.timestamp) ?? new Date().toISOString();
    const currentTaskId = nextTask?.taskId
      ?? (event.kind === "task_start" ? event.taskId : undefined)
      ?? project.execution?.currentTaskId;
    const currentTaskLabel = nextTask
      ? `${nextTask.taskId} ${nextTask.description}`
      : project.currentTask;
    const latestSummary = typeof event.message === "string" && event.message.trim().length > 0
      ? shortenActivityText(event.message, 160)
      : project.latestSummary;

    await this.stateStore.updateProject(this.channelKey, (current) => ({
      ...current,
      taskCounts,
      currentTask: currentTaskLabel,
      latestSummary,
      execution: current.execution
        ? {
            ...current.execution,
            currentTaskId,
            lastHeartbeatAt: heartbeatAt,
          }
        : current.execution,
    }));
  }

  private async finalizeCompletedImplementation(
    project: ProjectState,
    repoStatePaths: ReturnType<typeof getRepoStatePaths>,
    progress: TaskCountSummary,
    priorResult?: ExecutionResult,
  ): Promise<void> {
    const summary = `All tasks for ${project.changeName} are complete.`;
    const completedResult: ExecutionResult = {
      version: 1,
      changeName: project.changeName ?? "",
      mode: project.execution?.mode ?? priorResult?.mode ?? "apply",
      status: "done",
      timestamp: new Date().toISOString(),
      summary,
      progressMade: priorResult?.status === "done" ? priorResult.progressMade : progress.complete > 0,
      completedTask: priorResult?.status === "blocked" ? undefined : priorResult?.completedTask,
      currentArtifact: priorResult?.currentArtifact,
      changedFiles: priorResult?.changedFiles ?? [],
      notes: priorResult?.status === "done" && (priorResult.notes?.length ?? 0) > 0 ? priorResult.notes : [summary],
      taskCounts: progress,
      remainingTasks: progress.remaining,
    };

    await this.updateSupportFiles(project, completedResult);
    await removeIfExists(repoStatePaths.executionControlFile);
    await removeIfExists(repoStatePaths.executionResultFile);
    await writeLatestSummary(repoStatePaths, summary);
    await this.closeSession(project.execution?.sessionKey);

    const completed = await this.stateStore.updateProject(this.channelKey, (current) => ({
      ...current,
      status: "done",
      phase: "validating",
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: undefined,
      currentTask: undefined,
      taskCounts: progress,
      latestSummary: summary,
      execution: undefined,
      lastExecution: completedResult,
      lastExecutionAt: completedResult.timestamp,
    }));

    await this.notify(
      completed,
      buildCompletionCardMessage(completed, progress, completedResult.changedFiles),
      `work-complete:${completed.changeName}:${completedResult.timestamp}`,
    );
  }

  /**
   * Shared terminal condition dispatch for cancel/pause/blocked.
   * Returns true if a terminal condition was handled (caller should return false).
   */
  private async dispatchTerminalResult(
    latest: ProjectState,
    result: ExecutionResult,
    requestedCancel: boolean,
    requestedPause: boolean,
  ): Promise<boolean> {
    if (requestedCancel || result.status === "cancelled") {
      await this.finalizeCancellation(latest, result);
      return true;
    }
    if (requestedPause || result.status === "paused") {
      await this.pauseProject(latest, result.summary, result);
      return true;
    }
    if (result.status === "blocked") {
      await this.blockProject(latest, result.blocker ?? result.summary, result);
      return true;
    }
    return false;
  }

  private async recoverWorkerFailureIfNeeded(
    runningProject: ProjectState,
    latest: ProjectState,
    repoStatePaths: ReturnType<typeof getRepoStatePaths>,
    runError: unknown,
    result: ExecutionResult,
    requestedCancel: boolean,
    requestedPause: boolean,
  ): Promise<boolean> {
    if (!runError || requestedCancel || requestedPause) {
      return false;
    }

    const persisted = await readExecutionResult(repoStatePaths.executionResultFile);
    if (persisted) {
      return false;
    }

    const failureMessage = runError instanceof Error ? runError.message : String(runError ?? "");
    if (!isRecoverableAcpFailure(failureMessage)) {
      return false;
    }

    const current = await this.stateStore.getActiveProject(this.channelKey) ?? latest;
    const action = current.execution?.action ?? runningProject.execution?.action ?? "work";
    const workerSlot = current.execution?.workerSlot ?? runningProject.execution?.workerSlot ?? "primary";
    const workerAgentId = resolveWorkerAgent(current, this.acpClient.agentId);
    const restartCount = Math.max(current.execution?.restartCount ?? runningProject.execution?.restartCount ?? 0, 0) + 1;
    const truncatedFailure = truncateFailureMessage(failureMessage);
    if (restartCount > MAX_WORKER_RESTART_ATTEMPTS) {
      const blocker = `Blocked after ${MAX_WORKER_RESTART_ATTEMPTS} ACP restart attempts. Last failure: ${truncatedFailure}`;
      const blockedResult: ExecutionResult = {
        version: 1,
        changeName: current.changeName ?? runningProject.changeName ?? "",
        mode: current.execution?.mode ?? runningProject.execution?.mode ?? result.mode ?? "apply",
        status: "blocked",
        timestamp: new Date().toISOString(),
        summary: blocker,
        progressMade: false,
        completedTask: result.completedTask,
        currentArtifact: result.currentArtifact,
        changedFiles: result.changedFiles,
        notes: [
          blocker,
          ...(result.notes ?? []).filter((note) => note.trim().length > 0).slice(0, 3),
        ],
        blocker,
        taskCounts: current.taskCounts ?? result.taskCounts,
        remainingTasks: current.taskCounts?.remaining ?? result.remainingTasks,
      };
      await this.blockProject(current, blocker, blockedResult);
      return true;
    }
    const restartAt = new Date().toISOString();
    const delayMs = computeWorkerRestartDelayMs(restartCount);
    const sessionKey = createWorkerSessionKey(current, {
      workerSlot,
      workerAgentId,
      attemptKey: restartAt,
    });
    const nextDetail = action === "plan"
      ? current.execution?.currentArtifact ?? runningProject.execution?.currentArtifact ?? "the next planning artifact"
      : current.execution?.currentTaskId ?? runningProject.execution?.currentTaskId ?? "the next task";
    const summary = action === "plan"
      ? `Planning worker session exited unexpectedly. Restarting ACP worker for ${current.changeName}.`
      : `Implementation worker session exited unexpectedly. Restarting ACP worker for ${current.changeName}.`;
    const restartMessage = buildWorkerRestartMessage({
      action,
      restartCount,
      failureMessage,
      nextDetail,
      delayMs,
    });

    await this.closeSession(current.execution?.sessionKey ?? runningProject.execution?.sessionKey);
    await removeIfExists(repoStatePaths.executionControlFile);
    await removeIfExists(repoStatePaths.executionResultFile);
    await writeLatestSummary(repoStatePaths, summary);

    const recovered = await this.stateStore.updateProject(this.channelKey, (project) => ({
      ...project,
      status: action === "plan" ? "planning" : "armed",
      phase: action === "plan" ? "planning_sync" : "implementing",
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: undefined,
      latestSummary: summary,
      lastExecution: result,
      lastExecutionAt: result.timestamp,
      execution: {
        mode: project.execution?.mode ?? runningProject.execution?.mode ?? "apply",
        action,
        state: "armed",
        workerAgentId,
        workerSlot,
        armedAt: restartAt,
        startedAt: undefined,
        sessionKey,
        triggerPrompt: project.execution?.triggerPrompt ?? runningProject.execution?.triggerPrompt,
        lastTriggerAt: project.execution?.lastTriggerAt ?? runningProject.execution?.lastTriggerAt ?? restartAt,
        currentArtifact: action === "plan"
          ? (project.execution?.currentArtifact ?? runningProject.execution?.currentArtifact)
          : undefined,
        currentTaskId: action === "work"
          ? (project.execution?.currentTaskId ?? runningProject.execution?.currentTaskId)
          : undefined,
        lastHeartbeatAt: undefined,
        restartCount,
        lastRestartAt: restartAt,
        lastFailure: truncatedFailure,
      },
    }));

    await this.writeExecutionControl(this.channelKey);
    await this.notify(
      recovered,
      buildWatcherStatusMessage(
        "↻",
        recovered,
        restartMessage,
        recovered.taskCounts,
      ),
      `worker-restart:${recovered.changeName}:${action}:${restartCount}:${restartAt}`,
    );
    this.kick(delayMs);
    return true;
  }

  private async setRunningState(
    project: ProjectState,
    patch: {
      action: ProjectExecutionState["action"];
      currentArtifact?: string;
      currentTaskId?: string;
      workerSlot?: string;
    },
  ): Promise<ProjectState> {
    const startedAt = new Date().toISOString();
    const workerSlot = patch.workerSlot ?? project.execution?.workerSlot ?? "primary";
    const workerAgentId = resolveWorkerAgent(project, this.acpClient.agentId);
    const sessionKey = project.execution?.sessionKey ?? createWorkerSessionKey(project, {
      workerSlot,
      workerAgentId,
      attemptKey: startedAt,
    });
    const updated = await this.stateStore.updateProject(this.channelKey, (current) => ({
      ...current,
      status: current.status === "planning" ? "planning" : "running",
      phase: current.status === "planning" || patch.action === "plan" ? "planning_sync" : "implementing",
      execution: {
        mode: current.execution?.mode ?? "apply",
        action: patch.action,
        state: "running",
        workerAgentId,
        workerSlot,
        armedAt: current.execution?.armedAt ?? startedAt,
        startedAt,
        sessionKey,
        backendId: current.execution?.backendId,
        triggerPrompt: current.execution?.triggerPrompt,
        lastTriggerAt: current.execution?.lastTriggerAt ?? startedAt,
        currentArtifact: patch.currentArtifact,
        currentTaskId: patch.currentTaskId,
        lastHeartbeatAt: startedAt,
        restartCount: current.execution?.restartCount,
        lastRestartAt: current.execution?.lastRestartAt,
        lastFailure: current.execution?.lastFailure,
      },
    }));
    await this.writeExecutionControl(this.channelKey);
    return updated;
  }

  private async touchHeartbeat(channelKey: string): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.stateStore.updateProject(channelKey, (current) => ({
      ...current,
      execution: current.execution
        ? {
            ...current.execution,
            lastHeartbeatAt: timestamp,
          }
        : current.execution,
    }));
  }

  private async pauseProject(project: ProjectState, summary: string, result?: ExecutionResult): Promise<void> {
    const repoStatePaths = getRepoStatePaths(project.repoPath!, this.archiveDirName);
    const resolved = result ?? await this.resolveExecutionResult(
      project,
      repoStatePaths,
      "paused",
      {
        summary,
        progressMade: false,
        notes: [summary],
        taskCounts: await loadTaskCounts(project),
      },
    );

    if (!result) {
      await this.updateSupportFiles(project, resolved);
    }

    await removeIfExists(repoStatePaths.executionControlFile);
    await removeIfExists(repoStatePaths.executionResultFile);
    await this.closeSession(project.execution?.sessionKey);

    const paused = await this.stateStore.updateProject(this.channelKey, (current) => ({
      ...current,
      status: "paused",
      phase: current.execution?.action === "plan" || current.phase === "planning_sync"
        ? "planning_sync"
        : "implementing",
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: undefined,
      taskCounts: resolved.taskCounts ?? current.taskCounts,
      latestSummary: resolved.summary,
      execution: undefined,
      lastExecution: resolved,
      lastExecutionAt: resolved.timestamp,
    }));
    await this.notify(
      paused,
      buildWatcherStatusMessage("⏸", paused, "Execution paused. Next: use `/clawspec continue` when you want the worker to resume.", paused.taskCounts),
      `paused:${paused.changeName}:${resolved.timestamp}:${paused.phase}`,
    );
  }

  private async blockProject(project: ProjectState, summary: string, result?: ExecutionResult): Promise<void> {
    const repoStatePaths = getRepoStatePaths(project.repoPath!, this.archiveDirName);
    const resolved = result ?? await this.resolveExecutionResult(
      project,
      repoStatePaths,
      "blocked",
      {
        summary,
        progressMade: false,
        notes: [summary],
        blocker: summary,
        taskCounts: await loadTaskCounts(project),
      },
    );

    if (!result) {
      await this.updateSupportFiles(project, resolved);
    }

    await removeIfExists(repoStatePaths.executionControlFile);
    await removeIfExists(repoStatePaths.executionResultFile);
    await this.closeSession(project.execution?.sessionKey);

    const blocked = await this.stateStore.updateProject(this.channelKey, (current) => ({
      ...current,
      status: "blocked",
      phase: current.execution?.action === "plan" || current.phase === "planning_sync"
        ? "planning_sync"
        : "implementing",
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: resolved.blocker ?? summary,
      taskCounts: resolved.taskCounts ?? current.taskCounts,
      latestSummary: resolved.summary,
      execution: undefined,
      lastExecution: resolved,
      lastExecutionAt: resolved.timestamp,
    }));
    const blockedReasonText = buildBlockedDisplayReason(resolved.blocker ?? summary);
    const nextStep = buildBlockedNextStep(blocked, resolved.blocker ?? summary);
    await this.notify(
      blocked,
      buildWatcherStatusMessage(
        "⚠",
        blocked,
        `Blocked: ${blockedReasonText} Next: ${nextStep}`,
        blocked.taskCounts,
      ),
      `blocked:${blocked.changeName}:${resolved.timestamp}`,
    );
  }

  private async finalizeCancellation(project: ProjectState, result?: ExecutionResult): Promise<void> {
    const repoStatePaths = getRepoStatePaths(project.repoPath!, this.archiveDirName);
    const resolved = result ?? await this.resolveExecutionResult(
      project,
      repoStatePaths,
      "cancelled",
      {
        summary: `Cancelled change ${project.changeName}.`,
        progressMade: false,
        notes: [`Cancelled change ${project.changeName}.`],
        taskCounts: await loadTaskCounts(project),
      },
    );

    const rollbackStore = new RollbackStore(project.repoPath!, this.archiveDirName, project.changeName!);
    await rollbackStore.restoreTouchedFiles().catch(() => undefined);
    await removeIfExists(getChangeDir(project.repoPath!, project.changeName!));
    await rollbackStore.clear().catch(() => undefined);
    await clearRuntimeFiles(repoStatePaths);
    await resetRunSupportFiles(repoStatePaths, `Cancelled change ${project.changeName}.`);
    await this.closeSession(project.execution?.sessionKey);

    const cancelled = await this.stateStore.updateProject(this.channelKey, (current) => ({
      ...current,
      status: "idle",
      phase: "cancelling",
      changeName: undefined,
      changeDir: undefined,
      description: undefined,
      pauseRequested: false,
      cancelRequested: false,
      blockedReason: undefined,
      currentTask: undefined,
      taskCounts: undefined,
      latestSummary: `Cancelled change ${project.changeName}.`,
      execution: undefined,
      lastExecution: resolved,
      lastExecutionAt: resolved.timestamp,
      planningJournal: {
        dirty: false,
        entryCount: 0,
      },
      rollback: undefined,
    }));
    await this.notify(
      cancelled,
      `Cancelled ${project.changeName}.`,
      `cancelled:${project.changeName}:${resolved.timestamp}`,
    );
  }

  private async resolveExecutionResult(
    project: ProjectState,
    repoStatePaths: ReturnType<typeof getRepoStatePaths>,
    fallbackStatus: ExecutionResultStatus,
    fallback: Partial<ExecutionResult>,
  ): Promise<ExecutionResult> {
    const persisted = await readExecutionResult(repoStatePaths.executionResultFile);
    const taskCounts = persisted?.taskCounts ?? fallback.taskCounts ?? await loadTaskCounts(project);

    if (persisted && persisted.changeName === project.changeName) {
      return {
        ...persisted,
        changedFiles: persisted.changedFiles.map((entry) => normalizeSlashes(entry).replace(/^\.\//, "")),
        taskCounts,
        remainingTasks: persisted.remainingTasks ?? taskCounts?.remaining,
      };
    }

    const latestSummary = ((await tryReadUtf8(repoStatePaths.latestSummaryFile)) ?? "").trim();
    const summary = fallback.summary ?? latestSummary ?? `Execution finished without ${repoStatePaths.executionResultFile}.`;
    return {
      version: 1,
      changeName: project.changeName ?? "",
      mode: project.execution?.mode ?? "apply",
      status: fallbackStatus,
      timestamp: new Date().toISOString(),
      summary,
      progressMade: fallback.progressMade ?? false,
      completedTask: fallback.completedTask,
      currentArtifact: fallback.currentArtifact,
      changedFiles: (fallback.changedFiles ?? []).map((entry) => normalizeSlashes(entry).replace(/^\.\//, "")),
      notes: fallback.notes ?? (latestSummary ? [latestSummary] : []),
      blocker: fallback.blocker,
      taskCounts,
      remainingTasks: fallback.remainingTasks ?? taskCounts?.remaining,
    };
  }

  private async writeExecutionControl(channelKey: string): Promise<void> {
    const project = await this.stateStore.getActiveProject(channelKey);
    if (!project?.repoPath || !project.changeName || !project.execution) {
      return;
    }
    const repoStatePaths = getRepoStatePaths(project.repoPath, this.archiveDirName);
    const control: ExecutionControlFile = {
      version: 1,
      changeName: project.changeName,
      mode: project.execution.mode,
      state: project.execution.state,
      armedAt: project.execution.armedAt,
      startedAt: project.execution.startedAt,
      sessionKey: project.execution.sessionKey,
      pauseRequested: project.pauseRequested,
      cancelRequested: project.cancelRequested === true,
    };
    await writeJsonFile(repoStatePaths.executionControlFile, control);
  }

  private async updateSupportFiles(project: ProjectState, result: ExecutionResult): Promise<void> {
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

    await mergeChangedFiles(repoStatePaths.changedFilesFile, result.changedFiles);
    if (result.notes.length > 0) {
      const notesBlock = [
        `## ${result.timestamp}`,
        "",
        ...result.notes.map((note) => `- ${note}`),
        "",
      ].join("\n");
      await appendUtf8(repoStatePaths.decisionLogFile, `${notesBlock}\n`);
    }

    await writeLatestSummary(repoStatePaths, result.summary);

    if (project.changeName && result.changedFiles.length > 0) {
      const rollbackStore = new RollbackStore(project.repoPath, this.archiveDirName, project.changeName);
      if (await rollbackStore.readManifest()) {
        await rollbackStore.recordTouchedFiles(result.changedFiles);
      }
    }
  }

  private async notify(project: ProjectState, text: string, notificationKey: string): Promise<void> {
    const latest = await this.stateStore.getActiveProject(this.channelKey);
    if (latest?.lastNotificationKey === notificationKey) {
      return;
    }
    if (latest?.lastNotificationText === text) {
      return;
    }
    await this.notifier.send(project.channelKey, text);
    await this.stateStore.updateProject(this.channelKey, (current) => ({
      ...current,
      lastNotificationKey: notificationKey,
      lastNotificationText: text,
    }));
  }

  private async closeSession(sessionKey?: string): Promise<void> {
    if (!sessionKey) {
      return;
    }
    await this.acpClient.closeSession(sessionKey);
  }

  private async describeNextPlanningStep(project: ProjectState): Promise<string> {
    if (!project.repoPath || !project.changeName) {
      return "wait for the next planning check.";
    }

    try {
      const status = (await this.openSpec.status(project.repoPath, project.changeName)).parsed!;
      const artifactsById = new Map(status.artifacts.map((artifact) => [artifact.id, artifact]));
      const requiredIds = status.applyRequires.length > 0
        ? status.applyRequires
        : status.artifacts.map((artifact) => artifact.id);
      const pendingRequiredIds = requiredIds.filter((artifactId) => artifactsById.get(artifactId)?.status !== "done");

      if (pendingRequiredIds.length === 0) {
        const apply = (await this.openSpec.instructionsApply(project.repoPath, project.changeName)).parsed!;
        if (apply.state === "blocked") {
          return "planning is almost done, but apply readiness still needs attention.";
        }
        if (apply.state === "all_done" || apply.progress.remaining === 0) {
          return "all tasks are already complete.";
        }
        return "run `cs-work` when you want implementation to start.";
      }

      const nextReadyArtifact = status.artifacts.find((artifact) =>
        pendingRequiredIds.includes(artifact.id) && artifact.status === "ready")
        ?? status.artifacts.find((artifact) => artifact.status === "ready");
      if (nextReadyArtifact) {
        return `build ${nextReadyArtifact.id}.`;
      }

      return `wait until ${pendingRequiredIds[0]} becomes ready.`;
    } catch (error) {
      this.logger.warn(
        `[clawspec] failed to describe next planning step for ${project.changeName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "wait for the next planning check.";
    }
  }
}

function shouldWatchProject(project: ProjectState): boolean {
  const hasBackgroundExecution = project.execution?.state === "armed" || project.execution?.state === "running";
  return Boolean(
    project.repoPath
    && project.changeName
    && (
      hasBackgroundExecution
      || (project.pauseRequested && project.execution)
      || (project.cancelRequested && project.execution)
    ),
  );
}

function resolveWorkerAgent(project: ProjectState, fallbackAgentId: string): string {
  return project.execution?.workerAgentId ?? project.workerAgentId ?? fallbackAgentId;
}

function nextTaskLabel(apply: OpenSpecApplyInstructionsResponse): string | undefined {
  const nextTask = apply.tasks.find((task) => !task.done);
  return nextTask ? `${nextTask.id} ${nextTask.description}` : undefined;
}

function summarizeChangedFiles(changedFiles: string[]): string {
  if (changedFiles.length === 0) {
    return "";
  }
  const preview = changedFiles.slice(0, 2).join(", ");
  return ` Files: ${preview}${changedFiles.length > 2 ? ", ..." : ""}`;
}

function describeNextTask(apply: OpenSpecApplyInstructionsResponse): string {
  const nextTask = apply.tasks.find((task) => !task.done);
  return nextTask ? `${nextTask.id} ${nextTask.description}` : "finish the change.";
}

function describeFollowingTask(apply: OpenSpecApplyInstructionsResponse, currentTaskId: string): string {
  const currentIndex = apply.tasks.findIndex((task) => task.id === currentTaskId);
  if (currentIndex === -1) {
    return "complete this task, then re-check the remaining queue.";
  }

  const nextTask = apply.tasks.slice(currentIndex + 1).find((task) => !task.done);
  return nextTask
    ? `${nextTask.id} ${nextTask.description} after this task completes.`
    : "finish this task, then perform the final completion check.";
}

function toRepoRelative(project: ProjectState, targetPath: string): string {
  if (!project.repoPath) {
    return normalizeSlashes(targetPath);
  }
  return normalizeSlashes(toPosixRelative(project.repoPath, resolveProjectScopedPath(project, targetPath)));
}

async function ensureSupportFiles(repoStatePaths: ReturnType<typeof getRepoStatePaths>): Promise<void> {
  await ensureDir(repoStatePaths.root);
  if (!(await pathExists(repoStatePaths.progressFile))) {
    await writeUtf8(repoStatePaths.progressFile, "# Progress\n");
  }
  if (!(await pathExists(repoStatePaths.workerProgressFile))) {
    await writeUtf8(repoStatePaths.workerProgressFile, "");
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

function orderedPlanningArtifactIds(artifactIds: string[]): string[] {
  const preferredOrder = ["proposal", "specs", "design", "tasks"];
  const uniqueArtifactIds = Array.from(new Set(artifactIds));
  const ordered = preferredOrder.filter((artifactId) => uniqueArtifactIds.includes(artifactId));
  const extras = uniqueArtifactIds.filter((artifactId) => !preferredOrder.includes(artifactId));
  return ordered.concat(extras);
}

function nextPlanningArtifactId(artifactIds: string[], currentArtifact?: string): string | undefined {
  if (artifactIds.length === 0) {
    return undefined;
  }
  if (!currentArtifact) {
    return artifactIds[0];
  }
  const currentIndex = artifactIds.indexOf(currentArtifact);
  if (currentIndex === -1) {
    return artifactIds[0];
  }
  return artifactIds[currentIndex + 1];
}

async function clearRuntimeFiles(repoStatePaths: ReturnType<typeof getRepoStatePaths>): Promise<void> {
  await removeIfExists(repoStatePaths.executionControlFile);
  await removeIfExists(repoStatePaths.executionResultFile);
  await removeIfExists(repoStatePaths.workerProgressFile);
  await removeIfExists(repoStatePaths.planningJournalFile);
  await removeIfExists(repoStatePaths.planningJournalSnapshotFile);
  await removeIfExists(repoStatePaths.rollbackManifestFile);
}

async function resetRunSupportFiles(
  repoStatePaths: ReturnType<typeof getRepoStatePaths>,
  latestSummary: string,
): Promise<void> {
  await ensureDir(repoStatePaths.root);
  await writeUtf8(repoStatePaths.progressFile, "# Progress\n");
  await writeUtf8(repoStatePaths.workerProgressFile, "");
  await writeUtf8(repoStatePaths.changedFilesFile, "# Changed Files\n");
  await writeUtf8(repoStatePaths.decisionLogFile, "# Decision Log\n");
  await writeUtf8(repoStatePaths.latestSummaryFile, `${latestSummary}\n`);
}

async function writeLatestSummary(
  repoStatePaths: ReturnType<typeof getRepoStatePaths>,
  summary: string,
): Promise<void> {
  await writeUtf8(repoStatePaths.latestSummaryFile, `${summary}\n`);
}

async function mergeChangedFiles(filePath: string, changedFiles: string[]): Promise<void> {
  const existing = ((await tryReadUtf8(filePath)) ?? "")
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
  await writeUtf8(filePath, `${body}\n`);
}

async function loadTaskCounts(project: ProjectState): Promise<TaskCountSummary | undefined> {
  if (!project.repoPath || !project.changeName) {
    return project.taskCounts;
  }
  const tasksPath = getTasksPath(project.repoPath, project.changeName);
  if (!(await pathExists(tasksPath))) {
    return project.taskCounts;
  }
  return (await parseTasksFile(tasksPath)).counts;
}

async function loadTaskSnapshot(project: ProjectState): Promise<{
  counts: TaskCountSummary;
  nextTask?: { taskId: string; description: string };
} | undefined> {
  if (!project.repoPath || !project.changeName) {
    return undefined;
  }
  const tasksPath = getTasksPath(project.repoPath, project.changeName);
  if (!(await pathExists(tasksPath))) {
    return undefined;
  }
  const parsed = await parseTasksFile(tasksPath);
  const nextTask = getNextIncompleteTask(parsed);
  return {
    counts: parsed.counts,
    nextTask: nextTask
      ? {
          taskId: nextTask.taskId,
          description: nextTask.description,
        }
      : undefined,
  };
}

function needsStartupRecovery(project: ProjectState): boolean {
  if (!project.repoPath || !project.changeName) {
    return false;
  }
  if (isRecoverableBlockedProject(project)) {
    return true;
  }
  const activeStatuses: ProjectState["status"][] = ["armed", "running", "planning"];
  if (!project.execution) {
    return project.phase === "implementing" && activeStatuses.includes(project.status);
  }
  if (!activeStatuses.includes(project.status) && project.execution.state !== "armed" && project.execution.state !== "running") {
    return false;
  }
  if (project.execution.state === "armed" || project.execution.state === "running") {
    return true;
  }
  return project.execution.action === "plan" && project.phase === "planning_sync";
}

function isRecoverableBlockedProject(project: ProjectState): boolean {
  if (project.status !== "blocked" || project.execution) {
    return false;
  }
  const recoverablePhases: ProjectState["phase"][] = ["implementing", "planning_sync"];
  if (!recoverablePhases.includes(project.phase)) {
    return false;
  }
  const candidates = [
    project.blockedReason,
    project.lastExecution?.blocker,
    project.lastExecution?.summary,
    ...(project.lastExecution?.notes ?? []),
  ];
  return candidates.some((entry) => typeof entry === "string" && isRecoverableAcpFailure(entry));
}

function isRecoverableAcpFailure(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return [
    /acpx exited/,
    /acpruntimeerror/,
    /acp runtime backend is currently unavailable/,
    /backend is currently unavailable/,
    /failed to ensure session/,
    /session .*?(closed|missing|not found|expired|invalid)/,
    /\bfetch failed\b/,
    /\btimeout\b/,
    /\btimed out\b/,
    /\baborted\b/,
    /worker session became unavailable/,
    /\becconnreset\b/,
    /\beconnrefused\b/,
    /\bepipe\b/,
    /socket hang up/,
    /connection .*?(reset|closed|refused)/,
    /\bnetwork\b/,
    /surface_error/,
  ].some((pattern) => pattern.test(normalized));
}

function isUnavailableAcpBackendFailure(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return [
    /acp runtime backend is currently unavailable/,
    /backend is currently unavailable/,
    /no acp runtime backend/,
    /failed to resolve acp runtime backend/,
    /acpx .*?(not found|not installed|not enabled|unavailable)/,
  ].some((pattern) => pattern.test(normalized));
}

function buildAcpSetupHint(action: ProjectExecutionState["action"]): string {
  return action === "plan"
    ? "Enable `plugins.entries.acpx` + backend `acpx`; install/load `acpx` if needed; rerun `cs-plan`."
    : "Enable `plugins.entries.acpx` + backend `acpx`; install/load `acpx` if needed; rerun `cs-work`.";
}

function buildBlockedNextStep(project: ProjectState, blocker: string): string {
  const action: ProjectExecutionState["action"] =
    project.execution?.action === "plan" || project.phase === "planning_sync"
      ? "plan"
      : "work";
  if (isUnavailableAcpBackendFailure(blocker)) {
    return buildAcpSetupHint(action);
  }
  return action === "plan"
    ? "fix the planning issue, then run `cs-plan` or `/clawspec continue`."
    : "fix the implementation issue, then run `cs-work` or `/clawspec continue`.";
}

function buildBlockedDisplayReason(blocker: string): string {
  if (isUnavailableAcpBackendFailure(blocker)) {
    return "ACPX backend unavailable.";
  }
  return blocker;
}

function buildWorkerRestartMessage(params: {
  action: ProjectExecutionState["action"];
  restartCount: number;
  failureMessage: string;
  nextDetail: string;
  delayMs: number;
}): string {
  if (isUnavailableAcpBackendFailure(params.failureMessage)) {
    return `Worker restarted (attempt ${params.restartCount}), but ACPX is unavailable. Next: enable \`plugins.entries.acpx\` and backend \`acpx\`, or install/load \`acpx\`.`;
  }
  const retryDelaySeconds = Math.ceil(params.delayMs / 1000);
  return `Worker restarted (attempt ${params.restartCount}). Next: retry ${params.nextDetail} in ${retryDelaySeconds}s.`;
}

function computeWorkerRestartDelayMs(restartCount: number): number {
  const safeCount = Math.max(1, restartCount);
  return Math.min(30_000, 1_000 * 2 ** Math.min(4, safeCount - 1));
}

function deriveCountsFromWorkerEvent(
  currentCounts: TaskCountSummary | undefined,
  event: WorkerProgressEvent,
): TaskCountSummary | undefined {
  const total = event.total ?? currentCounts?.total;
  if (!total || total <= 0) {
    return currentCounts;
  }

  const ordinal = event.current ?? inferTaskOrdinal(event.taskId);
  if (!ordinal || ordinal <= 0) {
    return currentCounts ?? {
      total,
      complete: 0,
      remaining: total,
    };
  }

  const complete = event.kind === "task_done"
    ? Math.min(total, ordinal)
    : Math.min(total, Math.max(0, ordinal - 1));
  return {
    total,
    complete,
    remaining: Math.max(0, total - complete),
  };
}

function asWorkerEventTimestamp(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function isDeadAcpRuntimeStatus(
  status: Awaited<ReturnType<AcpWorkerClient["getSessionStatus"]>>,
): boolean {
  const rawState = status?.details?.status;
  return typeof rawState === "string" && rawState.trim().toLowerCase() === "dead";
}

function describeDeadWorkerStatus(
  status: Awaited<ReturnType<AcpWorkerClient["getSessionStatus"]>>,
): string | undefined {
  if (!status) {
    return undefined;
  }

  const detailSummary = typeof status.details?.summary === "string"
    ? status.details.summary.trim()
    : "";
  if (detailSummary) {
    return `ACP worker session became unavailable: ${detailSummary}`;
  }

  const summary = typeof status.summary === "string" ? status.summary.trim() : "";
  return summary ? `ACP worker session became unavailable: ${summary}` : undefined;
}

function isQueueOwnerUnavailableStatus(
  status: Awaited<ReturnType<AcpWorkerClient["getSessionStatus"]>>,
): boolean {
  if (!status) {
    return false;
  }

  const detailSummary = typeof status.details?.summary === "string"
    ? status.details.summary.trim().toLowerCase()
    : "";
  if (detailSummary.includes("queue owner unavailable")) {
    return true;
  }

  const summary = typeof status.summary === "string" ? status.summary.trim().toLowerCase() : "";
  return summary.includes("queue owner unavailable");
}

export function shouldAbortWorkerStartup(
  status: Awaited<ReturnType<AcpWorkerClient["getSessionStatus"]>>,
): boolean {
  if (!status) {
    return true;
  }
  if (isQueueOwnerUnavailableStatus(status)) {
    return false;
  }
  return isDeadAcpRuntimeStatus(status);
}

export function describeWorkerStartupTimeout(
  status: Awaited<ReturnType<AcpWorkerClient["getSessionStatus"]>>,
): string | undefined {
  if (!status) {
    return "ACP worker startup timed out before the runtime reported status or progress.";
  }
  if (isQueueOwnerUnavailableStatus(status)) {
    return undefined;
  }
  if (isDeadAcpRuntimeStatus(status)) {
    return describeDeadWorkerStatus(status);
  }
  return undefined;
}

function isMeaningfulAcpRuntimeEvent(event: AcpRuntimeEvent): boolean {
  if (event.type === "text_delta") {
    return typeof event.text === "string" && event.text.trim().length > 0;
  }
  if (event.type === "tool_call") {
    return true;
  }
  if (event.type === "done") {
    return true;
  }
  return false;
}

function truncateFailureMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized.length <= 160) {
    return normalized;
  }
  return `${normalized.slice(0, 157)}...`;
}

async function cleanupTmpFiles(dirPath: string): Promise<void> {
  const files = await listDirectoryFiles(dirPath);
  for (const filePath of files) {
    if (filePath.endsWith(".tmp")) {
      await removeIfExists(filePath);
    }
  }
}

async function writeExecutionControlFile(
  controlFilePath: string,
  project: ProjectState,
): Promise<void> {
  const execution = project.execution;
  await writeJsonFile(controlFilePath, {
    version: 1,
    changeName: project.changeName ?? "",
    mode: execution?.mode ?? "apply",
    state: execution?.state ?? "armed",
    armedAt: execution?.armedAt ?? new Date().toISOString(),
    startedAt: execution?.startedAt,
    sessionKey: execution?.sessionKey ?? project.boundSessionKey,
    pauseRequested: project.pauseRequested,
    cancelRequested: project.cancelRequested === true,
  });
}

const ACTIVITY_NOTIFY_INTERVAL_MS = 30_000;
const ACTIVITY_TEXT_MAX_LENGTH = 140;
const WORKER_STATUS_POLL_INTERVAL_MS = 1_000;
const DEAD_SESSION_GRACE_MS = 2_000;
const WORKER_STARTUP_GRACE_MS = 20_000;
const RUN_TURN_SETTLE_GRACE_MS = 1_500;
const MAX_WORKER_RESTART_ATTEMPTS = 10;

type ActivityTracker = {
  track(event: { type: string; title?: string }): string | null;
};

function createActivityTracker(): ActivityTracker {
  let lastNotifyAt = 0;

  return {
    track(event: { type: string; title?: string }): string | null {
      if (event.type !== "tool_call" || !event.title) {
        return null;
      }
      const now = Date.now();
      if (now - lastNotifyAt < ACTIVITY_NOTIFY_INTERVAL_MS) {
        return null;
      }
      lastNotifyAt = now;
      return formatToolActivity(event.title);
    },
  };
}

function formatToolActivity(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const target = extractActivityTarget(normalized);

  if (/\b(writ|creat|new file)\b/i.test(lower)) {
    return `✍️ Write ${target ?? "file"}`;
  }
  if (/\b(read|view|open|cat|head)\b/i.test(lower)) {
    return `👀 Read ${target ?? "file"}`;
  }
  if (/\b(edit|updat|modif|replac|patch)\b/i.test(lower)) {
    return `✏️ Edit ${target ?? "file"}`;
  }
  if (/\b(test|assert|spec|jest|vitest)\b/i.test(lower)) {
    return "🧪 Run tests";
  }
  if (/\b(search|grep|find|glob)\b/i.test(lower)) {
    return `🔎 Search ${target ?? "files"}`;
  }
  if (/\b(delet|remov|rm)\b/i.test(lower)) {
    return `🗑️ Remove ${target ?? "file"}`;
  }
  if (/\b(run|exec|bash|shell|command|npm|node|powershell|pwsh|python|git|openspec|acpx)\b/i.test(lower)) {
    return `▶️ ${summarizeCommandActivity(lower)}`;
  }

  const truncated = normalized.length > ACTIVITY_TEXT_MAX_LENGTH
    ? `${normalized.slice(0, ACTIVITY_TEXT_MAX_LENGTH)}...`
    : normalized;
  return `⚙️ ${truncated}`;
}

function formatTaskStart(
  task: { id: string; description: string },
  progress: TaskCountSummary,
  followUp: string,
): string {
  return `▶️ Task ${task.id} (${progress.complete}/${progress.total}). ${shortenActivityText(task.description)} Next: ${shortenActivityText(followUp)}`;
}

function formatBatchTaskStart(
  projectName: string,
  changeName: string,
  tasks: Array<{ id: string; description: string }>,
  progress: TaskCountSummary,
): string {
  const nextTask = tasks[0];
  const nextLabel = nextTask ? `${nextTask.id} ${shortenActivityText(nextTask.description, 88)}` : "waiting for the next task";
  return `${projectName} / ${changeName} ▶️ Start ${tasks.length} task${tasks.length === 1 ? "" : "s"} (${progress.complete}/${progress.total}). Next: ${nextLabel}`;
}

function formatTaskDone(
  projectName: string,
  changeName: string,
  task: { id: string; description: string },
  progress: TaskCountSummary,
  changedFiles: string[],
  nextTaskMessage: string,
): string {
  const parts = [
    `${projectName} / ${changeName} ✅ Done ${task.id} (${progress.complete}/${progress.total}).`,
    shortenActivityText(task.description, 88),
  ];
  if (changedFiles.length > 0) {
    const preview = changedFiles.slice(0, 2).join(", ");
    parts.push(`Files: ${preview}${changedFiles.length > 2 ? ", ..." : ""}.`);
  }
  parts.push(`Next: ${shortenActivityText(nextTaskMessage, 88)}`);
  return parts.join(" ");
}

function formatActivityUpdate(projectName: string, changeName: string, activity: string): string {
  return `${projectName} / ${changeName} ${activity}`;
}

function summarizeCommandActivity(lower: string): string {
  if (/\bopenspec\b/.test(lower)) {
    return "Run openspec";
  }
  if (/\bacpx\b/.test(lower)) {
    return "Run acpx";
  }
  if (/\bgit\b/.test(lower)) {
    return "Run git";
  }
  if (/\bnpm\b/.test(lower)) {
    return "Run npm";
  }
  if (/\bnode\b/.test(lower)) {
    return "Run node";
  }
  if (/\bpython\b/.test(lower)) {
    return "Run python";
  }
  if (/\bpowershell\b|\bpwsh\b/.test(lower)) {
    return "Run PowerShell";
  }
  return "Run shell command";
}

function extractActivityTarget(title: string): string | undefined {
  const pathMatch = title.match(/([A-Za-z]:\\[^\s"'`]+|~?[\\/][^\s"'`]+|[A-Za-z0-9_.-]+[\\/][^\s"'`]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+)/);
  if (!pathMatch?.[1]) {
    return undefined;
  }
  const candidate = pathMatch[1].replace(/[),.;:]+$/, "");
  const windowsBase = path.win32.basename(candidate);
  const posixBase = path.posix.basename(candidate);
  const basename = windowsBase.length <= posixBase.length ? windowsBase : posixBase;
  if (!basename || basename === "." || basename === "..") {
    return undefined;
  }
  return basename;
}

type WorkerProgressEvent = {
  version?: number;
  timestamp?: string;
  kind?: string;
  taskId?: string;
  current?: number;
  total?: number;
  message?: string;
};

function parseWorkerProgressEvent(line: string): WorkerProgressEvent | undefined {
  try {
    const parsed = JSON.parse(line) as WorkerProgressEvent;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function formatWorkerProgressMessage(project: ProjectState, event: WorkerProgressEvent): string | undefined {
  const rawMessage = typeof event.message === "string" ? event.message : "";
  const message = shortenActivityText(rawMessage, 120);
  if (!message) {
    return undefined;
  }
  const icon = displayWatcherEventIcon(event.kind);
  const total = event.total ?? project.taskCounts?.total;
  const current = event.current ?? inferTaskOrdinal(event.taskId);
  const progress = total && current != null
    ? {
        total,
        complete: Math.min(Math.max(current, 0), total),
        remaining: Math.max(0, total - Math.min(Math.max(current, 0), total)),
      }
    : project.taskCounts;
  const parsed = parseWatcherMessageSections(message);
  return buildWatcherCard(icon, project, parsed.main, progress, parsed.detail, parsed.next);
}

function buildWatcherStatusMessage(
  icon: string,
  project: ProjectState,
  message: string,
  progress?: TaskCountSummary,
): string {
  const parsed = parseWatcherMessageSections(shortenActivityText(message, 140));
  return buildWatcherCard(icon, project, parsed.main, progress ?? project.taskCounts, parsed.detail, parsed.next);
}

function buildCompletionNotificationMessage(
  project: ProjectState,
  progress: TaskCountSummary,
  changedFiles: string[],
): string {
  const nextStep = isWatcherProjectContextAttached(project)
    ? "Next: add requirements and run `cs-plan`, or `/clawspec archive`."
    : "Next: use `cs-attach`, then `cs-plan`, or `/clawspec archive`.";
  const filesSummary = changedFiles.length > 0
    ? ` Changed ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}.`
    : "";
  return buildWatcherStatusMessage(
    "🏁",
    project,
    `All tasks complete.${filesSummary} ${nextStep}`,
    {
      total: progress.total,
      complete: progress.total,
      remaining: 0,
    },
  );
}

function isWatcherProjectContextAttached(project: ProjectState): boolean {
  return project.contextMode !== "detached";
}

function watcherEventIcon(kind?: string): string {
  switch (kind) {
    case "task_start":
      return "▶";
    case "task_done":
      return "✓";
    case "blocked":
      return "⚠";
    default:
      return "ℹ";
  }
}

function watcherProjectProgressMarker(progress?: TaskCountSummary): string {
  if (!progress) {
    return "";
  }
  return watcherCompactProgressMarker(progress.complete, progress.total);
}

function watcherCompactProgressMarker(current?: number, total?: number): string {
  if (current == null || !total || total <= 0) {
    return "";
  }
  const safeCurrent = Math.min(Math.max(current, 0), total);
  const slots = 6;
  let filled = Math.max(0, Math.min(slots, Math.round((safeCurrent / total) * slots)));
  if (safeCurrent > 0) {
    filled = Math.max(1, filled);
  }
  return `[${"#".repeat(filled)}${"-".repeat(slots - filled)}] ${safeCurrent}/${total}`;
}

function buildCompletionMessage(
  project: ProjectState,
  progress: TaskCountSummary,
  changedFiles: string[],
): string {
  const nextStep = isProjectContextAttached(project)
    ? "Next: add more requirements in chat and run `cs-plan`, or `/clawspec archive`."
    : "Next: use `cs-attach` before adding more requirements, or `/clawspec archive`.";
  const filesSummary = changedFiles.length > 0
    ? ` Changed ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}: ${changedFiles.slice(0, 2).join(", ")}${changedFiles.length > 2 ? ", ..." : ""}.`
    : "";
  return `🏁 ${compactProjectLabel(project)} ${compactProgressMarker(progress.total, progress.total)} Complete.${filesSummary} ${nextStep}`;
}

function workerEventIcon(kind?: string): string {
  switch (kind) {
    case "task_start":
      return "🛠";
    case "task_done":
      return "✅";
    case "blocked":
      return "⛔";
    default:
      return "ℹ️";
  }
}

function compactProjectLabel(project: ProjectState): string {
  const projectName = project.projectName ?? "project";
  const changeName = project.changeName ?? "change";
  return `${projectName}-${changeName}`;
}

function compactProgressMarker(current?: number, total?: number): string {
  if (!total || total <= 0 || !current || current <= 0) {
    return "";
  }
  const safeCurrent = Math.min(Math.max(current, 0), total);
  const slots = 6;
  const filled = Math.max(0, Math.min(slots, Math.round((safeCurrent / total) * slots)));
  return `[${"#".repeat(filled)}${"-".repeat(slots - filled)}] ${safeCurrent}/${total}`;
}

function inferTaskOrdinal(taskId?: string): number | undefined {
  if (!taskId) {
    return undefined;
  }
  const match = taskId.match(/^\d+/);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function shouldAnnounceExecutionStartup(project: ProjectState): boolean {
  return project.execution?.action === "work"
    && project.execution.state === "armed"
    && !project.execution.startedAt
    && project.lastExecution?.status !== "running";
}

function isTerminalExecutionStatus(status: ExecutionResultStatus): boolean {
  return status === "done" || status === "blocked" || status === "paused" || status === "cancelled";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortenActivityText(text: string, maxLength = ACTIVITY_TEXT_MAX_LENGTH): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildWatcherCard(
  icon: string,
  project: ProjectState,
  headline: string,
  progress?: TaskCountSummary,
  detail?: string,
  next?: string,
): string {
  const label = compactProjectLabel(project);
  const marker = watcherProjectProgressMarker(progress);
  const lines = [
    [icon, `**${label}**`, marker ? `\`${marker}\`` : ""].filter(Boolean).join(" "),
    shortenActivityText(headline, 120),
    detail ? shortenActivityText(detail, 120) : "",
    next ? `Next: ${shortenActivityText(next, 96)}` : "",
  ].filter((line) => line && line.trim().length > 0);
  return lines.join("\n");
}

function parseWatcherMessageSections(message: string): {
  main: string;
  detail?: string;
  next?: string;
} {
  const trimmed = message.trim();
  if (!trimmed) {
    return { main: "" };
  }

  const nextMatch = trimmed.match(/\s+Next:\s+(.+)$/i);
  const next = nextMatch?.[1]?.trim().replace(/[.]+$/, "");
  const withoutNext = nextMatch
    ? trimmed.slice(0, Math.max(0, nextMatch.index)).trim()
    : trimmed;

  const filesMatch = withoutNext.match(/\s+(Files?:|Changed \d+ files?:)\s+(.+)$/i);
  if (filesMatch?.index != null) {
    return {
      main: withoutNext.slice(0, filesMatch.index).trim(),
      detail: `${filesMatch[1]} ${filesMatch[2].trim()}`.replace(/[.]+$/, ""),
      next,
    };
  }

  const changedSentenceMatch = withoutNext.match(/^(.*?)(\s+Changed \d+ files?\..*)$/i);
  if (changedSentenceMatch) {
    return {
      main: changedSentenceMatch[1].trim(),
      detail: changedSentenceMatch[2].trim().replace(/^\s+/, "").replace(/[.]+$/, ""),
      next,
    };
  }

  return {
    main: withoutNext,
    next,
  };
}

function buildCompletionCardMessage(
  project: ProjectState,
  progress: TaskCountSummary,
  changedFiles: string[],
): string {
  const nextStep = isWatcherProjectContextAttached(project)
    ? "add requirements and run `cs-plan`, or `/clawspec archive`."
    : "use `cs-attach`, then `cs-plan`, or `/clawspec archive`.";
  return buildWatcherCard(
    "🏁",
    project,
    "All tasks complete.",
    {
      total: progress.total,
      complete: progress.total,
      remaining: 0,
    },
    changedFiles.length > 0
      ? `Changed ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}.`
      : undefined,
    nextStep,
  );
}

function displayWatcherEventIcon(kind?: string): string {
  switch (kind) {
    case "task_start":
      return "▶️";
    case "task_done":
      return "✅";
    case "blocked":
      return "⚠️";
    default:
      return "ℹ️";
  }
}
