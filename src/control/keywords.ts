import { debugLog } from "../utils/debug-log.ts";

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
  debugLog(`[extractEmbeddedClawSpecKeyword] text length=${text.length}`);
  const direct = parseClawSpecKeyword(text);
  if (direct) {
    debugLog(`[extractEmbeddedClawSpecKeyword] Found direct: ${direct.command}`);
    return direct;
  }

  const lines = text.split(/\r?\n/);
  debugLog(`[extractEmbeddedClawSpecKeyword] Checking ${lines.length} lines`);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    debugLog(`[extractEmbeddedClawSpecKeyword] Line: "${trimmed.substring(0, 50)}..."`);

    // Try parsing the whole line first
    const parsed = parseClawSpecKeyword(trimmed);
    if (parsed) {
      debugLog(`[extractEmbeddedClawSpecKeyword] Found in line: ${parsed.command}`);
      return parsed;
    }

    // Try each word in the line
    const words = trimmed.split(/\s+/);
    debugLog(`[extractEmbeddedClawSpecKeyword] Checking ${words.length} words`);
    for (const word of words) {
      const wordParsed = parseClawSpecKeyword(word);
      if (wordParsed) {
        debugLog(`[extractEmbeddedClawSpecKeyword] Found in word: ${wordParsed.command}`);
        return wordParsed;
      }
    }
  }

  debugLog(`[extractEmbeddedClawSpecKeyword] No keyword found`);
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
