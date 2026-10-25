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

   Every role gets that model; edit `models` and `reasoningEfforts` in
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

   Results go to `/tmp/review-bench/bench-results/<time>/`: `report.md`
   (tables and the cases that changed), `summary.json`, `results.jsonl` (every
   finding, its match and tokens per run) and `fixes/`. If the first call fails
   (login, model ID), the run stops without measuring anything.

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

- A finding catches a defect when it cites the defect's line (within one
  line) as `path:line`, or matches the defect's `pattern`. Matching is
  mechanical: audit the findings in `results.jsonl` before deciding.
- The fix comparison hands both variants the same correct findings, so review
  variance stays out of it. Fixed files are judged by the checks in
  `fixtures/review-bench/checks/`; a file returned unchanged fails. The checks
  import model output with Node, so run the benchmark in a throwaway root.
- Add cases in `fixtures/review-bench/cases.json`; `tests/review-benchmark.test.mjs`
  checks that seeded cases fail their check and controls pass it.

## Deciding

Following the article (keep it separate if the score drops), consider a fold only when:

- **Review**: one reviewer's miss rate after the arbiter is at or below two
  reviewers', no defect is caught less often by one reviewer under "Cases that
  changed", and confirmed findings on clean controls do not rise.
- **Fix**: the implementer's pass rate is at or above the fixer's, with no case passing fewer times.

No difference is not proof that a fold is safe: three small files and eight
defects. Add harder cases close to real projects before deciding. If you do
fold, change the translation loop as a separate change and rerun this benchmark.
