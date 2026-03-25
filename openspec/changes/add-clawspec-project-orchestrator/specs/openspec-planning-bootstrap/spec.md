## ADDED Requirements

### Requirement: OpenSpec bootstrap and change creation
The plugin SHALL initialize an OpenSpec workspace when the selected repository does not already contain one, and it SHALL create the requested change on `/project proposal` without modifying OpenSpec itself.

#### Scenario: Proposal bootstraps an uninitialized repository
- **WHEN** a selected project repo does not contain an OpenSpec workspace and the user issues `/project proposal add-foo`
- **THEN** the plugin executes `openspec init --tools none .` in that repo
- **THEN** it records the OpenSpec root in project state
- **THEN** it proceeds to create the named change in that repo

#### Scenario: Proposal creates the named change
- **WHEN** the plugin begins planning for a selected project
- **THEN** it executes `openspec new change "<name>"` with the optional description argument
- **THEN** it records the change name and change directory in project state
- **THEN** it advances into artifact generation

### Requirement: Instruction-driven artifact generation
The plugin SHALL generate and sync planning artifacts by reading `openspec instructions` output and writing files to the exact output paths defined by OpenSpec.

#### Scenario: Initial artifacts are generated in dependency order
- **WHEN** a new change is created
- **THEN** the plugin requests instructions only for artifacts whose dependencies are currently satisfied
- **THEN** the worker uses the provided template, instruction text, and dependency files as generation context
- **THEN** the plugin repeats the process until all apply-required artifacts are complete

#### Scenario: Planning sync revisits done artifacts
- **WHEN** the active change has new planning journal entries after proposal
- **THEN** the plugin revisits `proposal`, `specs`, `design`, and `tasks` in order using `openspec instructions <artifact> --json`
- **THEN** it updates those files in place under the change directory
- **THEN** the journal is marked clean before implementation starts

### Requirement: Canonical OpenSpec structure preservation
The plugin SHALL preserve OpenSpec's canonical artifact layout and SHALL treat `tasks.md` as the canonical task source.

#### Scenario: Planning outputs remain under the change directory
- **WHEN** proposal, specs, design, and tasks are generated or synced
- **THEN** they are written under `openspec/changes/<change>/...` using the output paths returned by OpenSpec
- **THEN** the plugin does not move or duplicate those artifacts into a parallel planning tree
- **THEN** apply progress is derived from `tasks.md` rather than a plugin-owned task list

### Requirement: OpenSpec command output is visible
The plugin SHALL execute OpenSpec CLI commands through a UTF-8-safe integration layer that parses JSON when requested and returns relevant command output to the user.

#### Scenario: User sees OpenSpec command progress
- **WHEN** the plugin executes `openspec init`, `openspec new change`, `openspec status`, `openspec instructions`, `openspec validate`, or `openspec archive`
- **THEN** it records the command, cwd, stdout, stderr, and duration
- **THEN** it includes relevant command output in user-facing summaries
- **THEN** failures include enough OpenSpec output for the user to understand what went wrong
