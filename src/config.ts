import {
  getDefaultWorkspacePath,
  resolveUserPath,
} from "./utils/paths.ts";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";

export type ClawSpecPluginConfig = {
  enabled: boolean;
  allowedChannels?: string[];
  openSpecTimeoutMs: number;
  maxAutoContinueTurns: number;
  maxNoProgressTurns: number;
  workerWaitTimeoutMs: number;
  workerAgentId: string;
  workerBackendId?: string;
  watcherPollIntervalMs: number;
  subagentLane?: string;
  archiveDirName: string;
  defaultWorkspace: string;
};

export const clawspecPluginConfigSchema: OpenClawPluginConfigSchema = {
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      allowedChannels: {
        type: "array",
        items: { type: "string" },
      },
      maxAutoContinueTurns: {
        type: "integer",
        minimum: 1,
        maximum: 50,
      },
      maxNoProgressTurns: {
        type: "integer",
        minimum: 1,
        maximum: 10,
      },
      openSpecTimeoutMs: {
        type: "integer",
        minimum: 5_000,
        maximum: 600_000,
      },
      workerWaitTimeoutMs: {
        type: "integer",
        minimum: 10_000,
        maximum: 3_600_000,
      },
      workerAgentId: {
        type: "string",
      },
      workerBackendId: {
        type: "string",
      },
      watcherPollIntervalMs: {
        type: "integer",
        minimum: 1_000,
        maximum: 60_000,
      },
      subagentLane: {
        type: "string",
      },
      archiveDirName: {
        type: "string",
      },
      defaultWorkspace: {
        type: "string",
      },
    },
  },
  validate(value) {
    const parsed = parsePluginConfig((value ?? {}) as Record<string, unknown>);
    return { ok: true, value: parsed };
  },
  uiHints: {
    enabled: {
      label: "Enable ClawSpec",
      help: "Enable or disable the ClawSpec plugin",
    },
    allowedChannels: {
      label: "Allowed Channels",
      help: "Optional list of channel ids allowed to use /clawspec",
    },
    maxAutoContinueTurns: {
      label: "Deprecated Auto Turns",
      help: "Deprecated no-op retained for backward compatibility with older configs",
      advanced: true,
    },
    maxNoProgressTurns: {
      label: "Deprecated No Progress",
      help: "Deprecated no-op retained for backward compatibility with older configs",
      advanced: true,
    },
    openSpecTimeoutMs: {
      label: "OpenSpec Timeout",
      help: "Timeout in milliseconds for each OpenSpec command",
      advanced: true,
    },
    workerWaitTimeoutMs: {
      label: "Deprecated Worker Timeout",
      help: "Deprecated no-op retained for backward compatibility with older configs",
      advanced: true,
    },
    workerAgentId: {
      label: "Worker Agent",
      help: "Agent id used for background ACP planning and implementation turns",
      advanced: true,
    },
    workerBackendId: {
      label: "Deprecated Worker Backend",
      help: "Deprecated no-op retained for backward compatibility with older configs",
      advanced: true,
    },
    watcherPollIntervalMs: {
      label: "Watcher Poll Interval",
      help: "Background watcher recovery poll interval in milliseconds",
      advanced: true,
    },
    subagentLane: {
      label: "Deprecated Lane Hint",
      help: "Deprecated no-op retained for backward compatibility with older configs",
      advanced: true,
    },
    archiveDirName: {
      label: "Archive Folder",
      help: "Directory name for archived project bundles",
      advanced: true,
    },
    defaultWorkspace: {
      label: "Default Workspace",
      help: "Default workspace used for `/clawspec workspace` and `/clawspec use`",
    },
  },
};

const DEFAULT_CONFIG: ClawSpecPluginConfig = {
  enabled: true,
  maxAutoContinueTurns: 3,
  maxNoProgressTurns: 2,
  openSpecTimeoutMs: 120_000,
  workerWaitTimeoutMs: 300_000,
  workerAgentId: "codex",
  watcherPollIntervalMs: 4_000,
  archiveDirName: "archives",
  defaultWorkspace: getDefaultWorkspacePath(),
};

export function parsePluginConfig(
  value: Record<string, unknown> | undefined,
): ClawSpecPluginConfig {
  const config = value ?? {};
  return {
    enabled: asBoolean(config.enabled, DEFAULT_CONFIG.enabled),
    allowedChannels: Array.isArray(config.allowedChannels)
      ? config.allowedChannels.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : undefined,
    maxAutoContinueTurns: asInt(
      config.maxAutoContinueTurns,
      DEFAULT_CONFIG.maxAutoContinueTurns,
      1,
      50,
    ),
    maxNoProgressTurns: asInt(
      config.maxNoProgressTurns,
      DEFAULT_CONFIG.maxNoProgressTurns,
      1,
      10,
    ),
    openSpecTimeoutMs: asInt(
      config.openSpecTimeoutMs,
      DEFAULT_CONFIG.openSpecTimeoutMs,
      5_000,
      600_000,
    ),
    workerWaitTimeoutMs: asInt(
      config.workerWaitTimeoutMs,
      DEFAULT_CONFIG.workerWaitTimeoutMs,
      10_000,
      3_600_000,
    ),
    workerAgentId: asOptionalString(config.workerAgentId) ?? DEFAULT_CONFIG.workerAgentId,
    workerBackendId: asOptionalString(config.workerBackendId),
    watcherPollIntervalMs: asInt(
      config.watcherPollIntervalMs,
      DEFAULT_CONFIG.watcherPollIntervalMs,
      1_000,
      60_000,
    ),
    subagentLane: asOptionalString(config.subagentLane),
    archiveDirName: asOptionalString(config.archiveDirName) ?? DEFAULT_CONFIG.archiveDirName,
    defaultWorkspace: resolveUserPath(
      asOptionalString(config.defaultWorkspace) ?? DEFAULT_CONFIG.defaultWorkspace,
    ),
  };
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const intValue = Math.trunc(value);
  if (intValue < min) {
    return min;
  }
  if (intValue > max) {
    return max;
  }
  return intValue;
}
