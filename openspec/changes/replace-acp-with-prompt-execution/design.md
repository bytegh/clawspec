## Context

ClawSpec already owns workspace selection, project state, planning-journal capture, rollback snapshots, OpenSpec CLI calls, and command formatting. What remains misaligned with the desired user experience is the execution plane: planning sync and implementation still run through ACP-backed worker sessions with their own lifecycle, checkpoint contract, and hidden runtime.

The new goal is visible execution in the current chat agent. OpenClaw's plugin SDK supports prompt injection through `before_prompt_build`, which is the right hook for per-turn dynamic execution context. However, two public-SDK limits shape the design:

- Plugin commands run before agent invocation and bypass the LLM agent entirely.
- The public plugin runtime does not expose a way to dispatch or cancel the current main-agent run on demand.

Those constraints mean a pure "`/project apply` immediately starts the current agent" flow is not available through stable APIs. The design therefore has to be explicit about an armed state and a follow-up user message that starts the visible execution turn.

## Goals / Non-Goals

**Goals:**
- Remove ACP as the execution engine for ClawSpec.
- Run planning sync and task execution in the current visible chat agent.
- Keep workspace, project, change, rollback, and OpenSpec command orchestration plugin-owned.
- Preserve post-proposal planning capture and resync artifacts before implementation.
- Keep `/project pause`, `/project cancel`, and `/project status` meaningful under the new execution model.
- Stay within public OpenClaw plugin SDK APIs and avoid changes to OpenSpec source.

**Non-Goals:**
- Relying on internal OpenClaw agent-dispatch or ACP-manager internals.
- Making `/project apply` auto-run the main agent in the same plugin-command turn when the SDK does not support it.
- Guaranteeing hard preemptive interruption of an in-flight main-agent turn.
- Rewriting OpenSpec workflow semantics or artifact formats.

## Decisions

### Use `before_prompt_build` and `agent_end`, not ACP and not legacy `before_agent_start`

**Decision:** Register typed plugin hooks with `api.on("before_prompt_build", ...)` to inject the execution context, and `api.on("agent_end", ...)` to reconcile the run outcome back into plugin state.

**Why:** `before_prompt_build` is the current documented hook for prompt shaping after session messages are loaded. It cleanly supports `prependContext` and system-context additions. `before_agent_start` is now a compatibility path and should not be the primary mechanism.

**Alternatives considered:**
- Keep ACP. Rejected because it preserves hidden execution and separate worker lifecycle that the user wants to remove.
- Use `before_agent_start`. Rejected because the SDK explicitly prefers `before_prompt_build`.

### Adopt an arm-then-execute flow for `/project apply` and `/project continue`

**Decision:** `/project apply` and `/project continue` will prepare the change, run the deterministic command-time checks the plugin needs, store `pendingExecution` state, and return a reply that tells the user execution is armed. The next non-command message in that same chat triggers the visible execution turn.

**Why:** Plugin commands bypass agent invocation, and the public runtime does not expose a "run current agent now" API. Pretending otherwise would produce a design that cannot be implemented against stable SDK surfaces.

**Alternatives considered:**
- Start execution from the plugin command itself. Rejected because the SDK does not provide a supported way to dispatch the current main agent from a plugin command.
- Reintroduce a hidden subagent or ACP session just to auto-start. Rejected because it reintroduces the hidden execution model the change is trying to remove.

### Keep the plugin as the control plane and the main chat agent as the executor

**Decision:** The plugin continues to own workspace/project/change state, rollback snapshots, planning journal capture, OpenSpec CLI command-time checks, lifecycle validation, and cleanup. The visible main agent becomes the executor for planning sync and implementation work.

**Why:** This keeps durable state and safety guarantees outside of transient model reasoning while still moving execution into the visible conversation.

**Alternatives considered:**
- Put all state in prompt context only. Rejected because pause, continue, cancel, and rollback need durable state.
- Let the main agent own OpenSpec state mutations entirely. Rejected because the plugin still needs deterministic lifecycle enforcement and status inspection.

### Use repo-local execution control files for cooperative pause and result reconciliation

**Decision:** Extend `.openclaw/clawspec/` with explicit execution-control and execution-result state that the injected agent turn can read and update between artifacts or tasks. The plugin reconciles that result on `agent_end`.

**Why:** Without ACP there is no plugin-owned background session to checkpoint. A lightweight repo-local contract is still needed so:
- `/project pause` and `/project cancel` can set cooperative flags
- the running main agent can observe those flags between units of work
- `agent_end` can distinguish done, paused, blocked, or partial progress without scraping arbitrary prose

**Alternatives considered:**
- Infer everything from the final assistant message. Rejected because it is brittle and couples lifecycle state to free-form prose.
- Keep the old ACP checkpoint contract unchanged. Rejected because the new architecture should not preserve ACP-specific worker semantics.

### Planning sync and implementation both run in the visible agent turn

**Decision:** When execution is armed, the injected prompt tells the current agent to:
1. read ClawSpec state and change context
2. sync dirty planning artifacts first when needed
3. fetch fresh OpenSpec apply context
4. implement tasks sequentially
5. update `tasks.md` and repo-local support files
6. stop only when done, paused, blocked, cancelled, or a real clarification is required

**Why:** This keeps the entire workflow visible in one place and avoids splitting planning into a hidden helper path.

**Alternatives considered:**
- Use prompt injection only for implementation, but keep planning sync in a hidden worker. Rejected because it preserves part of the hidden execution model and makes the user experience inconsistent.

### Surface OpenSpec output at the layer that actually runs it

**Decision:** The plugin keeps surfacing OpenSpec command output for command-time work such as `init`, `new change`, `status`, `validate`, and `archive`. During visible execution turns, the main agent is expected to run the required OpenSpec commands itself, so those outputs remain visible through the normal tool stream in chat.

**Why:** Once execution moves to the main agent, duplicating the same OpenSpec commands in the plugin would create stale state and redundant output.

**Alternatives considered:**
- Have the plugin precompute every `openspec instructions` payload before arming execution. Rejected because it duplicates work, risks drift before the visible run starts, and bloats plugin state.

## Risks / Trade-offs

- [Execution needs a second user message after `/project apply`] -> Mitigation: make the reply explicit and actionable, for example "Execution armed. Send `continue` or any normal message to start in this chat."
- [Pause and cancel are cooperative, not preemptive] -> Mitigation: require the injected run to check control flags between artifacts and tasks, and document the limitation clearly.
- [Prompt-injection hooks can be disabled by operator config] -> Mitigation: detect or document the requirement for `plugins.entries.clawspec.hooks.allowPromptInjection` to remain enabled.
- [Main-agent execution depends on the selected agent having file and shell editing tools] -> Mitigation: document the expected agent profile and fail fast with an actionable message when required tools are unavailable.
- [The visible run can still stop mid-work due to model/tool issues] -> Mitigation: keep `tasks.md` canonical, persist a lightweight execution result, and make `/project continue` idempotent from the next incomplete task.

## Migration Plan

1. Remove ACP-specific runner, session state, and worker-checkpoint plumbing from the plugin.
2. Extend project state and repo-local support files for armed execution, cooperative control flags, and execution-result reconciliation.
3. Register `before_prompt_build` and `agent_end` hooks and inject the new visible execution context only when execution is armed.
4. Rework `/project apply`, `/project continue`, `/project pause`, `/project cancel`, and `/project status` around the arm-then-execute lifecycle.
5. Update README and smoke coverage for the new command semantics and hook requirements.

## Open Questions

- Should ClawSpec reserve a canonical follow-up trigger phrase after `/project apply`, or should any non-command user message start execution?
- Should the plugin expose a short "armed execution summary" file inside `.openclaw/clawspec/` for easier debugging?
- If OpenClaw later exposes a stable main-agent dispatch or cancel API to plugins, should ClawSpec upgrade `/project apply` and `/project pause` to use it?
