import type { ExecutionResult, OpenSpecCommandResult, TaskCountSummary } from "../types.ts";
import { takeLineExcerpt } from "./fs.ts";

export function fence(text: string, language = ""): string {
  return `\`\`\`${language}\n${text}\n\`\`\``;
}

export function formatCommandOutputSection(results: OpenSpecCommandResult<unknown>[]): string {
  if (results.length === 0) {
    return "";
  }

  const lines = ["## OpenSpec Commands", ""];
  for (const result of results) {
    lines.push(`- \`${result.command}\``);
    lines.push(`- cwd: \`${result.cwd}\``);
    lines.push(`- duration: ${result.durationMs}ms`);
    const parsedSummary = summarizeParsedCommand(result);
    if (parsedSummary) {
      lines.push(`- ${parsedSummary}`);
    }
    const stdoutExcerpt = shouldShowRawStdout(result)
      ? takeMeaningfulExcerpt(result.stdout)
      : "";
    if (stdoutExcerpt.length > 0) {
      lines.push(fence(stdoutExcerpt, "text"));
    }
    const stderrExcerpt = takeMeaningfulExcerpt(result.stderr);
    if (stderrExcerpt.length > 0) {
      lines.push(fence(stderrExcerpt, "text"));
    }
  }
  return lines.join("\n");
}

export function formatExecutionSummary(result: ExecutionResult): string {
  const lines = [
    `Status: ${result.status}`,
    `Summary: ${result.summary}`,
  ];

  if (result.completedTask) {
    lines.push(`Completed Task: ${result.completedTask}`);
  }
  if (result.currentArtifact) {
    lines.push(`Artifact: ${result.currentArtifact}`);
  }
  if (result.changedFiles.length > 0) {
    lines.push("Files Changed:");
    for (const changedFile of result.changedFiles) {
      lines.push(`- ${changedFile}`);
    }
  }
  if (result.notes.length > 0) {
    lines.push("Notes:");
    for (const note of result.notes) {
      lines.push(`- ${note}`);
    }
  }
  if (typeof result.remainingTasks === "number") {
    lines.push(`Remaining Tasks: ${result.remainingTasks}`);
  }
  if (result.blocker) {
    lines.push(`Blocker: ${result.blocker}`);
  }
  return lines.join("\n");
}

export function formatTaskCounts(counts: TaskCountSummary | undefined): string {
  if (!counts) {
    return "Task counts: unavailable";
  }
  return `Task counts: ${counts.complete}/${counts.total} complete, ${counts.remaining} remaining`;
}

export function heading(title: string): string {
  return `## ${title}`;
}

function shouldShowRawStdout(result: OpenSpecCommandResult<unknown>): boolean {
  return !(result.command.includes("--json") && result.parsed !== undefined);
}

function takeMeaningfulExcerpt(text: string): string {
  const excerpt = takeLineExcerpt(text);
  if (excerpt.length === 0) {
    return "";
  }

  const lines = excerpt
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !/^loading\b/i.test(line));

  return lines.join("\n");
}

function summarizeParsedCommand(result: OpenSpecCommandResult<unknown>): string | undefined {
  const parsed = result.parsed;
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const value = parsed as Record<string, unknown>;
  if (typeof value.schemaName === "string" && Array.isArray(value.artifacts)) {
    const doneCount = value.artifacts.filter((artifact) =>
      artifact && typeof artifact === "object" && (artifact as Record<string, unknown>).status === "done"
    ).length;
    return `status summary: schema \`${value.schemaName}\`, ${doneCount}/${value.artifacts.length} artifacts done`;
  }

  if (
    typeof value.artifactId === "string" &&
    typeof value.outputPath === "string" &&
    typeof value.schemaName === "string"
  ) {
    return `artifact summary: \`${value.artifactId}\` -> \`${value.outputPath}\` (${value.schemaName})`;
  }

  if (
    typeof value.state === "string" &&
    value.progress &&
    typeof value.progress === "object" &&
    typeof (value.progress as Record<string, unknown>).complete === "number" &&
    typeof (value.progress as Record<string, unknown>).total === "number"
  ) {
    const progress = value.progress as Record<string, unknown>;
    return `apply summary: ${progress.complete}/${progress.total} tasks complete, state \`${value.state}\``;
  }

  if (typeof value.valid === "boolean") {
    return `validation summary: ${value.valid ? "valid" : "invalid"}`;
  }

  return result.command.includes("--json") ? "JSON response parsed successfully" : undefined;
}
