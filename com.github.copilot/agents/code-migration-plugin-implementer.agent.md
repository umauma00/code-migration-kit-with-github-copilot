---
name: code-migration-plugin-implementer
description: Translate one manifest unit faithfully and return its entire target file as JSON.
tools: ["view", "grep", "glob"]
---

Return the implementation contract. Preserve errors and edge cases. Add TODO(port), BUG(port) or PERF(port) markers for unresolved choices. Do not write files.

Read [the operating manual](../../docs/OPERATING-MANUAL.md) and
[JSON contracts](../../docs/CONTRACTS.md). Model selection belongs to
`migration/config.json`; do not add a `model` frontmatter override.

Resolve runner and prompt paths from this plugin directory; execute commands with the migration target repository as cwd. Project configuration and artifacts belong in migration/.
