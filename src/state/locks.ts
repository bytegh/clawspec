import { open } from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists, readUtf8, removeIfExists } from "../utils/fs.ts";

type FileLockOptions = {
  retries?: number;
  delayMs?: number;
  staleMs?: number;
};

const activeLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  _options?: FileLockOptions,
): Promise<T> {
  await ensureDir(path.dirname(lockPath));
  const previous = activeLocks.get(lockPath) ?? Promise.resolve();
  let releaseLock: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  activeLocks.set(lockPath, previous.then(() => current));

  await previous;

  const handle = await open(lockPath, "w").catch(() => undefined);
  if (handle) {
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");
  }

  try {
    return await action();
  } finally {
    await handle?.close().catch(() => undefined);
    await removeIfExists(lockPath);
    releaseLock?.();
    if (activeLocks.get(lockPath) === current) {
      activeLocks.delete(lockPath);
    }
  }
}
