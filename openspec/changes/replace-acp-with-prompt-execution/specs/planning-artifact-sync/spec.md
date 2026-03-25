## ADDED Requirements

### Requirement: Post-proposal discussion remains the planning source
The plugin SHALL continue recording post-proposal requirement discussion into the active change planning journal.

#### Scenario: Discussion after proposal marks the journal dirty
- **WHEN** the user has an active proposed change and sends non-command planning discussion in the same chat
- **THEN** the plugin appends that discussion to `planning-journal.jsonl`
- **THEN** it marks the active change planning state as dirty

### Requirement: Dirty planning is synced before implementation starts or resumes
The visible ClawSpec execution turn SHALL refresh planning artifacts before implementation whenever the planning journal is dirty.

#### Scenario: Apply refreshes proposal, specs, design, and tasks first
- **WHEN** the user arms execution with `/project apply` and the active change has dirty planning discussion
- **THEN** the next injected execution turn refreshes `proposal`, `specs`, `design`, and `tasks` in order
- **THEN** it does so before implementing any unchecked task
- **THEN** the planning journal is marked clean after the artifact refresh succeeds

#### Scenario: Continue reuses the same planning-sync path
- **WHEN** the user arms execution with `/project continue` after more planning discussion was captured
- **THEN** the next injected execution turn repeats the same artifact refresh path before resuming implementation
- **THEN** it resumes from the next incomplete task only after the artifact refresh completes

### Requirement: OpenSpec remains the source of artifact instructions
The visible ClawSpec execution turn SHALL use OpenSpec CLI instructions to decide how each planning artifact is generated or refreshed.

#### Scenario: Injected execution uses OpenSpec instructions
- **WHEN** the agent needs to create or resync a planning artifact
- **THEN** it uses `openspec instructions <artifact> --change <name> --json` for the active change
- **THEN** it reads any required dependency files before writing the target artifact
- **THEN** it writes to the canonical OpenSpec output path for that artifact

### Requirement: OpenSpec output stays visible during execution
The system SHALL keep OpenSpec command output visible to the user during visible planning and implementation turns.

#### Scenario: Visible execution shows OpenSpec tool activity
- **WHEN** the injected execution turn runs `openspec status`, `openspec instructions`, or other OpenSpec commands
- **THEN** those commands run through the visible chat agent's normal tool flow
- **THEN** the user can inspect the command activity in the main conversation
