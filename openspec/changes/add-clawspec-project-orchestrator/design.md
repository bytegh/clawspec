## Context

ClawSpec is already a functioning OpenClaw plugin, but the current implementation reflects an older design: it still carries compatibility branches for `remember/path/desc`, planning and implementation are both tied to `subagent`, and there is no safe cancellation path that can restore the repo to the pre-change state. The revised design has to embed OpenSpec into OpenClaw more faithfully without modifying OpenSpec itself.

Hard constraints:

- OpenSpec remains the source of truth for workflow order and artifact locations.
- `tasks.md` remains the canonical task list.
- The plugin must use public OpenClaw plugin SDK exports; depending on internal ACP manager paths is not acceptable for a plugin intended to be shared or open-sourced.
- Windows support matters, so CLI integration and file handling must remain UTF-8-safe.
- Workspace selection must stay ergonomic for users who switch projects often.
- `/project cancel` must restore only the current change's modifications; it must not blanket-reset the repo.

## Goals / Non-Goals

**Goals**

- Make `workspace -> project -> change` the core control model.
- Use `/project proposal` to create the OpenSpec change and initialize planning context.
- Capture planning discussion after proposal and sync it back into artifacts before apply.
- Run planning and implementation work through ACP-backed persistent sessions using only public plugin SDK APIs.
- Surface concise milestone summaries plus OpenSpec command output to the user.
- Provide a safe `/project cancel` that restores touched files and deletes the current change.

**Non-Goals**

- Modifying OpenSpec source or inventing a custom OpenSpec schema.
- Building a custom GUI or mandatory thread UI for V1.
- Running multiple active changes in one channel at the same time.
- Reverting unrelated repo changes made outside the current change workflow.

## Decisions

### Decision: Keep a plugin control plane and move execution into ACP turns

The plugin will continue to own command parsing, lifecycle validation, OpenSpec CLI calls, progress formatting, and persistence, while planning and implementation work run inside ACP sessions.

Why:

- Commands stay deterministic and easy to reason about.
- ACP supports persistent sessions, explicit working directories, turn-based execution, and cancellation semantics that are closer to long-running project work than `subagent`.
- The execution plane remains replaceable because the control plane owns the workflow.

Alternatives considered:

- Keep using `subagent`. Rejected because it provides poorer observability and cancellation semantics for the workflow we want to support.
- Push everything into the main chat agent through prompt injection alone. Rejected because lifecycle control, command validation, and rollback need plugin-owned state.

### Decision: Use the public ACP runtime backend export instead of OpenClaw ACP manager internals

The plugin will build its own thin ACP runner around `requireAcpRuntimeBackend()` and `backend.runtime.ensureSession/runTurn/cancel/close`, and it will persist only the ACP handle metadata it needs.

Why:

- The internal ACP manager is present in OpenClaw but not exported as stable plugin API.
- A plugin should not depend on non-exported internals if it is meant to be maintainable across OpenClaw releases.
- The public backend runtime interface is sufficient for ClawSpec's needs.

Trade-off:

- The plugin must persist more ACP session metadata itself instead of delegating that to OpenClaw internals.

### Decision: Record planning discussion in a change-scoped journal and sync artifacts before apply

After `/project proposal`, the plugin will keep a journal of user planning notes for the active change. Before `/project apply` or `/project continue`, if the journal is dirty, the plugin will run a planning sync that revisits `proposal`, `specs`, `design`, and `tasks` in order using `openspec instructions <artifact> --json`.

Why:

- OpenSpec CLI does not automatically ingest chat history on `apply`; it reads the artifacts.
- Users expect proposal-time discussion to influence `tasks.md` before implementation starts.
- Re-syncing artifacts at explicit command boundaries is more controllable than keeping a permanently active planning worker.

Alternatives considered:

- Rely on `openspec status` ready/done transitions alone. Rejected because that only solves initial artifact creation, not later updates after discussion.
- Start a constantly running planning thread after proposal. Rejected because it complicates lifecycle control and increases hidden background work.

### Decision: Keep `tasks.md` canonical and persist plugin metadata under `.openclaw/clawspec/`

Repo-local plugin files under `.openclaw/clawspec/` will store:

- `state.json`
- `progress.md`
- `changed-files.md`
- `decision-log.md`
- `latest-summary.md`
- `planning-journal.jsonl`
- `rollback-manifest.json`
- `snapshots/<change>/baseline/...`
- `archives/<projectId>/...`

Why:

- OpenSpec artifacts stay canonical and untouched in layout.
- The plugin still needs durable execution state, journals, and rollback data.
- Repo-local files make pause, continue, cancel, and archive inspectable.

### Decision: Capture a change baseline snapshot once and restore only touched files on cancel

When a new change starts, the plugin will capture a baseline snapshot for the repo under `.openclaw/clawspec/snapshots/<change>/baseline/`. During planning and implementation, checkpoints contribute touched files to a rollback manifest. On `/project cancel`, the plugin restores only paths listed in that manifest from the baseline snapshot, removes files that were created after the baseline, deletes `openspec/changes/<change>/`, and resets the active change state.

Why:

- The plugin cannot safely rely on blanket Git resets.
- It also cannot depend on intercepting every file mutation before the worker writes it.
- A baseline snapshot plus touched-file manifest gives deterministic change-local rollback semantics.

Trade-off:

- Snapshot storage is heavier than lazy per-file capture, but it is reliable and still restores only touched files.

### Decision: Block workspace/project/change mutations while execution is active

While an ACP planning sync or implementation turn is active, `/project workspace`, `/project use`, `/project proposal`, and `/project archive` are blocked until the user pauses or cancels.

Why:

- Switching the repo or change while a worker is still operating would corrupt state.
- The user explicitly asked for pause-before-switch semantics.

### Decision: Show milestone summaries in chat and keep detailed logs in repo files

The plugin will show key milestones in command responses:

- OpenSpec command executed
- planning sync started/completed
- artifact(s) updated
- current task
- completed task
- changed files summary
- paused/blocked/done/cancelled

Full detail remains in repo-local logs.

Why:

- The main chat should stay readable.
- Repo-local files are a better place for long execution traces.

## State Model

### Project lifecycle states

- `idle`: workspace selected, no active change yet
- `planning`: proposal bootstrap or planning sync is running
- `ready`: artifacts are synced and apply can start
- `implementing`: ACP is executing tasks from `tasks.md`
- `pause_requested`: pause requested while a turn is in flight
- `paused`: safe checkpoint reached, waiting for continue
- `blocked`: planning or implementation hit a blocker
- `done`: all tasks complete
- `archived`: archive completed
- `cancelled`: current change was cancelled and restored

### Project phases

- `init`
- `proposal`
- `specs`
- `design`
- `tasks`
- `planning_sync`
- `implementing`
- `validating`
- `archiving`
- `cancelling`

### Core persisted objects

`ProjectState`
- workspace path
- selected project path/name
- active change name/change dir
- lifecycle status/phase
- task counts/current task/latest summary
- ACP session binding and last known handle identity
- planning journal dirty flag / last sync timestamp
- pause/cancel flags and blocker text

`PlanningJournalEntry`
- timestamp
- channel key
- role (`user` or `assistant` if later expanded)
- text

`RollbackManifest`
- change name
- baseline root
- touched paths
- created paths
- deleted paths
- restored/cancelled timestamps

## Flow

### `/project proposal`

1. Validate workspace/project selection.
2. Ensure OpenSpec is initialized in the repo.
3. Capture the baseline snapshot if this is a new change.
4. Run `openspec new change "<name>" ["--description", "..."]`.
5. Generate initial artifacts in dependency order using `openspec instructions <artifact> --json`.
6. Mark planning clean and status `ready`.

### Planning journal capture

After proposal, user messages in the active channel that are not `/project ...` commands are appended to `planning-journal.jsonl` and set `planningDirty=true`.

### `/project apply` or `/project continue`

1. If `planningDirty`, run planning sync in artifact order:
   - proposal
   - specs
   - design
   - tasks
2. Run `openspec instructions apply --change ... --json`.
3. Read context files from the response.
4. Execute the next unchecked task from `tasks.md`.
5. Apply checkpoints, update touched-file manifest, and continue until:
   - pause requested
   - blocked
   - max auto-turn limit reached
   - no tasks remain

### `/project cancel`

1. If an ACP turn is active, cancel it.
2. Restore touched files from baseline snapshots.
3. Delete files created by the change.
4. Delete `openspec/changes/<change>/`.
5. Remove planning journal, rollback manifest, and change-scoped support files.
6. Keep the project selected, but clear the active change.

## Risks / Trade-offs

- [ACP backend unavailable] -> Detect via public ACP runtime backend lookup and fail with an actionable installation/configuration message.
- [Planning journal grows noisy] -> Only record user planning messages and resync at explicit command boundaries.
- [Baseline snapshots consume disk] -> Scope them per change and clean them on archive/cancel.
- [Checkpoint changed-files lists are incomplete] -> Treat checkpoint validation as part of the worker contract and block cancel/archive if manifests are clearly inconsistent.
- [Concurrent commands race with active turns] -> Use channel-level locks plus explicit active-run validation.

## Migration Plan

1. Rewrite the state model and repo-local file layout for journals, rollback data, and ACP bindings.
2. Replace outdated command branches with the workspace-first command surface plus `/project cancel`.
3. Add planning journal capture and planning sync.
4. Switch worker execution from `subagent` to the public ACP runtime backend.
5. Add rollback restore, archive cleanup, tests, and updated installation/debugging docs.

## Open Questions

- Whether assistant-side planning messages should also be journaled in V1, or whether user notes alone are sufficient.
- Whether the plugin should emit extra out-of-band milestone messages during long ACP turns, or keep V1 to command-response summaries plus repo-local logs.
