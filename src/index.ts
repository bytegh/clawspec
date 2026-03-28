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
import { ensureAcpxCli } from "./dependencies/acpx.ts";
import { getConfiguredDefaultWorkerAgent } from "./acp/openclaw-config.ts";
import {
  BootstrapCoordinator,
  buildBootstrapFailureMessage,
  buildBootstrapPendingMessage,
} from "./bootstrap/state.ts";

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
    const notifier = new ClawSpecNotifier({
      api,
      logger: api.logger,
    });
    let watcherManager: WatcherManager | undefined;
    let service: ClawSpecService | undefined;
    const bootstrap = new BootstrapCoordinator(
      async (report) => {
        let nextWatcherManager: WatcherManager | undefined;
        try {
          service = undefined;
          watcherManager = undefined;

          await report({
            phase: "initializing",
            detail: "ClawSpec is initializing local state.",
          });
          await ensureDir(pluginStateRoot);
          await ensureDir(config.defaultWorkspace);
          await initStores();

          await report({
            dependency: "openspec",
            phase: "checking",
            detail: "ClawSpec is checking the OpenSpec CLI.",
          });
          await ensureOpenSpecCli({
            pluginRoot: PLUGIN_ROOT,
            logger: api.logger,
            onInstallStart: async ({ packageName, reason }) => {
              await report({
                dependency: "openspec",
                phase: "installing",
                detail: `ClawSpec is installing ${packageName} because OpenSpec is unavailable (${reason}).`,
              });
            },
          });

          await report({
            dependency: "acpx",
            phase: "checking",
            detail: "ClawSpec is checking the ACPX CLI.",
          });
          const acpx = await ensureAcpxCli({
            pluginRoot: PLUGIN_ROOT,
            logger: api.logger,
            onInstallStart: async ({ packageName, reason, expectedVersion }) => {
              await report({
                dependency: "acpx",
                phase: "installing",
                detail: `ClawSpec is installing ${packageName}@${expectedVersion} because no compatible ACPX CLI is available (${reason}).`,
              });
            },
          });

          await report({
            dependency: "service",
            phase: "starting",
            detail: "ClawSpec dependencies are ready. Starting services.",
          });
          const configuredDefaultWorkerAgent = getConfiguredDefaultWorkerAgent(api.config) ?? "codex";
          const acpClient = new AcpWorkerClient({
            agentId: configuredDefaultWorkerAgent,
            logger: api.logger,
            command: acpx.command,
            env: acpx.env,
          });
          nextWatcherManager = new WatcherManager({
            stateStore,
            openSpec,
            archiveDirName: config.archiveDirName,
            logger: api.logger,
            notifier,
            acpClient,
            pollIntervalMs: config.watcherPollIntervalMs,
          });
          const nextService = new ClawSpecService({
            api,
            config: api.config,
            logger: api.logger,
            stateStore,
            memoryStore,
            openSpec,
            archiveDirName: config.archiveDirName,
            allowedChannels: config.allowedChannels,
            defaultWorkspace: config.defaultWorkspace,
            defaultWorkerAgentId: undefined,
            workspaceStore,
            watcherManager: nextWatcherManager,
          });
          await nextWatcherManager.start();
          watcherManager = nextWatcherManager;
          service = nextService;
        } catch (error) {
          service = undefined;
          await nextWatcherManager?.stop();
          watcherManager = undefined;
          throw error;
        }
      },
      (error) => {
        api.logger.error?.(
          `[clawspec] bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );

    const initStores = () => Promise.all([
      stateStore.initialize(),
      memoryStore.initialize(),
      workspaceStore.initialize(),
    ]);

    api.registerService({
      id: "clawspec.bootstrap",
      async start() {
        await bootstrap.start();
      },
      async stop() {
        await watcherManager?.stop();
        watcherManager = undefined;
        service = undefined;
        bootstrap.reset();
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
        if (!service) {
          const snapshot = bootstrap.getSnapshot();
          if (snapshot.status === "failed") {
            bootstrap.startInBackground();
            return {
              ok: false,
              text: buildBootstrapFailureMessage(snapshot),
            };
          }
          if (snapshot.status === "idle") {
            bootstrap.startInBackground();
            return {
              ok: false,
              text: buildBootstrapPendingMessage(bootstrap.getSnapshot()),
            };
          }
          return {
            ok: false,
            text: buildBootstrapPendingMessage(snapshot),
          };
        }
        const subcommand = parseSubcommand(ctx.args);
        if (requiresOpenSpec(subcommand)) {
          try {
            await ensureOpenSpecCli({
              pluginRoot: PLUGIN_ROOT,
              logger: api.logger,
            });
          } catch (error) {
            return {
              ok: false,
              text: error instanceof Error ? error.message : String(error),
            };
          }
        }
        return service.handleProjectCommand(ctx);
      },
    });

    api.on("message_received", async (event, ctx) => {
      await stateStore.initialize();
      if (!service) {
        return;
      }
      await service.recordPlanningMessageFromContext({
        channel: ctx.channel ?? ctx.messageProvider ?? ctx.channelId,
        channelId: ctx.channelId,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        sessionKey: (ctx as { sessionKey?: string }).sessionKey,
        from: event.from,
        metadata: event.metadata,
      }, event.content);
    });

    api.on("message_sent", async (event, ctx) => {
      await stateStore.initialize();
      if (!service || !event.success) {
        return;
      }
      service.recordOutboundMessageFromContext({
        channelId: ctx.channelId,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
      }, event.content);
    });

    api.on("before_dispatch", async (event, ctx) => {
      await stateStore.initialize();
      if (!service) {
        return;
      }
      return await service.handleBeforeDispatch(event, ctx);
    });

    api.on("before_prompt_build", async (event, ctx) => {
      await stateStore.initialize();
      if (!service) {
        return;
      }
      return service.handleBeforePromptBuild(event, ctx);
    });

    api.on("agent_end", async (event, ctx) => {
      await stateStore.initialize();
      if (!service) {
        return;
      }
      await service.handleAgentEnd(event, ctx);
    });
  },
};

export default plugin;

function parseSubcommand(args: string | undefined): string {
  const trimmed = (args ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const [first] = trimmed.split(/\s+/);
  return (first ?? "").toLowerCase();
}

function requiresOpenSpec(subcommand: string): boolean {
  return [
    "use",
    "proposal",
    "continue",
    "status",
    "archive",
  ].includes(subcommand);
}
