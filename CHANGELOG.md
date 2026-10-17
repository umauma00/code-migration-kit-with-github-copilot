# Unreleased

- Add the source-as-spec preparation profile for projects without a runnable
  original or a specification: `source-spec init|check` scaffolds source-only
  preparation from every source file, 00b refuses unfilled `TODO(spec)` contracts,
  and `phase complete 00b,01,02` records one user review of the whole package.
- Every runner failure now prints its cause, impact and choices with one
  recommended option and reasons; `guidance --message` explains other failures.
- Add `status --format todo|checklist` so hosts show the ten phases with exactly
  one current phase; reports start with the checklist.
- The bundled Python dependency parser skips `migration-kit/` and `migration/`.
- Correct the operating manual: VS Code also defaults to the CLI worker backend.

- Preserve every admitted diagnostic repair job across Stop/resume, including
  undispatched dependencies; bind fresh reviews to immutable intent evidence and
  refuse downstream approval until all repair obligations are reviewed.
- Reject fixed inventory receipt/input collisions before any publication; correct
  executable examples and distinguish paired inventory reviews from extra sampling.

- Add sealed, disposable preserve-mode pilot grants before production phase 03,
  without importing experiment receipts or weakening production approval.
- Add early comparator validation/reuse, explicit preparation model plans and
  fixed audit task/result transport; restore source-map and inventory audit
  contracts with deterministic diff/sample/shard tools and package cycle checks.
- Add exact translation batch scopes and a single-lock multi-target diagnostic
  repair queue under the existing AI cap and fresh build approval policy.
- Fix plugin worker documentation links; show native host capabilities as unknown
  instead of verified, and keep manually reported models out of measured costs.
- Add protected complete design inputs/architecture template and explicit optional
  TODO line-count receipts. The generic redesign module runner and native host
  metadata/event bridge remain unimplemented.

- Enforce reviewed preparation order through phase records at the skill entry and runner gates; retain the ten existing phase IDs and explicit source-only parity applicability.
- Export main-compatible migration/cost-log.tsv with measured timing, actual worker counts and unknown usage/model values, retaining existing rows and deduplicating exports.

## Unreleased — VS Code orchestration

- Parent-session TODO ownership, verified-tool/chat fallback and actionable 00/00b reports.
- Read-only early status with Markdown, live lock/run roles, evidence and blockers.
- Explicit source-only judge plan and smoke-to-handoff receipts; parity stays unverified.
- Dependency-aware slot refilling under the existing global AI concurrency cap.
- Host built-in Rubber Duck advisory records and existing repair/reverification routing.
- Cancellation/resumption regressions and honest pending live VS Code checklist.


- Track the ten migration phases in the host TODO list from the parent
  orchestrator, including approval waits, revisions, failures and resumption
  from current evidence. Enable the `todo` alias in both orchestrator profiles
  and retain a chat-checklist fallback when the host tool is unavailable.

- Add a native host-worker backend for VS Code Local and Copilot sessions: task
  claim/submission, tool-free profiles, explicit models, stale-result rejection,
  and cancellation/resume through the shared runner. Preserve the CLI default.
- Record native host-managed instruction isolation separately from CLI isolation;
  add installer options, host-driving instructions and offline transport tests.
- Reserve native plugin worker names as well as qualified IDs, bind task listing
  to the active run ID, and make VS Code plugin initialization select native.
  Clarify per-call model selection and require host metadata checks before submission.
- Publish complete runner locks atomically without replacing an existing lock,
  preventing native clients from observing an empty lock during startup.

- Require interactive phase reports with artifact links, review points, the next
  phase and a copyable reply. Use available question tools for missing decisions,
  with chat fallback and explicit approval wording for production stages.
- Reuse existing answers, keep unanswered questions pending, and preserve
  noninteractive workers. Distinguish judge preparation from its later validation
  receipt so early phase routing does not repeat judge setup unnecessarily.

# 0.2.0 — 2026-10-11

- Add an Agent Plugins 1.0 manifest, portable code-migration skill, six
  Copilot-specific agent profiles, worker hook and local marketplace manifest.
- Add `install --layout plugin`: keep runtime in the plugin, initialize only
  project configuration/rulebook/inventory, and preserve existing project data.
- Mount the plugin explicitly for CLI workers; diagnose mounting support and
  reject personal/project worker profiles that would shadow plugin profiles.
- Fingerprint bundled runtime content so plugin changes invalidate approvals
  and reviewed completion receipts. Include project hooks and agent definitions;
  preserve fingerprints across plugin relocation.
- Resolve local agent YAML names and nested file IDs before CLI execution. Reject
  aliases of reserved plugin selectors while allowing unqualified names to coexist.
  Bundle the ISC-licensed yaml parser so plugin use requires no npm install.
- Retain repository-copy installation and its existing default configuration.

# 0.1.5 — 2026-10-10

- Disable ambient custom instructions for all CLI workers and require the flag
  in doctor. Keep explicit role profiles and put project migration policy in the
  reviewed rulebook/inventory. Verify request contents with discoverable canaries.
- Use the same isolated CLI adapter from Dynamic Workflows; retain runner-based
  resume, cancellation, limits and result validation. SDK agent journals/schema
  calls are no longer used. Workflow args may select the Copilot executable.
- Strip only the initial inventory BOM before comment/header classification.
- Separate parser depmap-root from enumerated source roots, accepting repo-root
  paths and cross-package edges. Report edges originating outside the selected
  roots; reject required dependencies outside the scope without replacing a map.
- Add rereview regressions and CLI/workflow worker transport validation. See
  [fixes and rereview](docs/reviews/2026-10-10-copilot-rereview-fixes.md) and
  [upgrading](docs/UPGRADING.md).

# 0.1.4 — 2026-10-10

- Read CLI JSONL machine output and require a successful terminal result plus
  the final main-agent response; preserve long code strings without text wrapping.
- Scope frozen reviews to the unit's declared transitive source dependencies and
  matching inventory rows, retaining full rules and global notes. Require an
  audited dependency-map artifact, include it in fingerprints and preflight
  static serialized input before implementation/fix calls.
- Add an edges.tsv conversion script that includes isolated source files. Missing
  declarations/evidence and malformed inventory fail instead of being omitted.
- Use concrete view/grep/glob tools for implementer, fixer and arbiter; reviewers
  remain tool-free. Check the machine-output CLI flag in doctor.
- Add compatibility regressions and an opt-in real-CLI/local-provider integration
  check. See [fix verification](docs/reviews/2026-10-10-copilot-fixes.md).

Existing installations must create/audit the review dependency map and update
worker profiles. See [upgrading](docs/UPGRADING.md). Actual AI migration quality,
account authentication, VS Code and SDK sessions remain unverified.

# 0.1.3 — 2026-10-08

- Independently reproduce and confirm both Astra findings with a real C compiler.
- Restrict inline-code exclusions to known interpreter options before their
  entrypoint; track cc/node -c inputs and unknown tools' file arguments.
- Add optional buildArtifactRoots to distinguish generated objects, binaries and
  reports from command inputs. Reject overlap with protected inputs, translated
  sources and migration metadata. Display the declaration in doctor.
- Add eight regression tests, update contracts and document the required artifact
  declaration for commands that directly name output files. Existing configs may
  omit the new field; the runner does not infer unknown output-option semantics.

Live model/IDE/SDK consumption and macOS/Windows remain unverified.
See [review fixes](docs/REVIEW-FIXES.md) and [validation](docs/TESTING.md).

# 0.1.2 — 2026-10-08

- Track directly configured command files and explicit verification inputs under
  migration/. Reject generated state/results/gates/runs and run.lock as such inputs.
- Include every explicit manifest target in validation output fingerprints,
  even below node_modules, __pycache__ or .git traversal exclusions.
- Reject invalid UTF-8 before supplying frozen input to either reviewer, including
  repair diagnostics, with the offending filename. Preserve valid Unicode, BOM
  and real U+FFFD characters.
- Add seven rereview regression tests and update contracts and upgrade notes.

Live model/IDE/SDK consumption and macOS/Windows remain unverified.
See [review fixes](docs/REVIEW-FIXES.md) and [validation](docs/TESTING.md).

# 0.1.1 — 2026-10-08

- Hash every manifest source, conventional root build/dependency files, directly
  configured command files and explicit verificationInputs; expose the list in doctor.
- Revoke downstream results/gates on retry and bind validation to predecessor
  execution IDs, including transitive checks and crash-visible running records.
- Give both reviewers identical bounded input with tool-free profiles for CLI and SDK.
- Finish POSIX process-group escalation before returning a timeout; preserve
  process and model failure diagnostics, including invalid JSON and interruption.
- Reject nonadjacent output ancestor collisions. Separate installed runtime check
  scripts from distribution-only tests/demo, and reject empty test runs.
- Select hook output explicitly and provide CLI decisions in the Local payload.
- Add 15 regression tests and update setup, contracts, live checks and upgrade notes.

Live model/IDE/SDK consumption and macOS/Windows remain unverified.
See [review fixes](docs/REVIEW-FIXES.md) and [validation](docs/TESTING.md).

# 0.1.0 — 2026-10-08

Unofficial Copilot adaptation of upstream commit
`cf91c9d5068d9aaf95a36164169f08c3e636c909`.

- Replace Claude-specific operational entrypoints with Copilot instructions,
  a repository skill, six agent profiles, ten VS Code phase prompt files, and
  separate CLI/Local hook templates. Preserve the original README/manual as provenance.
- Add a dependency-free Node coordinator with explicit models, read-only JSON
  workers, two independent reviews, arbitration, bounded repair, concurrency
  control, input-bound approvals, output/review receipts and resumable stages.
- Add install dry run/conflict checks, doctor, diagnostics-based repair, and an
  optional SDK Dynamic Workflows adapter using the same coordinator.
- Correct queue completion semantics, validate manifest mappings, propagate
  Bash build failures, and protect source/judge inputs from output mappings.
- Add a three-file Python/JavaScript fixture, mutation-tested parity harness,
  27 automated tests, Japanese setup documentation and live verification steps.

Live Copilot, VS Code and Dynamic Workflows execution is not yet verified.
See docs/TESTING.md for the exact validation boundary. No source repository
was pushed, published, or changed remotely as part of this adaptation.
