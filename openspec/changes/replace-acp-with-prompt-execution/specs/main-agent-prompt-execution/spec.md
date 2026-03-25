## ADDED Requirements

### Requirement: Visible main-agent execution
The plugin SHALL execute ClawSpec planning sync and implementation in the current visible chat agent instead of creating an ACP or hidden subagent worker session.

#### Scenario: Apply arms visible execution
- **WHEN** the user issues `/project apply` for a project with an active change
- **THEN** the plugin prepares execution state for that change
- **THEN** it does not start an ACP session or hidden subagent run
- **THEN** it reports that execution is armed for the current chat

#### Scenario: Continue arms visible execution
- **WHEN** the user issues `/project continue` for a paused, blocked, or partially completed change
- **THEN** the plugin prepares execution state for the current chat
- **THEN** it does not create a hidden worker session
- **THEN** it reports that the next visible execution turn will resume from the current change state

### Requirement: Prompt injection is scoped to armed execution only
The plugin SHALL inject ClawSpec execution instructions only when the current chat has armed execution state for the active change.

#### Scenario: Next normal message starts the visible execution turn
- **WHEN** a chat has pending ClawSpec execution and the user sends a non-command message
- **THEN** the plugin injects the ClawSpec execution context into that agent run through `before_prompt_build`
- **THEN** the injected context identifies the active workspace, repo path, change name, planning-journal state, and execution goals
- **THEN** the agent performs the work in the current visible conversation

#### Scenario: Unrelated chat turns are not polluted
- **WHEN** a chat does not have pending ClawSpec execution
- **THEN** the plugin does not inject ClawSpec execution context into the agent prompt
- **THEN** normal conversation continues without task-execution instructions

### Requirement: Execution outcome is reconciled after the visible turn
The plugin SHALL reconcile the result of a visible ClawSpec execution turn back into project state after the agent finishes.

#### Scenario: Agent end updates project status
- **WHEN** an injected ClawSpec execution turn finishes
- **THEN** the plugin clears the pending execution arm for that turn
- **THEN** it reloads the current change state from `tasks.md` and ClawSpec support files
- **THEN** it updates project status to reflect whether the change is done, paused, blocked, cancelled, or still incomplete

### Requirement: No ACP runtime dependency remains for execution
The plugin SHALL not require ACP runtime setup to plan or implement a change.

#### Scenario: Hook-driven execution path
- **WHEN** ClawSpec is installed in an OpenClaw environment with prompt-injection hooks enabled
- **THEN** `/project apply` and `/project continue` work without ACP runtime configuration
- **THEN** the plugin does not fail because ACP runtime backends are unavailable
