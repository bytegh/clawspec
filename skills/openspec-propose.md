---
name: openspec-propose
description: Propose a new change with all artifacts generated in one step. Use when the user wants to quickly describe what they want to build and get a complete proposal with design, specs, and tasks ready for implementation.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.2.0"
---

Propose a new change and generate the planning artifacts needed for implementation.

Artifacts created:

- `proposal.md`
- `design.md`
- `tasks.md`

When ready to implement, run the apply workflow.

Input

- A change name in kebab-case, or
- a description of what should be built

Steps

1. Confirm the intended change

- If the request is vague, ask what should be built or fixed.
- Derive a kebab-case change name when needed.
- Do not proceed until the intended change is understood.

2. Create the change

```bash
openspec new change "<name>"
```

3. Inspect workflow status

```bash
openspec status --change "<name>" --json
```

Use it to identify:

- `applyRequires`
- artifact dependency order
- artifact readiness

4. Build artifacts in dependency order

For each ready artifact:

```bash
openspec instructions <artifact-id> --change "<name>" --json
```

Use the returned data to:

- read completed dependency artifacts
- follow the provided template
- follow artifact-specific instruction text
- write the artifact to the provided output path

After each artifact:

- report brief progress
- re-run `openspec status --change "<name>" --json`
- continue until every required apply artifact is complete

5. Handle ambiguity

- If the context is critically unclear, ask the user.
- Prefer keeping momentum when the answer is reasonably inferable.

6. Show final status

- change name and location
- artifacts created
- readiness for implementation

Suggested completion summary

```text
Created change: <name>
Artifacts:
- proposal.md
- design.md
- tasks.md

All artifacts created. Ready for implementation.
```

Guardrails

- Create every artifact required for implementation readiness.
- Always read dependency artifacts before creating the next one.
- Do not copy raw instruction metadata blocks into the artifact output.
- If the change already exists, clarify whether to continue it or create a new one.
