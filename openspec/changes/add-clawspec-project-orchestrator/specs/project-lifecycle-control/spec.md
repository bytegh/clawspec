## ADDED Requirements

### Requirement: Workspace-first lifecycle commands
The plugin SHALL expose `/project start`, `/project workspace [path]`, `/project use [project-name]`, `/project proposal <change-name> [description]`, `/project apply`, `/project continue`, `/project pause`, `/project status`, `/project archive`, and `/project cancel` as the supported lifecycle commands for an active channel project.

#### Scenario: Start enters workspace flow
- **WHEN** a user issues `/project start` in a channel that does not have an active project
- **THEN** the plugin creates a new project record scoped to that channel
- **THEN** it associates the record with the current workspace
- **THEN** it prompts the user to choose or create a project with `/project use`

#### Scenario: Use selects or creates a project directory
- **WHEN** a user issues `/project use "demo-app"` inside the current workspace
- **THEN** the plugin resolves the path inside the workspace
- **THEN** it creates the directory if it does not exist
- **THEN** it initializes OpenSpec there when needed
- **THEN** it marks that project as the active repo for the channel

### Requirement: Single active project per channel
The plugin SHALL allow at most one active project per channel at a time.

#### Scenario: Duplicate start is rejected
- **WHEN** a user issues `/project start` in a channel that already has an active project that is not archived or cancelled
- **THEN** the plugin does not create a second active project
- **THEN** it returns the current project's identifier or status so the user can continue or inspect it

### Requirement: Proposal creates the active change
The plugin SHALL use `/project proposal` to start a new OpenSpec change for the selected project.

#### Scenario: Proposal starts a change
- **WHEN** a user issues `/project proposal add-foo "Build foo"`
- **THEN** the plugin validates that `add-foo` is kebab-case
- **THEN** it ensures there is no unfinished change already active for the selected project
- **THEN** it creates or reuses the OpenSpec workspace and starts the named change
- **THEN** it enters planning for that change

### Requirement: Active execution blocks conflicting mutations
The plugin SHALL block workspace, project, and change mutations while a planning sync or implementation turn is active.

#### Scenario: Workspace switch is blocked during execution
- **WHEN** a user issues `/project workspace` while the current change has an active planning or implementation turn
- **THEN** the plugin refuses the command
- **THEN** it instructs the user to pause or cancel first

#### Scenario: Proposal is blocked during execution
- **WHEN** a user issues `/project proposal ...` while the current change has an active planning or implementation turn
- **THEN** the plugin refuses to start a second change
- **THEN** it instructs the user to pause, continue, or cancel the current change first

### Requirement: Cooperative pause, continue, and status
The plugin SHALL support cooperative pause and continue semantics, and it SHALL report current project state on demand.

#### Scenario: Pause waits for a safe point
- **WHEN** a user issues `/project pause` while a project is planning or implementing
- **THEN** the plugin sets `pauseRequested` without abruptly killing the current turn
- **THEN** the worker is allowed to finish its current safe point and checkpoint
- **THEN** the project status transitions to `paused`

#### Scenario: Continue resumes from the next incomplete task
- **WHEN** a user issues `/project continue` for a paused or blocked project
- **THEN** the plugin clears `pauseRequested`
- **THEN** it reloads current OpenSpec context and `tasks.md`
- **THEN** it resumes from the next incomplete task after any required planning sync

#### Scenario: Status returns execution summary
- **WHEN** a user issues `/project status` for an active project
- **THEN** the plugin returns the workspace, repo path, change name, status, phase, current task, task counts, planning-journal state, and latest summary

### Requirement: Cancel restores the active change only
The plugin SHALL support `/project cancel` as a change-scoped undo operation.

#### Scenario: Cancel restores the current change
- **WHEN** a user issues `/project cancel` for the active change
- **THEN** the plugin cancels any active worker turn if possible
- **THEN** it restores only files touched by the current change from the stored baseline snapshot
- **THEN** it deletes `openspec/changes/<change>/`
- **THEN** it clears the active change state while keeping the selected project
