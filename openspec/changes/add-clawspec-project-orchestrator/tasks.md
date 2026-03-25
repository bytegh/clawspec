## 1. State Model And File Layout

- [x] 1.1 Update shared types and enums so project state reflects the revised lifecycle: workspace-first selection, planning sync, ACP session binding, pause/cancel flags, and change-scoped rollback metadata.
- [x] 1.2 Extend `.openclaw/clawspec/` path helpers and support files to include `planning-journal.jsonl`, `rollback-manifest.json`, and `snapshots/<change>/baseline/...`.
- [x] 1.3 Add a planning journal store and rollback store that can append journal entries, persist touched-file manifests, and read or delete change-scoped state safely.

## 2. Command Surface And Lifecycle Rules

- [x] 2.1 Remove the old `remember/path/desc/init/run` behavior from the active flow and make `workspace`, `use`, `proposal`, `apply`, `continue`, `pause`, `status`, `archive`, and `cancel` the real command surface.
- [x] 2.2 Update lifecycle validation so `workspace`, `use`, `proposal`, and `archive` are blocked while a planning or implementation turn is active, with actionable guidance to pause or cancel first.
- [x] 2.3 Add `/project cancel` to clear the current change, restore touched files from snapshots, remove generated OpenSpec change artifacts, and keep the selected project intact.
- [x] 2.4 Refresh `/project status` and help output so they report planning-journal state, ACP session state, rollback readiness, and the revised next-step guidance.

## 3. OpenSpec Bootstrap And Planning Sync

- [x] 3.1 Keep the centralized OpenSpec CLI adapter, but ensure proposal/apply/cancel flows always surface the executed OpenSpec command and relevant stdout or stderr back to the user.
- [x] 3.2 Change `/project proposal` so it creates the change, captures the baseline snapshot for that change, generates the initial artifacts in canonical OpenSpec locations, and marks planning as clean.
- [x] 3.3 Register a planning journal capture path so post-proposal user discussion is appended to the active change journal and marks the change as needing planning sync.
- [x] 3.4 Before `/project apply` or `/project continue`, run a planning sync when the journal is dirty by revisiting `proposal`, `specs`, `design`, and `tasks` in order using `openspec instructions <artifact> --json`.

## 4. ACP Execution Plane

- [x] 4.1 Add an ACP runner that uses OpenClaw's public ACP runtime backend exports, persists ACP handle identity in project state, and avoids any dependency on non-exported OpenClaw internals.
- [x] 4.2 Replace the current `subagent` planning turns with ACP turns while keeping the existing checkpoint contract, repo cwd control, and artifact verification.
- [x] 4.3 Replace the current `subagent` implementation turns with ACP turns that read OpenSpec apply context, execute exactly one unchecked task at a time, and update `tasks.md` only when the task is complete.
- [x] 4.4 Preserve guarded auto-continue semantics around ACP turns, including max-turn limits, no-progress blocking, pause requests, and concise milestone summaries.

## 5. Rollback, Pause, And Recovery

- [x] 5.1 Capture a per-change baseline snapshot before the plugin begins mutating the repo so cancel can restore file contents without depending on Git.
- [x] 5.2 Update checkpoint application so touched files feed the rollback manifest and `changed-files.md`, while planning and implementation milestones continue to update `progress.md`, `decision-log.md`, and `latest-summary.md`.
- [x] 5.3 Make `/project pause` cooperative for active ACP turns and make `/project cancel` attempt ACP cancellation first before restoring files and deleting change artifacts.
- [x] 5.4 Ensure archive and cancel cleanup remove stale ACP session metadata, planning journals, rollback state, and temporary checkpoint files for the current change.

## 6. Documentation And Verification

- [x] 6.1 Rewrite the README to document the workspace-first flow, OpenSpec alignment, ACP runtime requirements, `/project cancel`, and installation/debug steps for OpenClaw.
- [x] 6.2 Update smoke tests to cover workspace persistence, proposal-to-apply planning sync, ACP runner integration boundaries, pause/cancel lifecycle rules, and rollback manifest behavior.
- [x] 6.3 Add focused tests for snapshot restore logic so cancel only restores files touched by the current change and leaves unrelated repo state untouched.
