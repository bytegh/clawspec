export function prependPathEntries(
  env: NodeJS.ProcessEnv | undefined,
  entries: string[],
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...(env ?? process.env) };
  const cleanEntries = entries
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (cleanEntries.length === 0) {
    return nextEnv;
  }

  const pathKey = findPathKey(nextEnv);
  const current = nextEnv[pathKey] ?? "";
  const parts = current
    .split(process.platform === "win32" ? ";" : ":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const merged = [...cleanEntries, ...parts.filter((part) => !cleanEntries.includes(part))];
  nextEnv[pathKey] = merged.join(process.platform === "win32" ? ";" : ":");
  return nextEnv;
}

function findPathKey(env: NodeJS.ProcessEnv): string {
  const existing = Object.keys(env).find((key) => key.toLowerCase() === "path");
  if (existing) {
    return existing;
  }
  return process.platform === "win32" ? "Path" : "PATH";
}
