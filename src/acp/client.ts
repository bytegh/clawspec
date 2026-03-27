import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { runShellCommand, spawnShellCommand, terminateChildProcess } from "../utils/shell-command.ts";

export type AcpWorkerEvent =
  | {
      type: "text_delta";
      text: string;
      tag?: string;
      stream?: string;
    }
  | {
      type: "tool_call";
      text: string;
      title: string;
      tag?: string;
      status?: string;
      toolCallId?: string;
    }
  | {
      type: "done";
    }
  | {
      type: "error";
      message: string;
      code?: string;
      retryable?: boolean;
    };

export type AcpWorkerHandle = {
  sessionKey: string;
  backend: "acpx";
  runtimeSessionName: string;
  cwd: string;
  agentId: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};

export type AcpWorkerStatus = {
  summary: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
  details?: Record<string, unknown>;
};

type AcpWorkerClientOptions = {
  agentId: string;
  logger: PluginLogger;
  command: string;
  env?: NodeJS.ProcessEnv;
  permissionMode?: "approve-all" | "approve-reads" | "deny-all";
  queueOwnerTtlSeconds?: number;
  gatewayPid?: number;
  gatewayWatchdogPollMs?: number;
};

type EnsureSessionParams = {
  sessionKey: string;
  cwd: string;
  agentId?: string;
};

type RunTurnParams = EnsureSessionParams & {
  text: string;
  signal?: AbortSignal;
  onReady?: (params: {
    backendId: string;
    handle: AcpWorkerHandle;
  }) => Promise<void> | void;
  onEvent?: (event: AcpWorkerEvent) => Promise<void> | void;
};

type SessionDescriptor = {
  sessionKey: string;
  cwd: string;
  agentId: string;
};

type ActiveSessionProcess = {
  sessionKey: string;
  child: ChildProcessWithoutNullStreams;
  watchdog?: ChildProcess;
  cwd: string;
  agentId: string;
  startedAt: string;
};

type SessionExitState = {
  summary: string;
  details: Record<string, unknown>;
};

const DEFAULT_QUEUE_OWNER_TTL_SECONDS = 30;
const DEFAULT_PERMISSION_MODE = "approve-all";
const DEFAULT_GATEWAY_WATCHDOG_POLL_MS = 1_000;

export class AcpWorkerClient {
  readonly agentId: string;
  readonly logger: PluginLogger;
  readonly command: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly permissionMode: "approve-all" | "approve-reads" | "deny-all";
  readonly queueOwnerTtlSeconds: number;
  readonly gatewayPid: number;
  readonly gatewayWatchdogPollMs: number;
  readonly handles = new Map<string, AcpWorkerHandle>();
  readonly sessionDescriptors = new Map<string, SessionDescriptor>();
  readonly activeProcesses = new Map<string, ActiveSessionProcess>();
  readonly lastExitStates = new Map<string, AcpWorkerStatus>();

  constructor(options: AcpWorkerClientOptions) {
    this.agentId = options.agentId;
    this.logger = options.logger;
    this.command = options.command;
    this.env = options.env;
    this.permissionMode = options.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this.queueOwnerTtlSeconds = options.queueOwnerTtlSeconds ?? DEFAULT_QUEUE_OWNER_TTL_SECONDS;
    this.gatewayPid = normalizePid(options.gatewayPid) ?? process.pid;
    this.gatewayWatchdogPollMs = normalizeWatchdogPollMs(options.gatewayWatchdogPollMs);
  }

  async ensureSession(params: EnsureSessionParams): Promise<{
    backendId: string;
    handle: AcpWorkerHandle;
  }> {
    const descriptor = {
      sessionKey: params.sessionKey,
      cwd: params.cwd,
      agentId: params.agentId ?? this.agentId,
    };
    this.sessionDescriptors.set(params.sessionKey, descriptor);

    let events = await this.runControlCommand({
      agentId: descriptor.agentId,
      cwd: descriptor.cwd,
      command: ["sessions", "ensure", "--name", descriptor.sessionKey],
      allowErrorCodes: ["NO_SESSION"],
    });

    if (events.some((event) => toAcpxErrorEvent(event)?.code === "NO_SESSION") || events.length === 0) {
      events = await this.runControlCommand({
        agentId: descriptor.agentId,
        cwd: descriptor.cwd,
        command: ["sessions", "new", "--name", descriptor.sessionKey],
      });
    }

    const identifiers = extractSessionIdentifiers(events);
    const handle: AcpWorkerHandle = {
      sessionKey: descriptor.sessionKey,
      backend: "acpx",
      runtimeSessionName: descriptor.sessionKey,
      cwd: descriptor.cwd,
      agentId: descriptor.agentId,
      ...identifiers,
    };
    this.handles.set(params.sessionKey, handle);
    return {
      backendId: "acpx",
      handle,
    };
  }

  async runTurn(params: RunTurnParams): Promise<{
    backendId: string;
    handle: AcpWorkerHandle;
  }> {
    const ensured = await this.ensureSession(params);
    const descriptor = this.sessionDescriptors.get(params.sessionKey) ?? {
      sessionKey: params.sessionKey,
      cwd: params.cwd,
      agentId: params.agentId ?? this.agentId,
    };

    const child = spawnShellCommand({
      command: this.command,
      args: this.buildPromptArgs({
        agentId: descriptor.agentId,
        cwd: descriptor.cwd,
        sessionKey: descriptor.sessionKey,
      }),
      cwd: descriptor.cwd,
      env: this.env,
    });

    const args = this.buildPromptArgs({
      agentId: descriptor.agentId,
      cwd: descriptor.cwd,
      sessionKey: descriptor.sessionKey,
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.end(params.text);

    const startedAt = new Date().toISOString();
    const watchdog = this.startGatewayWatchdog(params.sessionKey, child);
    this.activeProcesses.set(params.sessionKey, {
      sessionKey: params.sessionKey,
      child,
      watchdog,
      cwd: descriptor.cwd,
      agentId: descriptor.agentId,
      startedAt,
    });
    this.lastExitStates.delete(params.sessionKey);
    this.logger.debug?.(
      `[clawspec] acpx worker spawned: session=${params.sessionKey} agent=${descriptor.agentId} pid=${child.pid ?? "unknown"}`,
    );

    await params.onReady?.(ensured);

    let stderr = "";
    let sawDone = false;
    let sawError = false;
    let abortCleanupDone = false;
    const lines = createInterface({ input: child.stdout });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const abortRun = async () => {
      if (abortCleanupDone) {
        return;
      }
      abortCleanupDone = true;
      await this.cancelSession(params.sessionKey, "abort-signal").catch(() => undefined);
      safeKill(child);
    };
    const onAbort = () => {
      void abortRun();
    };
    if (params.signal?.aborted) {
      await abortRun();
    } else if (params.signal) {
      params.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      for await (const line of lines) {
        const event = parsePromptEventLine(line);
        if (!event) {
          continue;
        }
        await params.onEvent?.(event);
        if (event.type === "done") {
          sawDone = true;
        } else if (event.type === "error") {
          sawError = true;
          throw new Error(event.code ? `${event.code}: ${event.message}` : event.message);
        }
      }

      const exit = await waitForExit(child);
      this.recordSessionExit(params.sessionKey, descriptor, child.pid, exit.code, exit.signal, stderr);

      if (exit.error) {
        throw exit.error;
      }
      if (exit.signal && !sawError) {
        throw new Error(formatAcpxExitMessage(stderr, exit.code, exit.signal));
      }
      if ((exit.code ?? 0) !== 0 && !sawError) {
        throw new Error(formatAcpxExitMessage(stderr, exit.code, exit.signal));
      }
      if (!sawDone && !sawError) {
        await params.onEvent?.({ type: "done" });
      }
      return ensured;
    } finally {
      const active = this.activeProcesses.get(params.sessionKey);
      if (active?.watchdog) {
        safeKill(active.watchdog);
      }
      this.activeProcesses.delete(params.sessionKey);
      lines.close();
      if (params.signal) {
        params.signal.removeEventListener("abort", onAbort);
      }
      safeKill(child);
    }
  }

  async getSessionStatus(
    session:
      | string
      | {
          sessionKey: string;
          cwd?: string;
          agentId?: string;
        },
  ): Promise<AcpWorkerStatus | undefined> {
    const sessionKey = typeof session === "string" ? session : session.sessionKey;
    const descriptor = this.resolveDescriptor(session);
    const active = this.activeProcesses.get(sessionKey);
    if (active && !active.child.killed) {
      return {
        summary: `status=alive pid=${active.child.pid ?? "unknown"}`,
        details: {
          status: "alive",
          pid: active.child.pid ?? null,
          startedAt: active.startedAt,
          cwd: active.cwd,
          agentId: active.agentId,
          source: "clawspec-child",
        },
      };
    }

    if (!descriptor?.cwd) {
      return this.lastExitStates.get(sessionKey);
    }

    try {
      const events = await this.runControlCommand({
        agentId: descriptor.agentId,
        cwd: descriptor.cwd,
        command: ["status", "--session", descriptor.sessionKey],
        allowErrorCodes: ["NO_SESSION"],
      });
      const noSession = events.map((event) => toAcpxErrorEvent(event)).find((event) => event?.code === "NO_SESSION");
      if (noSession) {
        return this.lastExitStates.get(sessionKey) ?? {
          summary: "status=dead no-session",
          details: {
            status: "dead",
            summary: noSession.message,
          },
        };
      }

      const detail = events.find((event) => !toAcpxErrorEvent(event)) ?? events[0];
      if (!detail) {
        return this.lastExitStates.get(sessionKey) ?? {
          summary: "acpx status unavailable",
          details: { status: "unknown" },
        };
      }

      const status = asTrimmedString(detail.status) || "unknown";
      const acpxRecordId = asOptionalString(detail.acpxRecordId);
      const acpxSessionId = asOptionalString(detail.acpxSessionId);
      const agentSessionId = asOptionalString(detail.agentSessionId);
      const pid = typeof detail.pid === "number" && Number.isFinite(detail.pid) ? detail.pid : null;
      return {
        summary: [
          `status=${status}`,
          acpxRecordId ? `acpxRecordId=${acpxRecordId}` : null,
          acpxSessionId ? `acpxSessionId=${acpxSessionId}` : null,
          pid != null ? `pid=${pid}` : null,
        ].filter(Boolean).join(" "),
        ...acpxRecordId ? { acpxRecordId } : {},
        ...acpxSessionId ? { backendSessionId: acpxSessionId } : {},
        ...agentSessionId ? { agentSessionId } : {},
        details: detail,
      };
    } catch (error) {
      this.logger.warn(
        `[clawspec] ACP status probe failed for session ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.lastExitStates.get(sessionKey);
    }
  }

  async cancelSession(sessionKey: string, reason = "cancelled by ClawSpec"): Promise<void> {
    const descriptor = this.sessionDescriptors.get(sessionKey);
    if (descriptor) {
      try {
        await this.runControlCommand({
          agentId: descriptor.agentId,
          cwd: descriptor.cwd,
          command: ["cancel", "--session", sessionKey],
          allowErrorCodes: ["NO_SESSION"],
        });
      } catch (error) {
        this.logger.warn(
          `[clawspec] ACP cancel failed for session ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const active = this.activeProcesses.get(sessionKey);
    if (active) {
      safeKill(active.watchdog);
      safeKill(active.child);
      this.activeProcesses.delete(sessionKey);
      this.recordSessionExit(sessionKey, active, active.child.pid, null, "SIGTERM", reason);
    }
  }

  async closeSession(sessionKey: string, reason = "closed by ClawSpec"): Promise<void> {
    const descriptor = this.sessionDescriptors.get(sessionKey);
    if (descriptor) {
      try {
        await this.runControlCommand({
          agentId: descriptor.agentId,
          cwd: descriptor.cwd,
          command: ["sessions", "close", sessionKey],
          allowErrorCodes: ["NO_SESSION"],
        });
      } catch (error) {
        this.logger.warn(
          `[clawspec] ACP close failed for session ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const active = this.activeProcesses.get(sessionKey);
    if (active) {
      safeKill(active.watchdog);
      safeKill(active.child);
      this.activeProcesses.delete(sessionKey);
      this.recordSessionExit(sessionKey, active, active.child.pid, null, "SIGTERM", reason);
    }

    this.handles.delete(sessionKey);
    this.sessionDescriptors.delete(sessionKey);
  }

  private buildControlArgs(params: {
    agentId: string;
    cwd: string;
    command: string[];
  }): string[] {
    return [
      "--format",
      "json",
      "--json-strict",
      "--cwd",
      params.cwd,
      params.agentId,
      ...params.command,
    ];
  }

  private buildPromptArgs(params: {
    agentId: string;
    cwd: string;
    sessionKey: string;
  }): string[] {
    return [
      "--format",
      "json",
      "--json-strict",
      "--cwd",
      params.cwd,
      ...buildPermissionArgs(this.permissionMode),
      "--ttl",
      String(this.queueOwnerTtlSeconds),
      params.agentId,
      "prompt",
      "--session",
      params.sessionKey,
      "--file",
      "-",
    ];
  }

  private async runControlCommand(params: {
    agentId: string;
    cwd: string;
    command: string[];
    allowErrorCodes?: string[];
  }): Promise<Array<Record<string, unknown>>> {
    const result = await runShellCommand({
      command: this.command,
      args: this.buildControlArgs(params),
      cwd: params.cwd,
      env: this.env,
    });

    if (result.error) {
      throw result.error;
    }

    const events = parseJsonLines(result.stdout);
    const errorEvent = events.map((event) => toAcpxErrorEvent(event)).find(Boolean) ?? null;
    if (errorEvent && !(params.allowErrorCodes ?? []).includes(errorEvent.code ?? "")) {
      throw new Error(errorEvent.code ? `${errorEvent.code}: ${errorEvent.message}` : errorEvent.message);
    }
    if ((result.code ?? 0) !== 0 && !errorEvent) {
      throw new Error(formatAcpxExitMessage(result.stderr, result.code));
    }
    return events;
  }

  private resolveDescriptor(
    session:
      | string
      | {
          sessionKey: string;
          cwd?: string;
          agentId?: string;
        },
  ): SessionDescriptor | undefined {
    if (typeof session !== "string" && session.cwd) {
      return {
        sessionKey: session.sessionKey,
        cwd: session.cwd,
        agentId: session.agentId ?? this.agentId,
      };
    }
    return this.sessionDescriptors.get(typeof session === "string" ? session : session.sessionKey);
  }

  private recordSessionExit(
    sessionKey: string,
    descriptor: { cwd: string; agentId: string },
    pid: number | undefined,
    code: number | null | undefined,
    signal: NodeJS.Signals | null | undefined,
    stderr: string,
  ): void {
    const status = "dead";
    const summary = [
      `status=${status}`,
      pid != null ? `pid=${pid}` : null,
      code != null ? `code=${code}` : null,
      signal ? `signal=${signal}` : null,
      stderr.trim() ? `summary=${stderr.trim().replace(/\s+/g, " ").slice(0, 160)}` : null,
    ].filter(Boolean).join(" ");
    this.lastExitStates.set(sessionKey, {
      summary,
      details: {
        status,
        pid: pid ?? null,
        code: code ?? null,
        signal: signal ?? null,
        cwd: descriptor.cwd,
        agentId: descriptor.agentId,
        summary: stderr.trim() || undefined,
        timestamp: new Date().toISOString(),
      },
    });
    this.logger.debug?.(
      `[clawspec] acpx worker exited: session=${sessionKey} pid=${pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
  }

  private startGatewayWatchdog(
    sessionKey: string,
    child: ChildProcessWithoutNullStreams,
  ): ChildProcess | undefined {
    const workerPid = normalizePid(child.pid);
    if (!workerPid) {
      return undefined;
    }

    try {
      const watchdog = spawn(process.execPath, [
        "-e",
        GATEWAY_WATCHDOG_SOURCE,
        String(this.gatewayPid),
        String(workerPid),
        String(this.gatewayWatchdogPollMs),
      ], {
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      });
      watchdog.unref();
      this.logger.debug?.(
        `[clawspec] gateway watchdog armed: session=${sessionKey} gatewayPid=${this.gatewayPid} workerPid=${workerPid}`,
      );
      return watchdog;
    } catch (error) {
      this.logger.warn(
        `[clawspec] failed to start gateway watchdog for ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
}

function parseJsonLines(value: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        events.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return events;
}

function parsePromptEventLine(line: string): AcpWorkerEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(trimmed);
    if (!isRecord(raw)) {
      return null;
    }
    parsed = raw;
  } catch {
    return { type: "text_delta", text: trimmed };
  }

  const error = toAcpxErrorEvent(parsed);
  if (error) {
    return error;
  }

  const type = asTrimmedString(parsed.type);
  if (type === "done") {
    return { type: "done" };
  }

  const toolTitle = asTrimmedString(parsed.title);
  const toolStatus = asOptionalString(parsed.status);
  const toolCallId = asOptionalString(parsed.toolCallId);
  if (toolTitle || toolCallId) {
    return {
      type: "tool_call",
      text: toolStatus ? `${toolTitle || "tool call"} (${toolStatus})` : (toolTitle || "tool call"),
      title: toolTitle || "tool call",
      ...toolStatus ? { status: toolStatus } : {},
      ...toolCallId ? { toolCallId } : {},
    };
  }

  const text = extractDisplayText(parsed);
  if (text) {
    return { type: "text_delta", text };
  }
  return null;
}

function toAcpxErrorEvent(value: Record<string, unknown>): AcpWorkerEvent | null {
  if (asTrimmedString(value.type) !== "error") {
    return null;
  }
  return {
    type: "error",
    message: asTrimmedString(value.message) || "acpx reported an error",
    code: asOptionalString(value.code),
    retryable: typeof value.retryable === "boolean" ? value.retryable : undefined,
  };
}

function extractSessionIdentifiers(events: Array<Record<string, unknown>>): {
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
} {
  const event = events.find((entry) =>
    asOptionalString(entry.acpxRecordId)
    || asOptionalString(entry.acpxSessionId)
    || asOptionalString(entry.agentSessionId)
  );
  if (!event) {
    return {};
  }

  return {
    ...asOptionalString(event.acpxRecordId) ? { acpxRecordId: asOptionalString(event.acpxRecordId) } : {},
    ...asOptionalString(event.acpxSessionId) ? { backendSessionId: asOptionalString(event.acpxSessionId) } : {},
    ...asOptionalString(event.agentSessionId) ? { agentSessionId: asOptionalString(event.agentSessionId) } : {},
  };
}

function extractDisplayText(parsed: Record<string, unknown>): string | undefined {
  const directText = asOptionalString(parsed.text);
  if (directText) {
    return directText;
  }

  if (isRecord(parsed.content)) {
    const contentText = asOptionalString(parsed.content.text);
    if (contentText) {
      return contentText;
    }
  }

  const summary = asOptionalString(parsed.summary) ?? asOptionalString(parsed.message);
  if (summary) {
    return summary;
  }

  if (asTrimmedString(parsed.method) === "session/update" && isRecord(parsed.params) && isRecord(parsed.params.update)) {
    return asOptionalString(parsed.params.update.summary)
      ?? asOptionalString(parsed.params.update.message)
      ?? asOptionalString(parsed.params.update.sessionUpdate);
  }

  return asOptionalString(parsed.sessionUpdate);
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

function safeKill(child: Pick<ChildProcess, "pid" | "killed" | "kill"> | undefined): void {
  if (!child) {
    return;
  }
  terminateChildProcess(child);
}

function buildPermissionArgs(mode: "approve-all" | "approve-reads" | "deny-all"): string[] {
  if (mode === "deny-all") {
    return ["--deny-all"];
  }
  if (mode === "approve-reads") {
    return ["--approve-reads"];
  }
  return ["--approve-all"];
}

function formatAcpxExitMessage(
  stderr: string,
  exitCode: number | null | undefined,
  signal?: NodeJS.Signals | null,
): string {
  const detail = stderr.trim();
  if (detail) {
    return detail;
  }
  if (signal) {
    return `acpx terminated by signal ${signal}`;
  }
  return `acpx exited with code ${exitCode ?? "unknown"}`;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalString(value: unknown): string | undefined {
  const trimmed = asTrimmedString(value);
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePid(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function normalizeWatchdogPollMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 50) {
    return DEFAULT_GATEWAY_WATCHDOG_POLL_MS;
  }
  return Math.trunc(value);
}

const GATEWAY_WATCHDOG_SOURCE = String.raw`
const { spawn } = require("node:child_process");

const gatewayPid = Number(process.argv[1]);
const workerPid = Number(process.argv[2]);
const pollMs = Number(process.argv[3]);

function normalizePid(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function isAlive(pid) {
  const normalized = normalizePid(pid);
  if (!normalized) {
    return false;
  }
  try {
    process.kill(normalized, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    return code === "EPERM";
  }
}

function killWorkerTree(pid) {
  const normalized = normalizePid(pid);
  if (!normalized) {
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(normalized), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      });
      killer.unref();
    } catch {}
    return;
  }
  try {
    process.kill(-normalized, "SIGTERM");
  } catch {
    try {
      process.kill(normalized, "SIGTERM");
    } catch {}
  }
  const escalator = setTimeout(() => {
    try {
      process.kill(-normalized, "SIGKILL");
    } catch {
      try {
        process.kill(normalized, "SIGKILL");
      } catch {}
    }
  }, 1000);
  escalator.unref?.();
}

const safeGatewayPid = normalizePid(gatewayPid);
const safeWorkerPid = normalizePid(workerPid);
const safePollMs = Number.isFinite(pollMs) && pollMs >= 50 ? Math.trunc(pollMs) : 1000;

if (!safeGatewayPid || !safeWorkerPid) {
  process.exit(0);
}

if (!isAlive(safeWorkerPid)) {
  process.exit(0);
}

const timer = setInterval(() => {
  if (!isAlive(safeWorkerPid)) {
    clearInterval(timer);
    process.exit(0);
    return;
  }
  if (!isAlive(safeGatewayPid)) {
    clearInterval(timer);
    killWorkerTree(safeWorkerPid);
    const exitTimer = setTimeout(() => process.exit(0), 250);
    exitTimer.unref?.();
  }
}, safePollMs);
`;
