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
  if (!trimmed.toLowerCase().startsWith("cs-")) {
    return null;
  }

  const firstWhitespace = trimmed.search(/\s/);
  const rawCommand = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
  const kind = COMMAND_ALIASES[rawCommand.toLowerCase()];
  if (!kind) {
    return null;
  }

  return {
    kind,
    command: rawCommand.toLowerCase(),
    args: firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace + 1).trim(),
    raw: trimmed,
  };
}

export function isClawSpecKeywordText(text: string): boolean {
  return parseClawSpecKeyword(text) !== null;
}

const EMBEDDED_KEYWORD_PATTERN = new RegExp(
  `(?:^|\\r?\\n)\\s*(cs-(?:${Object.keys(COMMAND_ALIASES).map((k) => k.slice(3)).join("|")})(?:[^\\S\\r\\n]+[^\\r\\n]+)?)\\s*(?=\\r?\\n|$)`,
  "i",
);

export function extractEmbeddedClawSpecKeyword(text: string): ClawSpecKeywordIntent | null {
  const direct = parseClawSpecKeyword(text);
  if (direct) {
    return direct;
  }

  const embeddedMatch = text.match(EMBEDDED_KEYWORD_PATTERN);
  if (!embeddedMatch?.[1]) {
    return null;
  }

  return parseClawSpecKeyword(embeddedMatch[1]);
}
