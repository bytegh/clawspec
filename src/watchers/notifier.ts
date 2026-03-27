import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk";
import { parseChannelKey } from "../utils/channel-key.ts";

type ClawSpecNotifierOptions = {
  api: OpenClawPluginApi;
  logger: PluginLogger;
};

export class ClawSpecNotifier {
  readonly api: OpenClawPluginApi;
  readonly logger: PluginLogger;

  constructor(options: ClawSpecNotifierOptions) {
    this.api = options.api;
    this.logger = options.logger;
  }

  async send(channelKey: string, text: string): Promise<void> {
    const route = parseChannelKey(channelKey);
    const accountId = route.accountId && route.accountId !== "default" ? route.accountId : undefined;

    try {
      switch (route.channel) {
        case "discord":
          await this.api.runtime.channel.discord.sendMessageDiscord(`channel:${route.channelId}`, text, {
            cfg: this.api.config,
            accountId,
            silent: true,
          });
          return;
        case "telegram":
          await this.api.runtime.channel.telegram.sendMessageTelegram(route.channelId, text, {
            cfg: this.api.config,
            accountId,
            silent: true,
            messageThreadId: parseOptionalNumber(route.conversationId),
          });
          return;
        case "slack":
          await this.api.runtime.channel.slack.sendMessageSlack(route.channelId, text, {
            cfg: this.api.config,
            accountId,
            threadTs: route.conversationId !== "main" ? route.conversationId : undefined,
          });
          return;
        case "signal":
          await this.api.runtime.channel.signal.sendMessageSignal(route.channelId, text, {
            cfg: this.api.config,
            accountId,
          });
          return;
        default:
          // Webchat and other channels: log only (no direct API available)
          this.logger.info(`[clawspec] watcher update (${route.channel} ${route.channelId}): ${text}`);
      }
    } catch (error) {
      this.logger.warn(
        `[clawspec] failed to send watcher update to ${channelKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function parseOptionalNumber(value: string): number | undefined {
  if (!value || value === "main") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
