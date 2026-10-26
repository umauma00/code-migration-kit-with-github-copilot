# Code migration

This repository runs a staged language migration. For any migration request, use
the [code-migration skill](skills/code-migration/SKILL.md) and read only what the
current phase needs. The person works from chat only: run commands yourself.

- Never approve a gate or record a phase on your own recommendation; the host asks
  the person before every human-gate command.
- Never edit `migration/RULEBOOK.md`, `migration/inventory.tsv`, the judge or
  `migration/guardrails.json` outside an agreed gate.
- Translate only through the runner; a file is done only with a current reviewed receipt.
- Never interrupt or relaunch a running command/survey/worker just for CPU at
  100%, low CPU, silence, elapsed time (including 600 seconds), or output volume.
  Use a continuing/background terminal and poll the same session. A host wait
  returning is not job failure. Normal execution is continuous; finite time,
  call or round limits require the person's explicit choice.
