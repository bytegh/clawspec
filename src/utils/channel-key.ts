import type { PluginCommandContext } from "openclaw/plugin-sdk";

export type ParsedChannelKey = {
  channel: string;
  channelId: string;
  accountId: string;
  conversationId: string;
};

export function buildChannelKeyFromCommand(ctx: PluginCommandContext): string {
  const conversationKey = ctx.messageThreadId?.toString() ?? "main";
  return buildChannelKey({
    channel: ctx.channel,
    channelId: ctx.channelId ?? ctx.channel,
    accountId: ctx.accountId ?? "default",
    conversationId: conversationKey,
  });
}

export function buildLegacyChannelKeyFromCommand(ctx: PluginCommandContext): string {
  const conversationKey = ctx.messageThreadId?.toString() ?? ctx.to ?? ctx.from ?? "main";
  return buildChannelKey({
    channel: ctx.channel,
    channelId: ctx.channelId ?? ctx.channel,
    accountId: ctx.accountId ?? "default",
    conversationId: conversationKey,
  });
}

export function buildChannelKeyFromMessage(params: {
  channel?: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
}): string {
  return buildChannelKey({
    channel: params.channel ?? params.channelId,
    channelId: params.channelId,
    accountId: params.accountId ?? "default",
    conversationId: params.conversationId ?? "main",
  });
}

export function parseChannelKey(channelKey: string): ParsedChannelKey {
  const [channel = "", channelId = "", accountId = "", ...conversationParts] = channelKey.split(":");
  return {
    channel,
    channelId,
    accountId,
    conversationId: conversationParts.join(":"),
  };
}

function buildChannelKey(params: {
  channel: string;
  channelId: string;
  accountId: string;
  conversationId: string;
}): string {
  return [
    params.channel,
    params.channelId,
    params.accountId,
    params.conversationId,
  ].join(":");
}
