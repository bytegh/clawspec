## ADDED Requirements

### Requirement: Apply and continue use an arm-then-execute lifecycle
The plugin SHALL treat `/project apply` and `/project continue` as command-time preparation steps that arm the current chat for visible execution on the next normal user message.

#### Scenario: Apply returns an explicit armed reply
- **WHEN** the user issues `/project apply`
- **THEN** the plugin validates the active workspace, project, and change state
- **THEN** it stores pending execution state for the current chat
- **THEN** it replies with the current preparation result and clear instructions that the next non-command message will start visible execution

#### Scenario: Continue returns an explicit armed reply
- **WHEN** the user issues `/project continue`
- **THEN** the plugin stores pending execution state for the current chat using the current change progress
- **THEN** it replies with the current preparation result and clear instructions that the next non-command message will resume visible execution

### Requirement: Pause and cancel are cooperative
The plugin SHALL treat `/project pause` and `/project cancel` as cooperative control actions during visible execution.

#### Scenario: Pause requests the next safe stop
- **WHEN** the user issues `/project pause` while a visible execution turn is active or armed
- **THEN** the plugin records `pauseRequested` for the active change
- **THEN** the running or next visible execution step honors that flag at the next safe boundary between artifacts or tasks
- **THEN** project status transitions to `paused` when that safe boundary is reached

#### Scenario: Cancel requests cooperative stop and cleanup
- **WHEN** the user issues `/project cancel` for the active change
- **THEN** the plugin records the cancellation request and performs cleanup once the current safe boundary is reached or the execution turn has already ended
- **THEN** it restores tracked files from the rollback snapshot
- **THEN** it deletes the active change directory and clears change-scoped runtime files

### Requirement: Conflicting mutations are blocked while execution is armed or active
The plugin SHALL block workspace, project, and new-change mutations while a chat has armed or active visible execution for the current change.

#### Scenario: Workspace switch is blocked during armed execution
- **WHEN** the user issues `/project workspace ...` while the current chat has armed or active execution
- **THEN** the plugin refuses the command
- **THEN** it tells the user to pause or cancel the current change first

#### Scenario: New proposal is blocked during armed execution
- **WHEN** the user issues `/project proposal ...` while the current chat has armed or active execution
- **THEN** the plugin refuses to start another change
- **THEN** it tells the user to finish, pause, or cancel the active change first

### Requirement: Status reports armed and cooperative lifecycle state
The plugin SHALL report the visible execution lifecycle in `/project status`.

#### Scenario: Status shows prepared execution state
- **WHEN** the user issues `/project status` after `/project apply` or `/project continue` has armed execution
- **THEN** the plugin reports that execution is armed for the current chat
- **THEN** it includes workspace, project, change, task counts, planning-journal state, and the latest execution summary

### Requirement: Command-time OpenSpec output is shown in plugin replies
The plugin SHALL continue surfacing command-time OpenSpec output in user-visible command replies.

#### Scenario: Proposal or archive shows OpenSpec output
- **WHEN** the plugin runs OpenSpec CLI commands directly during proposal, status preparation, validation, or archive
- **THEN** the reply includes the relevant command, cwd, stdout or stderr excerpt, and timing information
