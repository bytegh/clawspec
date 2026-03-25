import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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
  const commandLabel = buildShellCommand(params.command, params.args);
  return spawn(commandLabel, {
    cwd: params.cwd,
    env: params.env,
    shell: true,
    windowsHide: true,
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
    const timeout = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? setTimeout(() => {
        try {
          child.kill();
        } catch {
          return;
        }
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
      });
    });
  });
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
