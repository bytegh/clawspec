import type { OpenClawConfig } from "openclaw/plugin-sdk";

type ConfigLike = OpenClawConfig | Record<string, unknown> | undefined;

export function getConfiguredDefaultWorkerAgent(config: ConfigLike): string | undefined {
  const acp = getAcpConfig(config);
  return asOptionalString(acp?.defaultAgent);
}

export function listConfiguredWorkerAgents(config: ConfigLike): string[] {
  const acp = getAcpConfig(config);
  const allowed = Array.isArray(acp?.allowedAgents)
    ? acp.allowedAgents.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const agentsConfig = getAgentsConfig(config);
  const listed = Array.isArray(agentsConfig?.list)
    ? agentsConfig.list
      .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : undefined))
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const defaultAgent = getConfiguredDefaultWorkerAgent(config);
  return Array.from(new Set([
    ...(defaultAgent ? [defaultAgent] : []),
    ...allowed,
    ...listed,
  ])).sort((left, right) => left.localeCompare(right));
}

export function buildWorkerAgentSetupHint(action: "plan" | "work"): string {
  const rerunCommand = action === "plan" ? "`cs-plan`" : "`cs-work`";
  return `Run \`openclaw config set acp.defaultAgent codex\`, then rerun ${rerunCommand}.`;
}

export function buildWorkerAgentSetupMessage(action: "plan" | "work"): string {
  const rerunCommand = action === "plan" ? "`cs-plan`" : "`cs-work`";
  const scope = action === "plan" ? "planning" : "workers";
  return [
    `OpenClaw ACP is not configured for ClawSpec ${scope}.`,
    "Run:",
    "- `openclaw config set acp.backend acpx`",
    "- `openclaw config set acp.defaultAgent codex`",
    `Then rerun ${rerunCommand}. Replace \`codex\` with another ACP agent id if needed.`,
  ].join("\n");
}

function getAcpConfig(config: ConfigLike): Record<string, unknown> | undefined {
  const record = asRecord(config);
  return record?.acp && typeof record.acp === "object"
    ? record.acp as Record<string, unknown>
    : undefined;
}

function getAgentsConfig(config: ConfigLike): Record<string, unknown> | undefined {
  const record = asRecord(config);
  return record?.agents && typeof record.agents === "object"
    ? record.agents as Record<string, unknown>
    : undefined;
}

function asRecord(value: ConfigLike): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
