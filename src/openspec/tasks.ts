import { readUtf8 } from "../utils/fs.ts";
import type { ParsedTask, ParsedTaskList } from "../types.ts";

const TASK_LINE_RE = /^- \[( |x)\] ([0-9.]+)\s+(.*)$/i;

export function parseTasksMarkdown(markdown: string): ParsedTaskList {
  const tasks: ParsedTask[] = [];
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = TASK_LINE_RE.exec(line);
    if (!match) {
      return;
    }
    tasks.push({
      raw: line,
      lineNumber: index + 1,
      checked: match[1].toLowerCase() === "x",
      taskId: match[2],
      description: match[3].trim(),
    });
  });

  const complete = tasks.filter((task) => task.checked).length;
  return {
    tasks,
    counts: {
      total: tasks.length,
      complete,
      remaining: tasks.length - complete,
    },
  };
}

export async function parseTasksFile(filePath: string): Promise<ParsedTaskList> {
  return parseTasksMarkdown(await readUtf8(filePath));
}

export function getNextIncompleteTask(taskList: ParsedTaskList): ParsedTask | undefined {
  return taskList.tasks.find((task) => !task.checked);
}
