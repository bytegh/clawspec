import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const ATOMIC_WRITE_RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);
const ATOMIC_WRITE_RETRY_DELAYS_MS = [20, 60, 120, 250];

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

export async function readUtf8(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export async function tryReadUtf8(filePath: string): Promise<string | undefined> {
  try {
    return await readUtf8(filePath);
  } catch {
    return undefined;
  }
}

export async function writeUtf8(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  try {
    await renameWithRetry(tempPath, filePath);
  } catch (error) {
    const code = getErrorCode(error);
    if (!code || !ATOMIC_WRITE_RETRYABLE_CODES.has(code)) {
      await cleanupTempFile(tempPath);
      throw error;
    }

    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, content, "utf8");
    await cleanupTempFile(tempPath);
  }
}

export async function appendUtf8(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, content, "utf8");
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readUtf8(filePath);
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeUtf8(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function removeIfExists(targetPath: string): Promise<void> {
  try {
    await rm(targetPath, { force: true, recursive: true });
  } catch {
    return;
  }
}

export async function copyIfExists(sourcePath: string, destinationPath: string): Promise<void> {
  if (!(await pathExists(sourcePath))) {
    return;
  }
  await ensureDir(path.dirname(destinationPath));
  await copyFile(sourcePath, destinationPath, constants.COPYFILE_FICLONE_FORCE).catch(async () => {
    await copyFile(sourcePath, destinationPath);
  });
}

export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  if (!(await pathExists(rootDir))) {
    return [];
  }
  const results: string[] = [];
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function listDirectoryFiles(dirPath: string): Promise<string[]> {
  if (!(await pathExists(dirPath))) {
    return [];
  }
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(dirPath, entry.name));
}

async function renameWithRetry(sourcePath: string, destinationPath: string): Promise<void> {
  let lastError: unknown;
  for (const delayMs of [0, ...ATOMIC_WRITE_RETRY_DELAYS_MS]) {
    if (delayMs > 0) {
      await delay(delayMs);
    }

    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      const code = getErrorCode(error);
      if (!code || !ATOMIC_WRITE_RETRYABLE_CODES.has(code)) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "rename failed"));
}

async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    return;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listDirectories(rootDir: string): Promise<string[]> {
  if (!(await directoryExists(rootDir))) {
    return [];
  }
  const entries = await readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export function stripAnsi(input: string): string {
  return input.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;]*m/g,
    "",
  );
}

export function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/");
}

export function toPosixRelative(baseDir: string, targetPath: string): string {
  const relativePath = path.relative(baseDir, targetPath);
  return normalizeSlashes(relativePath || ".");
}

export async function resolveSimpleGlob(baseDir: string, pattern: string): Promise<string[]> {
  if (!pattern.includes("*")) {
    const exact = path.join(baseDir, pattern);
    return (await pathExists(exact)) ? [exact] : [];
  }

  const normalized = normalizeSlashes(pattern);
  if (normalized.endsWith("**/*.md")) {
    const prefix = normalized.slice(0, normalized.indexOf("**/*.md"));
    const root = path.join(baseDir, prefix);
    const files = await listFilesRecursive(root);
    return files.filter((filePath) => filePath.toLowerCase().endsWith(".md"));
  }

  const files = await listFilesRecursive(baseDir);
  const needle = normalized.replace(/\*\*/g, "").replace(/\*/g, "");
  return files.filter((filePath) => normalizeSlashes(path.relative(baseDir, filePath)).includes(needle));
}

export function takeLineExcerpt(text: string, maxLines = 12): string {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(0, maxLines).join("\n");
}
