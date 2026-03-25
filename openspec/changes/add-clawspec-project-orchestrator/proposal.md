## Why

The current plugin implementation already proves the basic idea, but it is still shaped around an older command surface and a `subagent` execution model that does not cleanly match how OpenSpec is normally used. The workflow needs to be tightened around `workspace -> project -> change`, preserve OpenSpec as the source of truth, capture planning discussion between `/project proposal` and `/project apply`, and add a safe `/project cancel` that can restore only this change's modifications.

## What Changes

- Replace the old `remember/path/desc/run` setup flow with a workspace-first command surface centered on `/project workspace`, `/project use`, `/project proposal`, `/project apply`, `/project continue`, `/project pause`, `/project status`, `/project archive`, and `/project cancel`.
- Persist the current workspace and workspace history so users can switch among multiple repos without repeatedly pasting absolute paths, while keeping project selection constrained to the active workspace.
- Keep OpenSpec unchanged, but align the plugin with OpenSpec's real workflow by creating the change on `/project proposal`, recording planning discussion after proposal, and running a planning sync before `/project apply` or `/project continue` when new discussion needs to be folded back into `proposal.md`, `specs`, `design.md`, or `tasks.md`.
- Replace the current execution plane with an ACP-backed persistent worker session that uses public OpenClaw plugin SDK exports, works task-by-task from `tasks.md`, and reports concise milestone summaries instead of opaque background runs.
- Add a rollback system under `.openclaw/clawspec/` that keeps a change-scoped baseline snapshot and touched-file manifest so `/project cancel` can restore only files affected by the current change, remove generated OpenSpec change artifacts, and leave unrelated repo state alone.
- Continue surfacing OpenSpec CLI output to the user so proposal, planning sync, apply, validate, archive, and cancel actions remain transparent.

## Capabilities

### New Capabilities
- `project-lifecycle-control`: Manage one active project per channel with workspace selection, proposal/apply alignment, pause/continue semantics, status reporting, and cancel/archive controls.
- `project-directory-memory`: Persist workspace history, list workspace projects, select or create a project inside the workspace, and remember the current workspace across sessions.
- `openspec-planning-bootstrap`: Create and sync OpenSpec artifacts from the plugin without modifying OpenSpec itself, while preserving the canonical `openspec/changes/<change>/...` layout.
- `worker-task-orchestration`: Use an ACP-backed persistent worker to plan, sync, and implement tasks sequentially from `tasks.md` with milestone reporting and guardrails.
- `project-archive-recovery`: Persist planning journals, execution metadata, rollback snapshots, archive summaries, and change-scoped recovery files under `.openclaw/clawspec/`.

### Modified Capabilities
- None.

## Impact

- Refactors the existing plugin around a clearer state model: workspace, selected project, active change, planning journal, ACP session binding, and rollback manifest.
- Adds plugin-managed hooks for recording post-proposal planning notes so later apply turns can sync those notes back into OpenSpec artifacts.
- Depends on OpenClaw's public ACP runtime backend exports rather than internal OpenClaw ACP manager internals, which keeps the plugin aligned with supported plugin APIs.
- Increases repo-local storage under `.openclaw/clawspec/` to support baseline snapshots, touched-file manifests, planning journals, progress logs, and archive bundles.
- Requires stronger command-transition validation so users cannot switch workspace/project or start a new proposal while an ACP execution is still active.
