## ADDED Requirements

### Requirement: Project-local execution and recovery files
The plugin SHALL maintain project-local execution and recovery files under `.openclaw/clawspec/` so operators can inspect progress and cancel safely outside of transient channel messages.

#### Scenario: Execution support files are created and updated
- **WHEN** a project is initialized and later progresses through planning or implementation
- **THEN** the plugin maintains `state.json`, `progress.md`, `changed-files.md`, `decision-log.md`, `latest-summary.md`, `planning-journal.jsonl`, and `rollback-manifest.json` under `.openclaw/clawspec/`
- **THEN** the latest checkpoint and key execution metadata are reflected in those files

### Requirement: Change-scoped rollback data is persisted
The plugin SHALL keep change-scoped rollback data so `/project cancel` can restore the active change safely.

#### Scenario: Baseline snapshot is captured for a change
- **WHEN** a new change is started with `/project proposal`
- **THEN** the plugin stores a baseline snapshot under `.openclaw/clawspec/snapshots/<change>/baseline/`
- **THEN** it records rollback metadata for that change in `rollback-manifest.json`

#### Scenario: Cancel restores touched files only
- **WHEN** a user issues `/project cancel`
- **THEN** the plugin restores only files listed in the rollback manifest from the baseline snapshot
- **THEN** it deletes files created by the change that had no baseline entry
- **THEN** it leaves unrelated repo files untouched

### Requirement: Archive command produces recovery artifacts
The plugin SHALL produce project-level archive artifacts in addition to any OpenSpec archive output.

#### Scenario: Completed project is archived
- **WHEN** a user issues `/project archive` for a project whose change is ready to archive
- **THEN** the plugin runs `openspec validate` before archiving
- **THEN** the plugin runs `openspec archive <change> -y`
- **THEN** it writes `session-summary.md`, `changed-files.md`, `decision-log.md`, `resume-context.md`, and `run-metadata.json` under `.openclaw/clawspec/archives/<projectId>/`
- **THEN** the project status becomes `archived`

### Requirement: Resume context is self-contained
The plugin SHALL write a resume context that is sufficient for a later worker or operator to understand the project state without reading the full transcript first.

#### Scenario: Resume context captures project state
- **WHEN** the plugin generates `resume-context.md`
- **THEN** the file includes the project purpose, change name, planning artifact paths, completed tasks, remaining tasks, key decisions, code state summary, and recommended files to inspect first
