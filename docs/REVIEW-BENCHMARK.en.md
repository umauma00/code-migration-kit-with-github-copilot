# Measure before folding workers together (reviewer count, fixer)

[日本語](REVIEW-BENCHMARK.md) | English

Fewer workers in the translation loop means fewer calls and less time, but
only a measurement shows whether quality drops. This benchmark compares two
folds on the same seeded cases with the same Copilot CLI workers:

| Comparison | Current | Fold | Measured |
|---|---|---|---|
| Review | two independent reviews + arbiter | one review (both lenses) + arbiter | miss rate after the arbiter, findings on clean controls |
| Fix | fixer | implementer handed the confirmed findings | behavior-check pass rate of the fixed file |

It does not change the translation loop. A person reads the results and
decides whether to fold.

## Background

Anthropic's article "[Building agents: When to fold subagents into your main agent loop](https://claude.com/ja/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)" (2026-10-22) recommends:

- Build a small eval first and fold one subagent at a time; keep it separate if the score drops.
- Look at which tasks changed, not only the score.
- Breakage may show on only some runs (one in two in the article's example), so run each task several times.

By the article's criteria, roles that chain outputs or touch the same data are
fold candidates; the fixer shares the implementer's tools and output contract.
The two reviewers are separate so the graded party does not grade itself, a
reason outside the article's criteria. Both are measured here before deciding.

## Steps

Model calls use quota and may cost money. The cases use the three files of `fixtures/mini`.

1. From the kit root, create a benchmark root in a directory that does not exist yet:

   ```bash
   node scripts/review_benchmark.mjs setup --target /tmp/review-bench --model MODEL_ID
   ```

   Workers can read the root, so setup leaves out this benchmark's docs and code, the fixture judge's mutant, and past review and validation records (`docs/reviews`, `docs/validation`, `docs/plans`), and fails if a line of the correct code is still there. CHANGELOG and other docs still say the benchmark exists. Every role gets that model; edit `models` and `reasoningEfforts` in
   `/tmp/review-bench/migration/config.json` to differ per role. Setup sets
   `reviewFocus: "shared"` so a single reviewer covers both lenses.

2. Check the call bound:

   ```bash
   node scripts/review_benchmark.mjs plan --root /tmp/review-bench --runs 3
   ```

   The default (9 cases x 3 runs) makes at most 177 calls: 81 for two
   reviewers, 54 for one, 42 for fixes. The arbiter runs only when a review
   found something, so actual calls are at or below the bound. Use
   `--part review|fix` for one half and `--cases math-trunc,text-trailer` to
   select cases.

3. Run with the plan's `total` as `--max-calls`:

   ```bash
   node scripts/review_benchmark.mjs run --root /tmp/review-bench --runs 3 --max-calls 177
   ```

   Results go to `review-bench-results/<time>/` in the temp directory
   (printed when the run ends), never inside the root, which workers can
   read; `--out` moves them. They are written only when the run ends, since
   workers may also be allowed to read the temp directory; each fixed file
   exists on disk only while its check runs, under a random name. A root
   setup did not make, or one with a file at a case's target, stops the run
   before anything is written. The output holds `report.md` (tables and the
   cases that changed), `summary.json`, `results.jsonl` (every finding, its
   match and tokens per run) and `fixes/`.

   Three failures before any call works (login, model ID) stop the run
   without measuring anything: calls in flight are aborted and no new ones
   start. With concurrency, calls already started count too. A single
   malformed answer is recorded as a failed run and the run goes on.
   Ctrl-C stops the run as interrupted.

## Cases and matching

| Case | Seeded defect | Kind |
|---|---|---|
| math-trunc | quotient via `Math.trunc` (Python floors) | semantics |
| math-remainder | remainder via JS `%` (sign differs) | semantics |
| math-zero | no zero-division error | semantics |
| math-double | trunc and zero division | semantics |
| text-length | `name.length` (UTF-16 units) | semantics |
| text-trailer | no PORT STATUS trailer | rules |
| main-import | imports `./math_ops.js` (rules require .mjs) | rules |
| control-math / control-text | none: every finding is a false finding | — |

- A finding catches a defect when it cites the defect's exact line as
  `path:line`, or matches the defect's `pattern`. One finding counts for one
  defect at most: a cited line decides first, and a finding whose words alone
  match several defects counts for none (recorded as `ambiguous`); one finding naming both trunc and zero division counts for one. Patterns are
  narrow: a finding with no line that only says "no check for b being 0" may
  not count, so miss rates can come out high, equally for both variants. Matching
  is mechanical: audit the findings in `results.jsonl` before deciding.
- The fix comparison hands both variants the same correct findings, so review
  variance stays out of it. Fixed files are judged by the checks in
  `fixtures/review-bench/checks/`; a file returned unchanged fails. The checks
  import model output with Node with only PATH and the temp directory in
  their environment, no credentials; that is not isolation, so run the
  benchmark in a throwaway environment.
- Add cases in `fixtures/review-bench/cases.json`; `tests/review-benchmark.test.mjs`
  checks that seeded cases fail their check and controls pass it.

## Deciding

Following the article (keep it separate if the score drops), consider a fold only when:

- **Review**: one reviewer's miss rate after the arbiter is at or below two
  reviewers', no defect is caught less often by one reviewer under "Cases that
  changed", and confirmed findings on clean controls do not rise. A case
  whose completed runs differ (failures) is marked: measure it again with equal runs.
- **Fix**: the implementer's pass rate is at or above the fixer's, with no case passing fewer times.

No difference is not proof that a fold is safe: three small files and eight
defects. Add harder cases close to real projects before deciding. If you do
fold, change the translation loop as a separate change and rerun this benchmark.
