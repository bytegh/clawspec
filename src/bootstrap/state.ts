export type BootstrapDependency = "openspec" | "acpx" | "service";
export type BootstrapPhase = "initializing" | "checking" | "installing" | "starting" | "ready";
export type BootstrapStatus = "idle" | "running" | "ready" | "failed";

export type BootstrapSnapshot = {
  status: BootstrapStatus;
  attempt: number;
  updatedAt: string;
  dependency?: BootstrapDependency;
  phase?: BootstrapPhase;
  detail?: string;
  error?: string;
};

export type BootstrapProgress = {
  dependency?: BootstrapDependency;
  phase: BootstrapPhase;
  detail: string;
};

export class BootstrapCoordinator {
  private readonly runner: (report: (progress: BootstrapProgress) => void | Promise<void>) => Promise<void>;
  private readonly onFailure?: (error: unknown) => void;
  private snapshot: BootstrapSnapshot = {
    status: "idle",
    attempt: 0,
    updatedAt: new Date(0).toISOString(),
  };

  private inFlight?: Promise<void>;

  constructor(
    runner: (report: (progress: BootstrapProgress) => void | Promise<void>) => Promise<void>,
    onFailure?: (error: unknown) => void,
  ) {
    this.runner = runner;
    this.onFailure = onFailure;
  }

  getSnapshot(): BootstrapSnapshot {
    return { ...this.snapshot };
  }

  async start(): Promise<void> {
    if (this.snapshot.status === "ready") {
      return;
    }
    if (this.inFlight) {
      return await this.inFlight;
    }

    const attempt = this.snapshot.attempt + 1;
    this.snapshot = {
      status: "running",
      attempt,
      updatedAt: new Date().toISOString(),
      phase: "initializing",
      detail: "Initializing ClawSpec bootstrap.",
    };

    const report = async (progress: BootstrapProgress) => {
      this.snapshot = {
        status: "running",
        attempt,
        updatedAt: new Date().toISOString(),
        dependency: progress.dependency,
        phase: progress.phase,
        detail: progress.detail,
      };
    };

    this.inFlight = (async () => {
      try {
        await this.runner(report);
        this.snapshot = {
          status: "ready",
          attempt,
          updatedAt: new Date().toISOString(),
          phase: "ready",
          detail: "ClawSpec dependencies are ready.",
        };
      } catch (error) {
        this.snapshot = {
          status: "failed",
          attempt,
          updatedAt: new Date().toISOString(),
          dependency: this.snapshot.dependency,
          phase: this.snapshot.phase,
          detail: this.snapshot.detail,
          error: error instanceof Error ? error.message : String(error),
        };
        this.onFailure?.(error);
      } finally {
        this.inFlight = undefined;
      }
    })();

    return await this.inFlight;
  }

  startInBackground(): void {
    void this.start();
  }

  reset(): void {
    this.inFlight = undefined;
    this.snapshot = {
      status: "idle",
      attempt: 0,
      updatedAt: new Date().toISOString(),
    };
  }
}

export function buildBootstrapPendingMessage(snapshot: BootstrapSnapshot): string {
  const detail = snapshot.detail?.trim() || "ClawSpec is preparing required dependencies.";
  return `${detail} Try again in a moment.`;
}

export function buildBootstrapFailureMessage(snapshot: BootstrapSnapshot): string {
  const detail = snapshot.detail?.trim() || "ClawSpec dependency bootstrap failed.";
  const error = snapshot.error?.trim();
  return [
    `${detail} Bootstrap failed.`,
    error ? `Reason: ${error}` : undefined,
    "Retrying dependency bootstrap in the background now. Try again in a moment.",
  ].filter(Boolean).join("\n");
}
