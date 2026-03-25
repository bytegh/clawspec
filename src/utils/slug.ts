export function slugify(input: string): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized.slice(0, 80) || `change-${Date.now()}`;
}

export function deriveProjectTitle(description: string): string {
  const firstLine = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine && firstLine.length <= 80) {
    return firstLine;
  }
  return slugToTitle(slugify(description));
}

export function deriveChangeName(description: string): string {
  return slugify(description);
}

export function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function createProjectId(now = new Date()): string {
  const stamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join("");
  const random = Math.random().toString(36).slice(2, 8);
  return `clawspec-${stamp}-${random}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
