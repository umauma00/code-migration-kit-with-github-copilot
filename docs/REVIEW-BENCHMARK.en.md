# Measure before folding workers together (reviewer count, fixer)

[日本語](REVIEW-BENCHMARK.md) | English

A simpler set of roles may reduce calls or elapsed time, but the effect and
quality need measuring. This benchmark compares two alternatives on the same
seeded cases with the same Copilot CLI workers:

| Comparison | Current | Fold | Measured |
|---|---|---|---|
| Review | two independent reviews + arbiter | one review (both lenses) + arbiter | miss rate after the arbiter, findings on clean controls |
| Fix | fixer | implementer handed the confirmed findings | behavior-check pass rate of the fixed file |

It does not change the translation loop. A person reads the results and
decides whether to fold.

The fix comparison asks whether the implementer can do the fixer's work in a
fresh CLI session. Both variants still make one fix call. It does not measure
retaining the implementation session's context or eliminating that call.

## Background

Anthropic's article "[Building agents: When to fold subagents into your main agent loop](https://claude.com/ja/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)" (2026-10-22) recommends:

- Build a small eval first and fold one subagent at a time; keep it separate if the score drops.
- Look at which tasks changed, not only the score.
- Breakage may show on only some runs (one in two in the article's example), so run each task several times.

By the article's criteria, roles that chain outputs or touch the same data are
fold candidates; the fixer shares the implementer's tools and output contract.
One reviewer still provides verification independent of the generator. This
comparison measures how much the second reviewer adds to quality.

## Steps

Model calls use quota and may cost money. The cases use the three files of `fixtures/mini`.

1. From the kit root, create a benchmark root in a directory that does not exist yet:

   ```bash
   node scripts/review_benchmark.mjs setup --target /tmp/review-bench --model MODEL_ID
   ```

   Workers can read the root, so setup leaves out this benchmark's docs and code, and the fixture judge's mutant (past review and validation records live in `history/`, which install never copies), and fails if a line of the correct code is still there. CHANGELOG and other docs still say the benchmark exists. Every role gets that model; edit `models` and `reasoningEfforts` in
   `/tmp/review-bench/migration/config.json` to differ per role. Setup sets
   `reviewFocus: "shared"` so a single reviewer covers both lenses.

2. Start with one run per case to check the root and workers. Check the call bound:

   ```bash
   node scripts/review_benchmark.mjs plan --root /tmp/review-bench
   ```

   The default is one run per case: at most 59 calls for 9 cases, with 27 for
   two reviewers, 18 for one, and 14 for fixes. The arbiter runs only when a review
   found something, so actual calls are at or below the bound. Use
   `--part review|fix` for one half and `--cases math-trunc,text-trailer` to
   select cases. The configured `concurrency` caps actual model calls,
   including both reviewers.

3. Run with the plan's `total` as `--max-calls`:

   ```bash
   node scripts/review_benchmark.mjs run --root /tmp/review-bench --max-calls 59
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

4. Before deciding whether to fold, repeat the same conditions more than once.
   One run cannot reveal intermittent misses. Three runs, for example, allow
   up to 177 calls. Check the plan again and write to a new results directory:

   ```bash
   node scripts/review_benchmark.mjs plan --root /tmp/review-bench --runs 3
   node scripts/review_benchmark.mjs run --root /tmp/review-bench --runs 3 --max-calls 177
   ```

   Start with small cases and add cases close to real migrations before deciding.
   A single setup check is not a basis for reducing reviewers.

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
  `fixtures/review-bench/checks/`. For `main`, a separate temporary directory
  holds the candidate and correct dependencies; the check runs it with stdin
  and compares its output, regardless of quote style. An unchanged file,
  wrong output or generated code that exceeds the check's time limit fails.
  Model-call and check-process startup failures are recorded separately.
- Arbitration must decide every supplied finding exactly once, as in the
  production loop. Missing, unknown or duplicate references fail that run.
- Every case needs a PORT STATUS comment on the last nonempty line. A header
  or string containing the words does not pass. Trailing blank lines and CRLF
  are allowed.
- Tokens include failed runs. If any call's usage is unavailable, the total is
  `unknown`. Token counts are not measured charges.
- Checks execute model output with Node with only PATH and temporary-directory
  variables in their environment, no credentials. That is not isolation, so use
  a throwaway environment.
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
