import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { ensureDir, readUtf8, removeIfExists } from "../utils/fs.ts";

type FileLockOptions = {
  retries?: number;
  delayMs?: number;
  staleMs?: number;
};

const activeLocks = new Map<string, Promise<void>>();
const DEFAULT_LOCK_RETRIES = 400;
const DEFAULT_LOCK_DELAY_MS = 25;
const DEFAULT_LOCK_STALE_MS = 60_000;

export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  await ensureDir(path.dirname(lockPath));
  const previous = activeLocks.get(lockPath) ?? Promise.resolve();
  let releaseLock: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  activeLocks.set(lockPath, previous.then(() => current));

  await previous;

  const token = randomUUID();
  let handle: Awaited<ReturnType<typeof acquireLockHandle>> | undefined;

  try {
    handle = await acquireLockHandle(lockPath, token, options);
    return await action();
  } finally {
    await handle?.close().catch(() => undefined);
    if (handle) {
      await releaseLockFile(lockPath, token);
    }
    releaseLock?.();
    if (activeLocks.get(lockPath) === current) {
      activeLocks.delete(lockPath);
    }
  }
}

async function acquireLockHandle(
  lockPath: string,
  token: string,
  options?: FileLockOptions,
) {
  const retries = options?.retries ?? DEFAULT_LOCK_RETRIES;
  const delayMs = options?.delayMs ?? DEFAULT_LOCK_DELAY_MS;
  const staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;

  let attempt = 0;
  while (attempt <= retries) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({
        token,
        pid: process.pid,
        acquiredAt: Date.now(),
      }), "utf8");
      return handle;
    } catch (error) {
      const code = getErrorCode(error);
      if (code !== "EEXIST") {
        throw error;
      }

      if (await isLockStale(lockPath, staleMs)) {
        await removeIfExists(lockPath);
        continue;
      }

      if (attempt === retries) {
        throw new Error(`timed out waiting for lock ${lockPath}`);
      }

      attempt += 1;
      await delay(delayMs);
    }
  }

  throw new Error(`timed out waiting for lock ${lockPath}`);
}

async function isLockStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const metadata = JSON.parse(await readUtf8(lockPath)) as { acquiredAt?: unknown };
    if (typeof metadata.acquiredAt === "number" && Number.isFinite(metadata.acquiredAt)) {
      return (Date.now() - metadata.acquiredAt) > staleMs;
    }
  } catch {
    // Fall through to stat-based detection.
  }

  try {
    const details = await stat(lockPath);
    return (Date.now() - details.mtimeMs) > staleMs;
  } catch {
    return false;
  }
}

async function releaseLockFile(lockPath: string, token: string): Promise<void> {
  try {
    const metadata = JSON.parse(await readUtf8(lockPath)) as { token?: unknown };
    if (metadata.token !== token) {
      return;
    }
  } catch {
    return;
  }
  await removeIfExists(lockPath);
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
