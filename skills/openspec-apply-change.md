---
name: openspec-apply-change
description: Implement tasks from an OpenSpec change. Use when the user wants to start implementing, continue implementation, or work through tasks.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.2.0"
---

Implement tasks from an OpenSpec change.

Input: Optionally specify a change name. If omitted, infer it from context when possible. If ambiguous, ask the user to choose from available changes.

Steps

1. Select the change

- If a name is provided, use it.
- Otherwise infer it from the conversation.
- If only one active change exists, auto-select it.
- If still ambiguous, run `openspec list --json` and ask the user to choose.
- Always announce: `Using change: <name>`.

2. Check status

```bash
openspec status --change "<name>" --json
```

Use the JSON to understand:

- `schemaName`
- which artifact contains tasks

3. Get apply instructions

```bash
openspec instructions apply --change "<name>" --json
```

Use the returned data for:

- `contextFiles`
- task progress
- remaining tasks
- dynamic instruction text

Handle states:

- If `state` is `blocked`, explain the blocker and suggest continuing after planning/artifact fixes.
- If `state` is `all_done`, report completion and suggest archiving.
- Otherwise proceed to implementation.

4. Read context files

- Read every file listed in `contextFiles`.
- Do not assume fixed filenames; trust the CLI output.

5. Show progress

Display:

- schema
- `N/M tasks complete`
- remaining task overview
- the current apply instruction

6. Implement tasks

For each pending task:

- announce the task
- make the minimal focused code changes
- update the task checkbox in the tasks file from `- [ ]` to `- [x]` immediately after completion
- continue to the next task

Pause if:

- a task is ambiguous
- the implementation exposes a design problem
- an error or blocker is encountered
- the user interrupts

7. Finish or pause cleanly

When stopping, display:

- tasks completed in this session
- overall progress
- whether the change is complete or paused
- the next action needed

Output during implementation

```text
## Implementing: <change-name> (schema: <schema-name>)

Working on task 3/7: <task description>
[...implementation...]
Task complete
```

Output on completion

```text
## Implementation Complete

Change: <change-name>
Schema: <schema-name>
Progress: 7/7 tasks complete

Completed This Session
- [x] Task 1
- [x] Task 2

All tasks complete. Ready to archive.
```

Output on pause

```text
## Implementation Paused

Change: <change-name>
Schema: <schema-name>
Progress: 4/7 tasks complete

Issue Encountered
<description>

Options:
1. <option 1>
2. <option 2>
3. Other approach
```

Guardrails

- Keep going until done or truly blocked.
- Always read the context files first.
- Keep changes minimal and scoped.
- Do not guess through ambiguous requirements.
- Update the task checkbox immediately after each completed task.
- If implementation reveals planning problems, stop and suggest updating artifacts first.
