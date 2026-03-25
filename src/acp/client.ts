import { randomUUID } from "node:crypto";
import type { AcpRuntimeEvent, AcpRuntimeHandle, AcpRuntimeStatus, PluginLogger } from "openclaw/plugin-sdk";
import { requireAcpRuntimeBackend } from "openclaw/plugin-sdk";

type AcpWorkerClientOptions = {
  agentId: string;
  backendId?: string;
  logger: PluginLogger;
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
    handle: AcpRuntimeHandle;
  }) => Promise<void> | void;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
};

type SessionDescriptor = {
  sessionKey: string;
  cwd: string;
  agentId: string;
};

export class AcpWorkerClient {
  readonly agentId: string;
  readonly backendId?: string;
  readonly logger: PluginLogger;
  readonly handles = new Map<string, AcpRuntimeHandle>();
  readonly sessionDescriptors = new Map<string, SessionDescriptor>();

  constructor(options: AcpWorkerClientOptions) {
    this.agentId = options.agentId;
    this.backendId = options.backendId;
    this.logger = options.logger;
  }

  async ensureSession(params: EnsureSessionParams): Promise<{
    backendId: string;
    handle: AcpRuntimeHandle;
  }> {
    this.sessionDescriptors.set(params.sessionKey, {
      sessionKey: params.sessionKey,
      cwd: params.cwd,
      agentId: params.agentId ?? this.agentId,
    });
    const backend = requireAcpRuntimeBackend(this.backendId);
    const handle = await backend.runtime.ensureSession({
      sessionKey: params.sessionKey,
      agent: params.agentId ?? this.agentId,
      mode: "persistent",
      cwd: params.cwd,
    });
    this.handles.set(params.sessionKey, handle);
    return {
      backendId: backend.id,
      handle,
    };
  }

  async runTurn(params: RunTurnParams): Promise<{
    backendId: string;
    handle: AcpRuntimeHandle;
  }> {
    const ensured = await this.ensureSession(params);
    await params.onReady?.(ensured);
    const backend = requireAcpRuntimeBackend(ensured.backendId);
    const stream = backend.runtime.runTurn({
      handle: ensured.handle,
      text: params.text,
      mode: "prompt",
      requestId: randomUUID(),
      signal: params.signal,
    });

    for await (const event of stream) {
      await params.onEvent?.(event);
      if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    return ensured;
  }

  async getSessionStatus(
    session:
      | string
      | {
          sessionKey: string;
          cwd?: string;
          agentId?: string;
        },
  ): Promise<AcpRuntimeStatus | undefined> {
    const sessionKey = typeof session === "string" ? session : session.sessionKey;
    try {
      const runtimeBackend = requireAcpRuntimeBackend(this.backendId);
      if (!runtimeBackend.runtime.getStatus) {
        return undefined;
      }
      const handle = this.resolveStatusHandle(
        sessionKey,
        runtimeBackend.id,
        typeof session === "string" ? undefined : session,
      );
      if (!handle) {
        return undefined;
      }
      const statusBackend = handle.backend === runtimeBackend.id
        ? runtimeBackend
        : requireAcpRuntimeBackend(handle.backend);
      return await statusBackend.runtime.getStatus({ handle });
    } catch (error) {
      this.logger.warn(
        `[clawspec] ACP status probe failed for session ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  async cancelSession(sessionKey: string, reason = "cancelled by ClawSpec"): Promise<void> {
    const handle = this.handles.get(sessionKey);
    if (!handle) {
      return;
    }

    try {
      const backend = requireAcpRuntimeBackend(handle.backend);
      await backend.runtime.cancel({
        handle,
        reason,
      });
    } catch (error) {
      this.logger.warn(
        `[clawspec] ACP cancel failed for session ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.handles.delete(sessionKey);
    this.sessionDescriptors.delete(sessionKey);
  }

  async closeSession(sessionKey: string, reason = "closed by ClawSpec"): Promise<void> {
    const handle = this.handles.get(sessionKey);
    this.handles.delete(sessionKey);
    this.sessionDescriptors.delete(sessionKey);
    if (!handle) {
      return;
    }

    try {
      const backend = requireAcpRuntimeBackend(handle.backend);
      await backend.runtime.close({
        handle,
        reason,
      });
    } catch (error) {
      this.logger.warn(
        `[clawspec] ACP close failed for session ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private resolveStatusHandle(
    sessionKey: string,
    backendId: string,
    fallback?: {
      cwd?: string;
      agentId?: string;
    },
  ): AcpRuntimeHandle | undefined {
    const existing = this.handles.get(sessionKey);
    if (existing) {
      return existing;
    }

    const descriptor = this.sessionDescriptors.get(sessionKey);
    const cwd = fallback?.cwd ?? descriptor?.cwd;
    const agentId = fallback?.agentId ?? descriptor?.agentId ?? this.agentId;
    if (!cwd || !supportsSyntheticStatusHandle(backendId)) {
      return undefined;
    }

    return {
      sessionKey,
      backend: backendId,
      runtimeSessionName: encodeAcpxRuntimeSessionName({
        name: sessionKey,
        agent: agentId,
        cwd,
        mode: "persistent",
      }),
      cwd,
    };
  }
}

const ACPX_RUNTIME_HANDLE_PREFIX = "acpx:v1:";

function encodeAcpxRuntimeSessionName(state: {
  name: string;
  agent: string;
  cwd: string;
  mode: "persistent" | "oneshot";
}): string {
  return `${ACPX_RUNTIME_HANDLE_PREFIX}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}

function supportsSyntheticStatusHandle(backendId: string): boolean {
  return backendId.trim().toLowerCase() === "acpx";
}
