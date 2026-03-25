import { spawn } from "node:child_process";
import { stripAnsi } from "../utils/fs.ts";
import { prependPathEntries } from "../utils/env-path.ts";
import type {
  OpenSpecApplyInstructionsResponse,
  OpenSpecCommandResult,
  OpenSpecInstructionsResponse,
  OpenSpecStatusResponse,
  OpenSpecValidationResponse,
} from "../types.ts";

type OpenSpecClientOptions = {
  timeoutMs: number;
  command?: string;
  extraPathEntries?: string[];
};

export class OpenSpecCommandError extends Error {
  readonly result: OpenSpecCommandResult<unknown>;

  constructor(message: string, result: OpenSpecCommandResult<unknown>) {
    super(message);
    this.result = result;
  }
}

export class OpenSpecClient {
  readonly timeoutMs: number;
  readonly command: string;
  readonly extraPathEntries: string[];

  constructor(options: OpenSpecClientOptions) {
    this.timeoutMs = options.timeoutMs;
    this.command = options.command ?? "openspec";
    this.extraPathEntries = options.extraPathEntries ?? [];
  }

  async init(repoPath: string): Promise<OpenSpecCommandResult> {
    return this.runText(["init", "--tools", "none", "."], repoPath);
  }

  async newChange(
    repoPath: string,
    changeName: string,
    description?: string,
  ): Promise<OpenSpecCommandResult> {
    const args = ["new", "change", changeName];
    if (description && description.trim().length > 0) {
      args.push("--description", description);
    }
    return this.runText(args, repoPath);
  }

  async status(repoPath: string, changeName: string): Promise<OpenSpecCommandResult<OpenSpecStatusResponse>> {
    return this.runJson<OpenSpecStatusResponse>(
      ["status", "--change", changeName, "--json"],
      repoPath,
    );
  }

  async instructionsArtifact(
    repoPath: string,
    artifactId: string,
    changeName: string,
  ): Promise<OpenSpecCommandResult<OpenSpecInstructionsResponse>> {
    return this.runJson<OpenSpecInstructionsResponse>(
      ["instructions", artifactId, "--change", changeName, "--json"],
      repoPath,
    );
  }

  async instructionsApply(
    repoPath: string,
    changeName: string,
  ): Promise<OpenSpecCommandResult<OpenSpecApplyInstructionsResponse>> {
    return this.runJson<OpenSpecApplyInstructionsResponse>(
      ["instructions", "apply", "--change", changeName, "--json"],
      repoPath,
    );
  }

  async validate(repoPath: string, changeName: string): Promise<OpenSpecCommandResult<OpenSpecValidationResponse>> {
    return this.runJson<OpenSpecValidationResponse>(
      ["validate", changeName, "--type", "change", "--json", "--no-interactive"],
      repoPath,
    );
  }

  async archive(repoPath: string, changeName: string): Promise<OpenSpecCommandResult> {
    return this.runText(["archive", changeName, "-y"], repoPath);
  }

  private async runText(args: string[], cwd: string): Promise<OpenSpecCommandResult> {
    return this.execute(args, cwd);
  }

  private async runJson<T>(args: string[], cwd: string): Promise<OpenSpecCommandResult<T>> {
    return this.execute<T>(args, cwd);
  }

  private execute<T>(args: string[], cwd: string): Promise<OpenSpecCommandResult<T>> {
    const commandLabel = buildShellCommand(this.command, args);
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(commandLabel, {
        cwd,
        shell: true,
        windowsHide: true,
        env: prependPathEntries({
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          CI: "1",
        }, this.extraPathEntries),
      });

      let stdout = "";
      let stderr = "";
      let completed = false;

      const timer = setTimeout(() => {
        child.kill();
      }, this.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        completed = true;
        reject(
          new OpenSpecCommandError(error.message, {
            command: commandLabel,
            cwd,
            stdout,
            stderr,
            durationMs: Date.now() - startedAt,
          }),
        );
      });

      child.on("close", (exitCode) => {
        if (completed) {
          return;
        }
        clearTimeout(timer);
        const result: OpenSpecCommandResult<T> = {
          command: commandLabel,
          cwd,
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr),
          durationMs: Date.now() - startedAt,
        };

        if (exitCode !== 0) {
          reject(new OpenSpecCommandError(`OpenSpec command failed: ${commandLabel}`, result));
          return;
        }

        if (args.includes("--json")) {
          try {
            result.parsed = extractJsonFromMixedOutput<T>(`${stdout}\n${stderr}`);
          } catch (error) {
            reject(
              new OpenSpecCommandError(
                error instanceof Error ? error.message : "Failed to parse OpenSpec JSON output.",
                result,
              ),
            );
            return;
          }
        }

        resolve(result);
      });
    });
  }
}

function buildShellCommand(command: string, args: string[]): string {
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

function extractJsonFromMixedOutput<T>(text: string): T {
  const cleaned = stripAnsi(text);
  const firstBraceIndex = cleaned.search(/[\[{]/);
  if (firstBraceIndex === -1) {
    throw new Error("No JSON object or array found in OpenSpec output.");
  }

  const jsonSlice = findBalancedJson(cleaned.slice(firstBraceIndex));
  return JSON.parse(jsonSlice) as T;
}

function findBalancedJson(text: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (!started) {
      if (char === "{" || char === "[") {
        started = true;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(0, index + 1);
      }
    }
  }

  throw new Error("OpenSpec output contained incomplete JSON.");
}
