import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { prependPathEntries } from "../utils/env-path.ts";
import {
  describeCommandFailure,
  isMissingCommandResult,
  runShellCommand,
  type ShellCommandResult,
} from "../utils/shell-command.ts";

export const ACPX_PACKAGE_NAME = "acpx";
export const ACPX_EXPECTED_VERSION = "0.3.1";

type CommandRunner = (params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<ShellCommandResult>;

export type EnsureAcpxCliOptions = {
  pluginRoot: string;
  logger?: PluginLogger;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  expectedVersion?: string;
  runtimeEntrypoint?: string;
};

export type EnsureAcpxCliResult = {
  source: "local" | "builtin" | "global";
  version: string;
  localBinDir: string;
  command: string;
  env: NodeJS.ProcessEnv;
};

export async function ensureAcpxCli(
  options: EnsureAcpxCliOptions,
): Promise<EnsureAcpxCliResult> {
  const runner = options.runner ?? runCommand;
  const expectedVersion = options.expectedVersion?.trim() || ACPX_EXPECTED_VERSION;
  const localBinDir = path.join(options.pluginRoot, "node_modules", ".bin");
  const localCommand = path.join(
    localBinDir,
    process.platform === "win32" ? "acpx.cmd" : "acpx",
  );
  const env = prependPathEntries(options.env, [localBinDir]);
  const builtinCommand = getBuiltInAcpxCommand(options.runtimeEntrypoint ?? process.argv[1]);

  const localCheck = await checkAcpxVersion(runner, {
    command: localCommand,
    cwd: options.pluginRoot,
    env,
    expectedVersion,
  });
  if (localCheck.ok) {
    options.logger?.info?.(`[clawspec] acpx CLI ready from plugin-local install (version ${localCheck.version})`);
    return {
      source: "local",
      version: localCheck.version,
      localBinDir,
      command: localCommand,
      env,
    };
  }

  if (builtinCommand) {
    const builtinCheck = await checkAcpxVersion(runner, {
      command: builtinCommand,
      cwd: options.pluginRoot,
      env,
      expectedVersion,
    });
    if (builtinCheck.ok) {
      options.logger?.info?.(`[clawspec] acpx CLI ready from OpenClaw builtin install (version ${builtinCheck.version})`);
      return {
        source: "builtin",
        version: builtinCheck.version,
        localBinDir,
        command: builtinCommand,
        env,
      };
    }
  }

  const globalCheck = await checkAcpxVersion(runner, {
    command: "acpx",
    cwd: options.pluginRoot,
    env,
    expectedVersion,
  });
  if (globalCheck.ok) {
    options.logger?.info?.(`[clawspec] acpx CLI ready from PATH (version ${globalCheck.version})`);
    return {
      source: "global",
      version: globalCheck.version,
      localBinDir,
      command: "acpx",
      env,
    };
  }

  options.logger?.warn?.(
    `[clawspec] acpx CLI not ready (${globalCheck.message}); installing plugin-local ${ACPX_PACKAGE_NAME}@${expectedVersion}`,
  );

  const install = await runner({
    command: "npm",
    args: [
      "install",
      "--omit=dev",
      "--no-save",
      "--package-lock=false",
      `${ACPX_PACKAGE_NAME}@${expectedVersion}`,
    ],
    cwd: options.pluginRoot,
    env,
  });
  if (install.error || (install.code ?? 0) !== 0) {
    if (isMissingCommandResult(install, "npm")) {
      throw new Error("npm is required to install plugin-local acpx but was not found on PATH");
    }
    throw new Error(
      `failed to install plugin-local acpx: ${describeCommandFailure(install, "npm install")}`,
    );
  }

  const postcheck = await checkAcpxVersion(runner, {
    command: localCommand,
    cwd: options.pluginRoot,
    env,
    expectedVersion,
  });
  if (!postcheck.ok) {
    throw new Error(`plugin-local acpx verification failed after install: ${postcheck.message}`);
  }

  options.logger?.info?.(`[clawspec] acpx plugin-local binary ready (version ${postcheck.version})`);
  return {
    source: "local",
    version: postcheck.version,
    localBinDir,
    command: localCommand,
    env,
  };
}

async function checkAcpxVersion(
  runner: CommandRunner,
  params: {
    command: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    expectedVersion: string;
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

  const version = `${result.stdout}\n${result.stderr}`.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
  if (!version) {
    return {
      ok: false,
      message: "acpx --version did not return a parseable version",
    };
  }
  if (version !== params.expectedVersion) {
    return {
      ok: false,
      message: `acpx version mismatch: found ${version}, expected ${params.expectedVersion}`,
    };
  }
  return { ok: true, version };
}

async function runCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ShellCommandResult> {
  return await runShellCommand(params);
}

function getBuiltInAcpxCommand(runtimeEntrypoint: string | undefined): string | undefined {
  if (!runtimeEntrypoint || runtimeEntrypoint === "-") {
    return undefined;
  }
  const entry = path.resolve(runtimeEntrypoint);
  if (path.basename(entry) !== "index.js") {
    return undefined;
  }
  const distDir = path.dirname(entry);
  if (path.basename(distDir) !== "dist") {
    return undefined;
  }
  const packageRoot = path.dirname(distDir);
  return path.join(
    packageRoot,
    "dist",
    "extensions",
    "acpx",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "acpx.cmd" : "acpx",
  );
}
