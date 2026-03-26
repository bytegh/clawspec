import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { PlanningJournalStore } from "../../src/planning/journal.ts";
import { parsePluginConfig } from "../../src/config.ts";
import { ProjectMemoryStore } from "../../src/memory/store.ts";
import { ClawSpecService } from "../../src/orchestrator/service.ts";
import { ProjectStateStore } from "../../src/state/store.ts";
import { writeUtf8 } from "../../src/utils/fs.ts";
import { getRepoStatePaths } from "../../src/utils/paths.ts";
import { WorkspaceStore } from "../../src/workspace/store.ts";

export type FakeWatcherManager = {
  wakeCalls: string[];
  interruptCalls: Array<{ channelKey: string; reason: string }>;
  runtimeStatusCalls: string[];
  runtimeStatus?: unknown;
  wake: (channelKey: string) => Promise<void>;
  interrupt: (channelKey: string, reason: string) => Promise<void>;
  getWorkerRuntimeStatus: (channelKeyOrProject: string | { channelKey: string }) => Promise<unknown>;
};

export function createFakeWatcherManager(): FakeWatcherManager {
  const wakeCalls: string[] = [];
  const interruptCalls: Array<{ channelKey: string; reason: string }> = [];
  const runtimeStatusCalls: string[] = [];
  const manager: FakeWatcherManager = {
    wakeCalls,
    interruptCalls,
    runtimeStatusCalls,
    runtimeStatus: undefined,
    wake: async (channelKey: string) => {
      wakeCalls.push(channelKey);
    },
    interrupt: async (channelKey: string, reason: string) => {
      interruptCalls.push({ channelKey, reason });
    },
    getWorkerRuntimeStatus: async (channelKeyOrProject: string | { channelKey: string }) => {
      const channelKey = typeof channelKeyOrProject === "string"
        ? channelKeyOrProject
        : channelKeyOrProject.channelKey;
      runtimeStatusCalls.push(channelKey);
      return manager.runtimeStatus;
    },
  };
  return manager;
}

export function createLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for test condition.");
}

export async function createServiceHarness(prefix: string): Promise<{
  service: ClawSpecService;
  stateStore: ProjectStateStore;
  memoryStore: ProjectMemoryStore;
  workspaceStore: WorkspaceStore;
  watcherManager: FakeWatcherManager;
  workspacePath: string;
  repoPath: string;
  changeDir: string;
  openSpec: Record<string, any>;
}> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const workspacePath = path.join(tempRoot, "workspace");
  const repoPath = path.join(workspacePath, "demo-app");
  const changeDir = path.join(repoPath, "openspec", "changes", "demo-change");
  await mkdir(workspacePath, { recursive: true });

  const stateStore = new ProjectStateStore(tempRoot, "archives");
  const memoryStore = new ProjectMemoryStore(path.join(tempRoot, "memory.json"));
  const workspaceStore = new WorkspaceStore(path.join(tempRoot, "workspace-state.json"), workspacePath);
  await stateStore.initialize();
  await memoryStore.initialize();
  await workspaceStore.initialize();

  const openSpec = {
    init: async (cwd: string) => {
      await writeUtf8(path.join(cwd, "openspec", "config.yaml"), "schema: spec-driven\n");
      return {
        command: "openspec init --tools none .",
        cwd,
        stdout: "initialized",
        stderr: "",
        durationMs: 1,
      };
    },
    newChange: async (cwd: string, changeName: string, description?: string) => {
      const nextChangeDir = path.join(cwd, "openspec", "changes", changeName);
      await mkdir(nextChangeDir, { recursive: true });
      await writeUtf8(path.join(nextChangeDir, ".openspec.yaml"), "schema: spec-driven\n");
      await writeUtf8(path.join(nextChangeDir, "proposal.md"), `# ${changeName}\n${description ?? ""}\n`);
      return {
        command: description
          ? `openspec new change ${changeName} --description "${description}"`
          : `openspec new change ${changeName}`,
        cwd,
        stdout: "change created",
        stderr: "",
        durationMs: 1,
      };
    },
    status: async (cwd: string, changeName: string) => ({
      command: `openspec status --change ${changeName} --json`,
      cwd,
      stdout: "{}",
      stderr: "",
      durationMs: 1,
      parsed: {
        changeName,
        schemaName: "spec-driven",
        isComplete: false,
        applyRequires: ["tasks"],
        artifacts: [
          { id: "proposal", outputPath: path.join(changeDir, "proposal.md"), status: "done" },
          { id: "tasks", outputPath: path.join(changeDir, "tasks.md"), status: "ready" },
        ],
      },
    }),
    instructionsArtifact: async (cwd: string, artifactId: string, changeName: string) => ({
      command: `openspec instructions ${artifactId} --change ${changeName} --json`,
      cwd,
      stdout: "{}",
      stderr: "",
      durationMs: 1,
      parsed: {
        changeName,
        artifactId,
        schemaName: "spec-driven",
        changeDir,
        outputPath: artifactId === "specs"
          ? path.join(changeDir, "specs", "demo-spec", "spec.md")
          : path.join(changeDir, `${artifactId}.md`),
        description: `Refresh ${artifactId}`,
        instruction: `Use ${artifactId} template`,
        template: `# ${artifactId}`,
        dependencies: [],
        unlocks: [],
      },
    }),
    instructionsApply: async (cwd: string, changeName: string) => ({
      command: `openspec instructions apply --change ${changeName} --json`,
      cwd,
      stdout: "{}",
      stderr: "",
      durationMs: 1,
      parsed: {
        changeName,
        changeDir,
        schemaName: "spec-driven",
        contextFiles: {},
        progress: { total: 0, complete: 0, remaining: 0 },
        tasks: [],
        state: "ready",
        instruction: "Implement the remaining tasks.",
      },
    }),
  } as Record<string, any>;

  const watcherManager = createFakeWatcherManager();
  const service = new ClawSpecService({
    api: {
      config: {
        acp: {
          backend: "acpx",
          defaultAgent: "codex",
          allowedAgents: ["codex", "piper"],
        },
        agents: {
          list: [
            { id: "codex" },
            { id: "piper" },
          ],
        },
      },
      logger: createLogger(),
    } as any,
    config: {
      acp: {
        backend: "acpx",
        defaultAgent: "codex",
        allowedAgents: ["codex", "piper"],
      },
      agents: {
        list: [
          { id: "codex" },
          { id: "piper" },
        ],
      },
    } as any,
    logger: createLogger(),
    stateStore,
    memoryStore,
    openSpec: openSpec as any,
    archiveDirName: "archives",
    defaultWorkspace: workspacePath,
    defaultWorkerAgentId: undefined,
    workspaceStore,
    watcherManager: watcherManager as any,
  });

  return {
    service,
    stateStore,
    memoryStore,
    workspaceStore,
    watcherManager,
    workspacePath,
    repoPath,
    changeDir,
    openSpec,
  };
}

export async function seedPlanningProject(
  stateStore: ProjectStateStore,
  channelKey: string,
  params: {
    workspacePath: string;
    repoPath: string;
    projectName: string;
    changeName: string;
    changeDir: string;
    phase: "proposal" | "planning_sync" | "tasks" | "implementing";
    status: "ready" | "paused" | "planning" | "running";
    planningDirty: boolean;
    execution?: {
      action: "plan" | "work";
      state: "armed" | "running";
      mode: "apply" | "continue";
    };
  },
): Promise<void> {
  await mkdir(params.changeDir, { recursive: true });
  const repoStatePaths = getRepoStatePaths(params.repoPath, "archives");
  const journalStore = new PlanningJournalStore(repoStatePaths.planningJournalFile);
  await stateStore.createProject(channelKey);
  await stateStore.updateProject(channelKey, (current) => ({
    ...current,
    workspacePath: params.workspacePath,
    repoPath: params.repoPath,
    projectName: params.projectName,
    projectTitle: params.projectName,
    changeName: params.changeName,
    changeDir: params.changeDir,
    status: params.status,
    phase: params.phase,
    planningJournal: {
      dirty: params.planningDirty,
      entryCount: params.planningDirty ? 1 : 0,
      lastEntryAt: params.planningDirty ? new Date(Date.now() - 60_000).toISOString() : undefined,
    },
    execution: params.execution
      ? {
          ...params.execution,
          workerSlot: "primary",
          armedAt: new Date().toISOString(),
        }
      : current.execution,
  }));

  if (params.planningDirty) {
    await journalStore.append({
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      changeName: params.changeName,
      role: "user",
      text: "refresh planning for the active change",
    });
  }
}
