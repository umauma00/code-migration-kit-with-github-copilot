# Disposable phase-03 pilots

A pilot authorizes a bounded experiment before the production phase-03 report
exists. It uses the same worker/review/write contracts, backend, requested models
and limits as production. It never supplies production done or approval evidence.
The file runner supports preserve mode; redesign trials remain separately designed.

After actual review of production 00/00b/01/02 and successful formal `judge`,
select risk-weighted sources, run the read-only `pilot plan` first, and obtain
permission for the concrete experiment in one question:

```bash
node migration-kit/scripts/run_migration.mjs pilot plan --root . \
  --sources src/high-risk.py,src/boundary.py --through translation
node migration-kit/scripts/run_migration.mjs pilot prepare --root . \
  --target /absolute/path/outside-project/new-pilot \
  --sources src/high-risk.py,src/boundary.py --through parity --expect-total 5 \
  --note "User authorizes this disposable scope through parity; no production translation"
node migration-kit/scripts/run_migration.mjs pilot run --root /absolute/path/outside-project/new-pilot
```

Run `pilot run` alone in a background terminal, never piped or redirected
(`| Out-String` hides its progress until the end; the hook denies it), and check
it with `status --root PILOT_DIR --wait 600 --format markdown`. The terminal shows
a heartbeat every 15 seconds and one timestamped line per unit change with the
finished/total count.

For plugins, use the loaded plugin's absolute script path. `--through` defaults
to translation; build, smoke and parity require their configured commands.
Source-only cannot authorize parity. The destination must be new and outside
production, including when a parent directory is a symlink alias. Existing work
is never overwritten. Dependencies that have manifest units expand the selection
(the declared review dependencies, transitively), so the scope is usually larger
than the files chosen. `pilot plan` returns that final scope without writing
anything: `counts` (requested, added, total), the added files and a `plain`
sentence in the person's language. Ask for permission with the final count, for
example "選んだ 4 ファイルと、それらが使っている 22 ファイル、合わせて 26 ファイル",
and pass that count as `--expect-total N` (and name it in `--note`). Then
`pilot prepare` authorizes exactly what the person approved, or refuses when the
scope changed in between, and needs no second question. In auto mode pilot
prepare runs unasked: still run `pilot plan` and give its count in the phase
report. If the count is too large for them,
offer choosing other files before preparing anything; nothing needs revoking yet.
Inspect the returned requestedSources, sources, targets and boundary before running.
If a whole-project build/parity command requires additional outputs, include
those sources explicitly or choose translation-only scope. The kit cannot make
an arbitrary whole-project command validate a partial migration automatically.

The coordinator copies source, judge, build inputs and kit profiles, but never
production outputs, state, gates or phase-03 results. A UUID grant is saved in
both production `migration/pilots/ID.json` and pilot `migration/pilot.json`.
It binds parent preparation/judge, child fixed inputs, paths, exact targets and
the authorized boundary. Changes or revocation require a new pilot. Removing
the parent grant revokes it. A copied pilot receipt cannot satisfy production
completion; production translation still requires reviewed 03.

`pilot run` can repeat judge and resume reviewed units. Its local approvals are
limited to the explicit experiment grant and cannot authorize production, later
stages or cleanup. It runs one build after translation joins when build is in
scope, then authorized smoke/parity. Failure stops the sequence. Input amendments
invalidate the grant; amend the production rules at the human gate and create a
new risk-weighted pilot. Never forge a phase-03 report to bootstrap an experiment.

Pilot workers are the same Copilot CLI processes as production. On Stop, stop the
runner; late responses remain invalid.

Commands must use project-relative inputs and cannot name the production path.
They are trusted project commands, not an OS sandbox: a deliberately escaping
script or inherited environment can still access outside files. Review command
definitions/environment and run in a disposable container if that isolation is
required. Executable bits are retained when copying scripts.

For each round save selected risks, rule/input hashes, grant ID, measured calls,
review findings, validation outputs, host limitations and proposed amendments
in the production stress report. Archive evidence, revoke the grant, then remove
the disposable workspace and verify its removal. The parent owns this cleanup;
the kit never automatically deletes a completed workspace. Run A/B experiments
and the pilot independently where the host permits it. B receives only source,
with no rulebook, inventory, parent context, skill or personal instruction leak;
if the host cannot guarantee this, report the experiment's limitations.
