## ADDED Requirements

### Requirement: Workspace history is persisted
The plugin SHALL persist the current workspace and recent workspace history in a plugin-managed state file so users can keep working from the same workspace across sessions.

#### Scenario: Default workspace is restored
- **WHEN** the plugin starts and no prior workspace has been selected
- **THEN** it uses the configured default workspace
- **THEN** it creates that directory if needed
- **THEN** it records that workspace in workspace history

#### Scenario: Workspace switch is remembered
- **WHEN** a user issues `/project workspace "D:\dev\foo"`
- **THEN** the plugin switches to that workspace
- **THEN** it records the workspace as current and recent
- **THEN** the same workspace is restored on the next session unless the user changes it again

### Requirement: Workspace projects can be listed and selected
The plugin SHALL let users browse and select project directories inside the active workspace without pasting absolute repo paths each time.

#### Scenario: Use with no arguments lists projects
- **WHEN** a user issues `/project use` with no arguments
- **THEN** the plugin lists directories inside the current workspace
- **THEN** the response shows the current workspace and active project if one exists

#### Scenario: Use selects an existing project
- **WHEN** a user issues `/project use "demo-app"` and `demo-app` exists inside the current workspace
- **THEN** the plugin resolves that repo path
- **THEN** it marks that project as the active repo for the channel
- **THEN** it reports the resolved repo path back to the user

#### Scenario: Use creates a missing project directory
- **WHEN** a user issues `/project use "demo-app"` and `demo-app` does not exist inside the current workspace
- **THEN** the plugin creates the project directory inside the workspace
- **THEN** it initializes OpenSpec in that directory
- **THEN** it marks the new project as active

### Requirement: Project selection stays inside the workspace
The plugin SHALL not allow `/project use` to escape the active workspace through path traversal or absolute-path tricks.

#### Scenario: Path traversal is rejected
- **WHEN** a user issues `/project use "..\other-repo"`
- **THEN** the plugin rejects the input
- **THEN** it reports that project selection must stay inside the current workspace
