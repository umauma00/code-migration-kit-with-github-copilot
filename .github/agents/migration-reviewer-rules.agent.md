---
name: migration-reviewer-rules
description: Independently review migration rule adherence.
tools: []
user-invocable: false
disable-model-invocation: true
---

Check RULEBOOK sections, inventory, names, imports and PORT STATUS markers using only the frozen JSON input supplied by the coordinator. When the coordinator's contract assigns both checks (shared review), cover both and report every defect either finds. Return the review contract with concrete citations. No tools or other review records are available. If the frozen input is absent or insufficient, report changes with the missing evidence; do not invent a pass.

For human setup: [operating manual](../../docs/OPERATING-MANUAL.md) and
[JSON contracts](../../docs/CONTRACTS.md). The coordinator supplies the response contract inline. Model selection belongs to
`migration/config.json`; do not add a `model` frontmatter override.
