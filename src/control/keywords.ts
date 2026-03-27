export type ClawSpecKeywordKind =
  | "plan"
  | "work"
  | "attach"
  | "detach"
  | "pause"
  | "continue"
  | "status"
  | "cancel";

export type ClawSpecKeywordIntent = {
  kind: ClawSpecKeywordKind;
  command: string;
  args: string;
  raw: string;
};

const COMMAND_ALIASES: Record<string, ClawSpecKeywordKind> = {
  "cs-plan": "plan",
  "cs-work": "work",
  "cs-attach": "attach",
  "cs-detach": "detach",
  "cs-deattach": "detach",
  "cs-pause": "pause",
  "cs-continue": "continue",
  "cs-status": "status",
  "cs-cancel": "cancel",
};

export function parseClawSpecKeyword(text: string): ClawSpecKeywordIntent | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const firstWhitespace = trimmed.search(/\s/);
  const rawCommand = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
  const normalizedCommand = normalizeKeywordCommand(rawCommand);
  const kind = COMMAND_ALIASES[normalizedCommand];
  if (!kind) {
    return null;
  }

  return {
    kind,
    command: normalizedCommand,
    args: firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace + 1).trim(),
    raw: trimmed,
  };
}

export function isClawSpecKeywordText(text: string): boolean {
  return parseClawSpecKeyword(text) !== null;
}

export function extractEmbeddedClawSpecKeyword(text: string): ClawSpecKeywordIntent | null {
  const direct = parseClawSpecKeyword(text);
  if (direct) {
    return direct;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const parsed = parseClawSpecKeyword(trimmed);
    if (parsed) {
      return parsed;
    }

    // Try to extract keyword from end of line (after timestamp prefix)
    const lastWord = trimmed.split(/\s+/).pop();
    if (lastWord) {
      const lastParsed = parseClawSpecKeyword(lastWord);
      if (lastParsed) {
        return lastParsed;
      }
    }
  }

  return null;
}

function normalizeKeywordCommand(rawCommand: string): string {
  return rawCommand
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^\/+/, "")
    .replace(/[。！？!?,，；;：:]+$/u, "")
    .toLowerCase();
}
