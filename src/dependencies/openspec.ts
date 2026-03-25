import { spawn } from "node:child_process";
import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { prependPathEntries } from "../utils/env-path.ts";

export const OPENSPEC_PACKAGE_NAME = "@fission-ai/openspec";

type CommandResult = {
  code?: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type CommandRunner = (params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<CommandResult>;

export type EnsureOpenSpecCliOptions = {
  pluginRoot: string;
  logger?: PluginLogger;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
};

export type EnsureOpenSpecCliResult = {
  source: "local" | "global";
  version: string;
  localBinDir: string;
};

export async function ensureOpenSpecCli(
  options: EnsureOpenSpecCliOptions,
): Promise<EnsureOpenSpecCliResult> {
  const runner = options.runner ?? runCommand;
  const localBinDir = path.join(options.pluginRoot, "node_modules", ".bin");
  const localCommand = path.join(
    localBinDir,
    process.platform === "win32" ? "openspec.cmd" : "openspec",
  );
  const env = prependPathEntries(options.env, [localBinDir]);

  const localCheck = await checkOpenSpecVersion(runner, {
    command: localCommand,
    cwd: options.pluginRoot,
    env,
  });
  if (localCheck.ok) {
    options.logger?.info?.(`[clawspec] openspec CLI ready from plugin-local install (version ${localCheck.version})`);
    return {
      source: "local",
      version: localCheck.version,
      localBinDir,
    };
  }

  const globalCheck = await checkOpenSpecVersion(runner, {
    command: "openspec",
    cwd: options.pluginRoot,
    env,
  });
  if (globalCheck.ok) {
    options.logger?.info?.(`[clawspec] openspec CLI ready from PATH (version ${globalCheck.version})`);
    return {
      source: "global",
      version: globalCheck.version,
      localBinDir,
    };
  }

  options.logger?.warn?.(
    `[clawspec] openspec CLI not found (${globalCheck.message}); installing plugin-local ${OPENSPEC_PACKAGE_NAME}`,
  );

  const install = await runner({
    command: "npm",
    args: ["install", "--omit=dev", "--no-save", OPENSPEC_PACKAGE_NAME],
    cwd: options.pluginRoot,
    env,
  });
  if (install.error || (install.code ?? 0) !== 0) {
    if (isMissingCommandResult(install, "npm")) {
      throw new Error("npm is required to install plugin-local openspec but was not found on PATH");
    }
    throw new Error(
      `failed to install plugin-local openspec: ${describeCommandFailure(install, "npm install")}`,
    );
  }

  const postcheck = await checkOpenSpecVersion(runner, {
    command: localCommand,
    cwd: options.pluginRoot,
    env,
  });
  if (!postcheck.ok) {
    throw new Error(`plugin-local openspec verification failed after install: ${postcheck.message}`);
  }

  options.logger?.info?.(`[clawspec] openspec plugin-local binary ready (version ${postcheck.version})`);
  return {
    source: "local",
    version: postcheck.version,
    localBinDir,
  };
}

async function checkOpenSpecVersion(
  runner: CommandRunner,
  params: {
    command: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<
  | { ok: true; version: string }
  | { ok: false; message: string }
> {
  const result = await runner({
    command: params.command,
    args: ["--version"],
    cwd: params.cwd,
    env: params.env,
  });
  if (result.error || (result.code ?? 0) !== 0) {
    return {
      ok: false,
      message: describeCommandFailure(result, params.command),
    };
  }
  const version = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).find((line) => line.trim())?.trim();
  if (!version) {
    return {
      ok: false,
      message: "openspec --version did not return a parseable version",
    };
  }
  return { ok: true, version };
}

async function runCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  const commandLabel = [params.command, ...params.args].join(" ");
  return await new Promise((resolve) => {
    const child = spawn(commandLabel, {
      cwd: params.cwd,
      env: params.env,
      shell: true,
      windowsHide: true,
    });

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

    child.on("error", (error) => {
      resolve({
        code: undefined,
        stdout,
        stderr,
        error,
      });
    });

    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
      });
    });
  });
}

function isMissingCommandResult(result: CommandResult, command: string): boolean {
  const combined = `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`.toLowerCase();
  const normalizedCommand = command.toLowerCase();
  return combined.includes("not recognized")
    || combined.includes("not found")
    || combined.includes(`'${normalizedCommand}' is not recognized`)
    || combined.includes(`"${normalizedCommand}" is not recognized`);
}

function describeCommandFailure(result: CommandResult, label: string): string {
  if (result.error) {
    return result.error.message;
  }
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return stderr || stdout || `${label} exited with code ${result.code ?? "unknown"}`;
}
