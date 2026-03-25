import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { clawspecPluginConfigSchema, parsePluginConfig } from "./config.ts";
import { ProjectMemoryStore } from "./memory/store.ts";
import { OpenSpecClient } from "./openspec/cli.ts";
import { ClawSpecService } from "./orchestrator/service.ts";
import { ProjectStateStore } from "./state/store.ts";
import { ensureDir } from "./utils/fs.ts";
import {
  getPluginStateRoot,
  getProjectMemoryFilePath,
  getWorkspaceStateFilePath,
} from "./utils/paths.ts";
import { WorkspaceStore } from "./workspace/store.ts";
import { AcpWorkerClient } from "./acp/client.ts";
import { ClawSpecNotifier } from "./watchers/notifier.ts";
import { WatcherManager } from "./watchers/manager.ts";
import { ensureOpenSpecCli } from "./dependencies/openspec.ts";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_BIN_DIR = path.join(PLUGIN_ROOT, "node_modules", ".bin");

const plugin = {
  id: "clawspec",
  name: "ClawSpec",
  description: "OpenSpec-aware project orchestration for OpenClaw channels",
  configSchema: clawspecPluginConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    if (!config.enabled) {
      api.logger.info("[clawspec] Plugin disabled by configuration.");
      return;
    }

    const stateDir = api.runtime.state.resolveStateDir();
    const pluginStateRoot = getPluginStateRoot(stateDir);
    const stateStore = new ProjectStateStore(stateDir, config.archiveDirName);
    const memoryStore = new ProjectMemoryStore(getProjectMemoryFilePath(stateDir));
    const workspaceStore = new WorkspaceStore(getWorkspaceStateFilePath(stateDir), config.defaultWorkspace);
    const openSpec = new OpenSpecClient({
      timeoutMs: config.openSpecTimeoutMs,
      extraPathEntries: [LOCAL_BIN_DIR],
    });
    const acpClient = new AcpWorkerClient({
      agentId: config.workerAgentId,
      backendId: config.workerBackendId,
      logger: api.logger,
    });
    const notifier = new ClawSpecNotifier({
      api,
      logger: api.logger,
    });
    const watcherManager = new WatcherManager({
      stateStore,
      openSpec,
      archiveDirName: config.archiveDirName,
      logger: api.logger,
      notifier,
      acpClient,
      pollIntervalMs: config.watcherPollIntervalMs,
    });
    const service = new ClawSpecService({
      api,
      config: api.config,
      logger: api.logger,
      stateStore,
      memoryStore,
      openSpec,
      archiveDirName: config.archiveDirName,
      allowedChannels: config.allowedChannels,
      defaultWorkspace: config.defaultWorkspace,
      defaultWorkerAgentId: config.workerAgentId,
      workspaceStore,
      watcherManager,
    });

    const initStores = () => Promise.all([
      stateStore.initialize(),
      memoryStore.initialize(),
      workspaceStore.initialize(),
    ]);

    api.registerService({
      id: "clawspec.dependencies",
      async start(ctx) {
        await ensureOpenSpecCli({
          pluginRoot: PLUGIN_ROOT,
          logger: ctx.logger,
        });
      },
    });

    api.registerService({
      id: "clawspec.bootstrap",
      async start() {
        await ensureDir(pluginStateRoot);
        await ensureDir(config.defaultWorkspace);
        await initStores();
        await watcherManager.start();
      },
      async stop() {
        await watcherManager.stop();
      },
    });

    api.registerCli(
      ({ program, logger }) => {
        program
          .command("clawspec-projects")
          .description("List saved ClawSpec workspaces")
          .action(async () => {
            await initStores();
            const entries = await workspaceStore.list();
            if (entries.length === 0) {
              logger.info("No remembered ClawSpec workspaces.");
              return;
            }
            for (const entry of entries) {
              logger.info(entry.path);
            }
          });
      },
      { commands: ["clawspec-projects"] },
    );

    api.registerCommand({
      name: "clawspec",
      description: "Manage a ClawSpec project workflow",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        await initStores();
        return service.handleProjectCommand(ctx);
      },
    });

    api.on("message_received", async (event, ctx) => {
      await stateStore.initialize();
      await service.recordPlanningMessageFromContext({
        channel: ctx.channel ?? ctx.messageProvider ?? ctx.channelId,
        channelId: ctx.channelId,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        sessionKey: (ctx as { sessionKey?: string }).sessionKey,
      }, event.content);
    });

    api.on("before_prompt_build", async (event, ctx) => {
      await stateStore.initialize();
      return service.handleBeforePromptBuild(event, ctx);
    });

    api.on("agent_end", async (event, ctx) => {
      await stateStore.initialize();
      await service.handleAgentEnd(event, ctx);
    });
  },
};

export default plugin;
