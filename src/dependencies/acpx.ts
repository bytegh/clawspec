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
  onInstallStart?: (info: { packageName: string; reason: string; expectedVersion: string }) => void | Promise<void>;
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
  await options.onInstallStart?.({
    packageName: ACPX_PACKAGE_NAME,
    reason: globalCheck.message,
    expectedVersion,
  });

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
  if (compareSemver(version, params.expectedVersion) < 0) {
    return {
      ok: false,
      message: `acpx version too old: found ${version}, require >= ${params.expectedVersion}`,
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

function compareSemver(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  for (let index = 0; index < 3; index += 1) {
    const delta = parsedLeft.core[index] - parsedRight.core[index];
    if (delta !== 0) {
      return delta;
    }
  }

  const leftPre = parsedLeft.prerelease;
  const rightPre = parsedRight.prerelease;
  if (leftPre.length === 0 && rightPre.length === 0) {
    return 0;
  }
  if (leftPre.length === 0) {
    return 1;
  }
  if (rightPre.length === 0) {
    return -1;
  }

  const maxLength = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftToken = leftPre[index];
    const rightToken = rightPre[index];
    if (leftToken === undefined) {
      return -1;
    }
    if (rightToken === undefined) {
      return 1;
    }
    const delta = comparePrereleaseToken(leftToken, rightToken);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function parseSemver(value: string): { core: [number, number, number]; prerelease: string[] } | null {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return null;
  }
  return {
    core: [
      Number.parseInt(match[1]!, 10),
      Number.parseInt(match[2]!, 10),
      Number.parseInt(match[3]!, 10),
    ],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleaseToken(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
}
