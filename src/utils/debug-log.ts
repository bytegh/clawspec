import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LOG_FILE = path.join(homedir(), ".openclaw", "clawspec-debug.log");

export function debugLog(message: string): void {
  try {
    const timestamp = new Date().toISOString();
    appendFileSync(LOG_FILE, `${timestamp} ${message}\n`);
  } catch {
    // ignore
  }
}
