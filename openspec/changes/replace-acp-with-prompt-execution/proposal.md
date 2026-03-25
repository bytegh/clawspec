## Why

The current plugin routes planning and implementation through ACP-backed worker sessions. That keeps long-running work off the main chat, but it also introduces hidden execution, extra session management, and checkpoint-specific plumbing that the user explicitly does not want for the OpenClaw chat experience. The target workflow is now chat-native: `/project apply` prepares the change, the current visible agent performs planning sync and implementation, and the user can see the work happen in the main conversation.

There is one important SDK constraint: plugin commands bypass agent invocation, and the public plugin runtime does not expose a "run the current main agent now" API. That means `/project apply` cannot both act as a plugin command and immediately start the main agent in the same turn. The workable design is a two-step visible flow: `/project apply` arms execution and reports the prepared state, and the next normal user message in that chat starts the injected execution turn.

## What Changes

- **BREAKING**: Remove ACP-backed planning and implementation from ClawSpec.
- Replace ACP session orchestration with `before_prompt_build` prompt injection into the current chat agent.
- Add plugin-owned execution state so `/project apply` and `/project continue` can arm a change for visible execution in the current chat.
- Make the next non-command user message after `/project apply` or `/project continue` trigger the actual planning-sync and implementation run in the main agent.
- Keep planning journal capture, rollback snapshots, workspace and project state, and OpenSpec CLI orchestration plugin-owned.
- Make pause and cancel cooperative: commands set control flags, and the injected execution flow checks those flags at safe boundaries between artifacts and tasks.
- Keep surfacing OpenSpec CLI command output, but do it in the places that are actually feasible:
  - command-time OpenSpec output in plugin replies
  - execution-time OpenSpec output through the visible main-agent tool calls

## Capabilities

### New Capabilities
- `main-agent-prompt-execution`: Arms and runs OpenSpec planning and implementation inside the current visible chat agent with prompt injection instead of ACP.
- `planning-artifact-sync`: Refreshes `proposal.md`, `spec.md`, `design.md`, and `tasks.md` from post-proposal chat discussion before implementation begins or resumes.

### Modified Capabilities
- `project-command-lifecycle`: Adjusts `/project apply`, `/project continue`, `/project pause`, `/project cancel`, and `/project status` around the new arm-then-execute workflow.

## Impact

- Removes ACP-specific orchestration from the plugin implementation and tests.
- Introduces prompt-injection hooks and execution-arm state to the command flow.
- Preserves OpenSpec as-is; no OpenSpec source modifications are required.
- Preserves workspace selection, project selection, rollback snapshotting, archive cleanup, and planning journal capture.
- Adds explicit documentation for the two-step apply or continue flow and prompt-injection requirements.
