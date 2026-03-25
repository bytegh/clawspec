## 1. Execution State And Hooks

- [x] 1.1 Replace ACP-specific project state with prompt-execution state, cooperative control flags, and lightweight execution-result support files
- [x] 1.2 Register `before_prompt_build` and `agent_end` hooks so ClawSpec can inject visible execution context and reconcile the run outcome afterward
- [x] 1.3 Remove ACP runner wiring, ACP config, and checkpoint-specific worker plumbing from the plugin implementation

## 2. Command Lifecycle

- [x] 2.1 Rework `/project apply` and `/project continue` so they arm execution for the current chat, surface preparation status, and explain the required follow-up trigger message
- [x] 2.2 Rework `/project pause`, `/project cancel`, `/project status`, and mutation guards around cooperative visible execution instead of ACP session control
- [x] 2.3 Keep `/project workspace`, `/project use`, `/project proposal`, and `/project archive` deterministic and free of hidden worker startup

## 3. Visible Planning And Implementation

- [x] 3.1 Build the injected execution context so the current agent syncs dirty planning artifacts before implementation and then executes unchecked tasks from `tasks.md`
- [x] 3.2 Add a lightweight run-result or summary contract so `agent_end` can set `done`, `paused`, `blocked`, or `cancelled` without parsing arbitrary assistant prose
- [x] 3.3 Ensure the visible execution flow updates repo-local support files and keeps OpenSpec command activity inspectable in the main chat

## 4. Documentation And Verification

- [x] 4.1 Rewrite installation, usage, and debugging documentation for the arm-then-execute workflow and prompt-injection hook requirements
- [x] 4.2 Update smoke coverage for hook registration, execution arming, visible execution triggering, and cooperative pause or cancel semantics
