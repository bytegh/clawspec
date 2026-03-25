export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error("Unterminated quoted argument.");
  }

  if (escaping) {
    current += "\\";
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function splitSubcommand(rawArgs: string | undefined): {
  subcommand: string;
  rest: string;
} {
  const trimmed = (rawArgs ?? "").trim();
  if (trimmed.length === 0) {
    return { subcommand: "", rest: "" };
  }

  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace === -1) {
    return { subcommand: trimmed.toLowerCase(), rest: "" };
  }

  return {
    subcommand: trimmed.slice(0, firstWhitespace).toLowerCase(),
    rest: trimmed.slice(firstWhitespace + 1).trim(),
  };
}

export function removeFlag(tokens: string[], flag: string): {
  tokens: string[];
  present: boolean;
} {
  const filtered = tokens.filter((token) => token !== flag);
  return {
    tokens: filtered,
    present: filtered.length !== tokens.length,
  };
}
