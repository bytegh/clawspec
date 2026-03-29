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
      await sendWithRetry(async () => {
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
      }, this.logger, channelKey);
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

const RETRY_DELAYS_MS = [250, 1_000];

async function sendWithRetry(
  action: () => Promise<void>,
  logger: PluginLogger,
  channelKey: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt += 1) {
    try {
      await action();
      if (attempt > 1) {
        logger.info?.(
          `[clawspec] watcher update send recovered for ${channelKey} on attempt ${attempt}.`,
        );
      }
      return;
    } catch (error) {
      lastError = error;
      if (!isRetriableSendError(error) || attempt > RETRY_DELAYS_MS.length) {
        throw error;
      }
      const delayMs = RETRY_DELAYS_MS[attempt - 1]!;
      logger.debug?.(
        `[clawspec] watcher update send retry ${attempt} scheduled for ${channelKey} in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      );
      await delay(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetriableSendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return [
    /\bfetch failed\b/,
    /\btimeout\b/,
    /\btimed out\b/,
    /\baborted\b/,
    /\becconnreset\b/,
    /\beconnrefused\b/,
    /\bepipe\b/,
    /socket hang up/,
    /connection .*?(reset|closed|refused)/,
    /\bnetwork\b/,
  ].some((pattern) => pattern.test(normalized));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
