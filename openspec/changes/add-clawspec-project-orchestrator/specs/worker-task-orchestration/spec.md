## ADDED Requirements

### Requirement: ACP-backed persistent worker session binding
The plugin SHALL bind a persistent ACP worker session to each active change so planning sync and implementation can reuse project context across turns.

#### Scenario: Proposal or apply attaches an ACP session
- **WHEN** a project enters planning or implementation phases
- **THEN** the plugin ensures an ACP session for that change
- **THEN** it stores the ACP session key and last known handle identity in project state
- **THEN** future pause, continue, cancel, and status actions reference that same ACP session

### Requirement: Sequential task execution from `tasks.md`
The worker SHALL treat `tasks.md` as the ordered task source and SHALL advance work from the next incomplete task.

#### Scenario: Worker completes a task and advances
- **WHEN** the worker is asked to continue implementation for a running project
- **THEN** it reads the current `tasks.md`
- **THEN** it selects the next unchecked task as the execution target
- **THEN** after finishing that task it updates `tasks.md` before the plugin considers continuing

### Requirement: Structured checkpoint contract
Each worker turn SHALL end with a structured checkpoint that the plugin can interpret for reporting, rollback manifests, and control decisions.

#### Scenario: Worker emits a checkpoint after a turn
- **WHEN** the worker finishes a planning or implementation turn
- **THEN** it returns checkpoint data that includes execution status, completed task or artifact, changed files, notes, and next suggested action
- **THEN** the plugin persists the latest summary in project-local state
- **THEN** the plugin feeds changed files into the rollback manifest
- **THEN** the plugin uses the checkpoint to decide whether to continue, pause, block, or finish

### Requirement: Guarded auto-continue behavior
The plugin SHALL auto-continue only when the project is still running, no pause has been requested, the worker is not blocked, incomplete tasks remain, auto-continue limits have not been exceeded, and no-progress protection has not triggered.

#### Scenario: Auto-continue starts the next turn
- **WHEN** a worker checkpoint reports progress and unfinished tasks remain
- **THEN** the plugin evaluates project status, pause flag, checkpoint status, remaining tasks, and configured auto-continue thresholds
- **THEN** it dispatches the next ACP turn only if every continuation condition passes

#### Scenario: No-progress protection stops the loop
- **WHEN** consecutive worker turns fail to complete any task or repeat the same blocker beyond the configured threshold
- **THEN** the plugin stops auto-continue
- **THEN** the project status transitions to `blocked` or `paused`
- **THEN** the plugin reports that user intervention is required

### Requirement: Milestone-focused reporting
The plugin SHALL summarize ACP execution in concise milestones instead of dumping every internal event into the main chat.

#### Scenario: User sees key milestones
- **WHEN** a planning sync or implementation run completes
- **THEN** the plugin reports which artifact or task was worked on
- **THEN** it includes the completed task list or changed files summary when available
- **THEN** it reports whether the change is ready, paused, blocked, or done
