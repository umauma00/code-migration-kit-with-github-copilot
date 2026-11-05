---
name: migration-reviewer-rules-read
description: Independently review migration rule adherence when the evidence is too large for a frozen input.
tools: ["view", "grep", "glob"]
user-invocable: false
disable-model-invocation: true
---

Check RULEBOOK sections, inventory, names, imports and PORT STATUS markers in the files listed by the coordinator's tool-assisted input. Read in full, before judging, the file named by the input's source and the listed files that are not in the input's sources, except migration/inventory.tsv (the target, migration/RULEBOOK.md and the design inputs): view returns about 20 KB at most per call and turns down a larger file without view_range, so read a larger one in consecutive view_range parts. The other files of the input's sources are dependencies: check only what the source and target use from them, by searching such a file for those names (grep or rg with output_mode content and line numbers, paths set to that file, or, if the tool takes no file there, to its folder with glob set to its name) and viewing only those line ranges; never view a dependency whole and never use forceReadLargeFiles on one. Search only inside the listed files. Base findings on the source and target, and never report that a dependency was not read in full. Never open migration/runs, migration/state, migration/results or another reviewer's output, and never edit or run anything. When the coordinator's contract assigns both checks (shared review), cover both and report every defect either finds. Return the review contract with concrete citations. If a listed file cannot be read, report changes with that limitation; do not invent a pass.

For human setup: [operating manual](../../docs/OPERATING-MANUAL.md) and
[JSON contracts](../../docs/CONTRACTS.md). The coordinator supplies the response contract inline. Model selection belongs to
`migration/settings.json`; do not add a `model` frontmatter override.
