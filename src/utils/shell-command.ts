import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

export type ShellCommandResult = {
  code?: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
};

export function spawnShellCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): ChildProcessWithoutNullStreams {
  if (shouldUseShell(params.command)) {
    const commandLabel = buildShellCommand(params.command, params.args);
    return spawn(commandLabel, {
      cwd: params.cwd,
      env: params.env,
      shell: true,
      windowsHide: true,
    });
  }

  return spawn(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    shell: false,
    detached: true,
  });
}

export async function runShellCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}): Promise<ShellCommandResult> {
  return await new Promise((resolve) => {
    const child = spawnShellCommand(params);
    let timeoutError: Error | undefined;
    const timeout = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? setTimeout(() => {
        timeoutError = new Error(`${params.command} timed out after ${params.timeoutMs}ms`);
        terminateChildProcess(child);
      }, params.timeoutMs)
      : undefined;

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    if (typeof params.input === "string") {
      child.stdin.end(params.input);
    } else {
      child.stdin.end();
    }

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        code: undefined,
        stdout,
        stderr,
        error,
      });
    });

    child.on("close", (code, signal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        code,
        stdout,
        stderr,
        signal,
        killed: child.killed,
        error: timeoutError,
      });
    });
  });
}

export function terminateChildProcess(
  child: Pick<ChildProcess, "pid" | "killed" | "kill">,
  options?: { force?: boolean },
): void {
  if (child.killed) {
    return;
  }

  const force = options?.force === true;
  const pid = typeof child.pid === "number" && Number.isFinite(child.pid) ? child.pid : undefined;
  if (process.platform === "win32") {
    if (pid) {
      try {
        const killer = spawn("taskkill", [
          "/PID",
          String(pid),
          "/T",
          "/F",
        ], {
          stdio: "ignore",
          windowsHide: true,
          shell: false,
        });
        killer.unref();
      } catch {
        // Fall back to killing the direct child below.
      }
    }
    try {
      child.kill();
    } catch {
      return;
    }
    return;
  }

  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  if (pid && pid > 0) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        return;
      }
    }
  } else {
    try {
      child.kill(signal);
    } catch {
      return;
    }
  }

  if (!force) {
    const escalator = setTimeout(() => {
      terminateChildProcess(child, { force: true });
    }, 1_000);
    escalator.unref?.();
  }
}

export function isMissingCommandResult(result: ShellCommandResult, command: string): boolean {
  const combined = `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`.toLowerCase();
  const normalizedCommand = command.toLowerCase();
  return combined.includes("not recognized")
    || combined.includes("not found")
    || combined.includes(`'${normalizedCommand}' is not recognized`)
    || combined.includes(`"${normalizedCommand}" is not recognized`);
}

export function describeCommandFailure(result: ShellCommandResult, label: string): string {
  if (result.error) {
    return result.error.message;
  }
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return stderr || stdout || `${label} exited with code ${result.code ?? "unknown"}`;
}

export function buildShellCommand(command: string, args: string[]): string {
  return [command, ...args].map((arg) => quoteShellArg(arg)).join(" ");
}

function quoteShellArg(arg: string): string {
  if (process.platform === "win32") {
    return quoteWindowsShellArg(arg);
  }
  return quotePosixShellArg(arg);
}

function shouldUseShell(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  const extension = path.extname(command).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return false;
  }

  return true;
}

function quoteWindowsShellArg(arg: string): string {
  if (arg.length === 0) {
    return "\"\"";
  }
  const escaped = arg
    .replace(/"/g, "\"\"")
    .replace(/%/g, "%%");
  if (!/[\s"&|<>^()!]/.test(arg)) {
    return escaped;
  }
  return `"${escaped}"`;
}

function quotePosixShellArg(arg: string): string {
  if (arg.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
