// SPDX-License-Identifier: Apache-2.0
// Every command line the kit accepts, in one place. Each script parses its
// arguments against its spec here, so an unknown option, a missing value or a
// stray word fails with the accepted options instead of being read as
// something else. tests/cli-usage.test.mjs checks every command written in the
// guides, prompts, skills and scripts against these specs.

// Option name -> placeholder for its value, or null for a flag (no value).
const runnerGlobal = { root: 'PATH', copilot: 'PATH' };
const phaseUsage = { note: 'TEXT', tokens: 'N', subagents: 'N', model: 'ID', 'confirm-no-dependencies': null };
const surveyOptions = { kind: 'facts|contracts|inventory', 'max-files': 'N', sites: 'PATH' };
// Positional values with a fixed set (lib/phases.mjs orderedPhases, lib/pipeline.mjs approve).
export const phaseIds = ['00', '00b', '01', '02', '03', '04', '05', '05b', '05c', '06'];
export const approvalStages = ['translation', 'build', 'smoke', 'parity', 'post-parity', 'handoff'];

export const specs = {
  run_migration: {
    script: 'run_migration.mjs', global: runnerGlobal,
    commands: {
      help: {},
      doctor: { options: { 'check-cli': null } },
      status: { options: { format: 'json|markdown|todo|checklist', wait: 'SECONDS', fast: null } },
      guidance: { options: { message: 'TEXT', format: 'json|markdown' } },
      models: { sub: { list: { options: { format: 'json|markdown' } }, set: { options: { role: 'ROLE', model: 'ID', effort: 'LEVEL|default', context: 'default|long_context', assign: 'ROLE=ID[:EFFORT][:long_context],...' } } } },
      preferences: { options: { language: 'ja|en', 'original-runtime': 'available|unavailable', 'phase-mode': 'normal|relaxed|auto' } },
      settings: { sub: { init: { options: { source: 'LANGUAGE', target: 'LANGUAGE', 'source-roots': 'CSV' } }, check: {}, apply: {} } },
      sessions: { sub: { status: { options: { run: 'RUN_ID' } }, prune: { options: { run: 'RUN_ID' } } } },
      guardrails: { sub: { show: {}, install: { options: { add: 'CSV', remove: 'CSV', deny: 'CSV', waiver: 'NOTE', replace: null } } } },
      phase: { sub: { init: {}, next: {}, check: { args: ['ID'], choices: [phaseIds], options: { 'confirm-no-dependencies': null } }, start: { args: ['ID'], choices: [phaseIds] }, complete: { args: ['ID[,ID...]'], choices: [phaseIds], options: phaseUsage }, waive: { args: ['ID'], choices: [phaseIds], options: { note: 'TEXT' } } } },
      survey: { sub: { plan: { options: surveyOptions }, run: { options: surveyOptions }, status: { options: surveyOptions }, merge: { options: surveyOptions } } },
      'source-spec': { sub: { init: { options: { apply: null } }, check: {} } },
      judge: {}, 'judge-prepare': {},
      approve: { args: ['STAGE'], choices: [approvalStages], options: { note: 'TEXT', batch: 'N', targets: 'PATH,PATH', 'complete-phase': '03' } },
      translate: { options: { 'max-calls': 'N' } },
      pilot: { sub: { prepare: { options: { target: 'NEW_DIR', sources: 'CSV', through: 'translation|build|smoke|parity', note: 'TEXT' } }, run: {} } },
      repair: { options: { target: 'PATH', evidence: 'migration/PATH', queue: 'migration/QUEUE.json', 'max-calls': 'N' } },
      diagnose: { options: { stage: 'build|smoke|parity' } },
      'repair-round': { options: { stage: 'build|smoke|parity' } },
      'build-loop': { options: { note: 'TEXT', through: 'build|smoke|parity', 'max-rounds': 'N', 'max-calls': 'N' } },
      build: {}, smoke: {}, parity: {}, handoff: {},
      unlock: { options: { pid: 'PID' } }
    }
  },
  install: {
    script: 'install.mjs',
    options: { target: 'PATH', layout: 'repository|plugin', model: 'MODEL_ID', harness: 'copilot|vscode-local', 'worker-backend': 'NAME',
      'verification-mode': 'runtime|source-only', 'preparation-profile': 'standard|source-as-spec', models: 'ROLE=ID,...', language: 'ja|en',
      'fix-policy': 'rereview|single-pass', 'with-workflow': null, apply: null }
  },
  demo: { script: 'demo.mjs', global: { target: 'PATH', model: 'MODEL_ID' }, optionalCommand: true, commands: { setup: {} } },
  review_benchmark: { script: 'review_benchmark.mjs', commands: {
    setup: { options: { target: 'NEW_DIR', model: 'MODEL_ID' } },
    plan: { options: { root: 'PATH', runs: 'N', cases: 'CSV', part: 'review|fix|all' } },
    run: { options: { root: 'PATH', runs: 'N', cases: 'CSV', part: 'review|fix|all', 'max-calls': 'N', out: 'PATH', copilot: 'PATH' } } } },
  queue_runner: { script: 'queue_runner.mjs', global: { root: 'PATH', manifest: 'migration/manifest.tsv' }, optionalCommand: true,
    commands: { status: {}, next: { options: { batch: 'N' } }, verify: {} } },
  diagnostic_queue: { script: 'diagnostic_queue.mjs', options: { root: 'PATH', diagnostics: 'migration/PATH.tsv', out: 'migration/PATH.json', stage: 'build|smoke|parity' } },
  preparation_cli: { script: 'preparation_cli.mjs', global: { root: 'PATH' }, commands: {
    'inventory-preview': { options: { shards: 'LIST', sites: 'PATH', out: 'PATH' } },
    'inventory-merge': { options: { shards: 'LIST', sites: 'PATH', 'expected-hash': 'SHA256' } },
    'package-cycles': { options: { map: 'PATH' } },
    'dependency-samples': { options: { seed: 'TEXT', size: 'N', out: 'PATH' } },
    'dependency-targets': { options: { size: 'N', unresolved: 'PATH', 'depmap-root': 'DIR', out: 'PATH' } },
    'dependency-diff': { options: { files: 'LIST', audit: 'PATH', out: 'PATH' } } } },
  audit_inputs: { script: 'audit_inputs.mjs', global: { root: 'PATH' }, commands: {
    freeze: { options: { type: 'TYPE', files: 'LIST', out: 'PATH' } },
    run: { options: { directory: 'PATH', copilot: 'PATH' } },
    'run-pending': { options: { copilot: 'PATH' } },
    retire: { options: { directory: 'PATH', 'superseded-by': 'PATH', reason: 'TEXT' } },
    submit: { options: { directory: 'PATH', response: 'PATH' } } } },
  make_review_dependencies: { script: 'make_review_dependencies.mjs',
    options: { root: 'PATH', 'source-root': 'DIR', 'source-roots': 'DIR,DIR', 'depmap-root': 'DIR', edges: 'PATH', out: 'PATH' } },
  depmap_ts: { script: 'depmap_ts.mjs', repeatable: ['source-root'], options: { root: 'DIR', out: 'DIR', 'source-root': 'DIR' } },
  // Python and shell scripts parse their own arguments; their specs here let
  // the usage test check the commands written for them.
  depmap_python: { script: 'depmap_python.py', repeatable: ['source-root'], options: { root: 'DIR', out: 'DIR', 'source-root': 'DIR' } },
  depmap_c: { script: 'depmap_c.py', repeatable: ['source-root'], options: { root: 'DIR', out: 'DIR', 'source-root': 'DIR' } },
  depmap_csharp: { script: 'depmap_csharp.py', repeatable: ['source-root'], options: { root: 'DIR', out: 'DIR', 'source-root': 'DIR' } },
  depmap_java: { script: 'depmap_java.py', repeatable: ['source-root'], options: { root: 'DIR', out: 'DIR', 'source-root': 'DIR' } },
  depmap_php: { script: 'depmap_php.py', repeatable: ['source-root'], options: { root: 'DIR', out: 'DIR', 'source-root': 'DIR', 'include-path': 'DIR,DIR', 'include-var': 'NAME=VALUE,...' } },
  depmap_vbnet: { script: 'depmap_vbnet.py', repeatable: ['source-root'], options: { root: 'DIR', out: 'DIR', 'source-root': 'DIR' } },
  depmap_cobol: { script: 'depmap_cobol.py', repeatable: ['source-root'], options: { root: 'DIR', out: 'DIR', 'source-root': 'DIR', 'copy-path': 'DIR,DIR' } },
  make_manifest: { script: 'make_manifest.py', repeatable: ['sub', 'include', 'map-root'], options: { order: 'PATH', out: 'PATH', sub: 'OLD=NEW', 'map-root': 'SOURCE=TARGET', prefix: 'DIR/', include: 'DIR/' } },
  build_daemon: { script: 'build_daemon.sh', options: { cmd: 'COMMAND', interval: 'SECONDS', once: null } }
};

const describe = options => Object.entries(options).map(([name, meta]) => meta === null ? `--${name}` : `--${name} ${meta}`).join(', ') || 'none';

// The command (and subcommand) a parsed command line names, with the options
// and positional words it accepts.
export function resolve(spec, words) {
  if (!spec.commands) return { name: spec.script, options: { ...spec.options }, args: [], choices: [], used: 0 };
  const [cmd, sub] = words;
  const known = Object.keys(spec.commands);
  if (cmd === undefined) {
    if (spec.optionalCommand) return { name: spec.script, options: { ...spec.global }, args: [], choices: [], used: 0 };
    throw new Error(`Missing command. Commands: ${known.join(', ')}`);
  }
  const entry = spec.commands[cmd];
  if (!entry) throw new Error(`Unknown command ${cmd}. Commands: ${known.join(', ')}`);
  if (!entry.sub) return { name: cmd, options: { ...spec.global, ...entry.options }, args: entry.args ?? [], choices: entry.choices ?? [], used: 1 };
  const subs = Object.keys(entry.sub);
  if (!entry.sub[sub]) throw new Error(`${sub === undefined ? `Missing action for ${cmd}` : `Unknown ${cmd} action ${sub}`}. Use ${cmd} ${subs.join(' | ')}`);
  const leaf = entry.sub[sub];
  return { name: `${cmd} ${sub}`, options: { ...spec.global, ...leaf.options }, args: leaf.args ?? [], choices: leaf.choices ?? [], used: 2 };
}

// Every option any command of the spec accepts, so the command word can be
// found wherever it sits among the options.
export function allOptions(spec) {
  const out = { ...spec.global, ...spec.options };
  const visit = node => { Object.assign(out, node.options); for (const child of Object.values(node.sub ?? {})) visit(child); };
  for (const entry of Object.values(spec.commands ?? {})) visit(entry);
  return out;
}

// The runner's flags (options without a value), for the guardrail hook that
// reads runner command lines the way parseCommandLine does.
export const runnerFlags = new Set(['--help', ...Object.entries(allOptions(specs.run_migration)).filter(([, meta]) => meta === null).map(([name]) => `--${name}`)]);

// An option whose placeholder lists its values ("json|markdown") takes one of them.
const optionChoices = meta => typeof meta === 'string' && /^[a-z0-9-]+(?:\|[a-z0-9-]+)+$/.test(meta) ? meta.split('|') : null;

// placeholder: a documentation check passes a test for words like ID or
// TEXT, which stand for any value; "a|b" there means each of a and b.
export function parseCommandLine(argv, spec, { placeholder = () => false } = {}) {
  const known = allOptions(spec), args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { args.help = true; continue; }
    if (!arg.startsWith('--')) { args._.push(arg); continue; }
    const key = arg.slice(2);
    if (key.includes('=')) throw new Error(`Write ${arg.slice(0, arg.indexOf('='))} VALUE as two words, not ${arg}`);
    if (!(key in known)) {
      // Name the accepted options of the command when it can be told.
      let accepted = '';
      try { const target = resolve(spec, args._.length ? args._ : argv.slice(i + 1).filter(w => !w.startsWith('-'))); accepted = ` Options for ${target.name}: ${describe(target.options)}.`; } catch {}
      throw new Error(`Unknown option ${arg}.${accepted} Add --help for usage.`);
    }
    if (known[key] === null) { args[key] = true; continue; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg} (expected ${arg} ${known[key]})`);
    const value = argv[++i];
    if (spec.repeatable?.includes(key)) (args[key] ??= []).push(value); else args[key] = value;
  }
  if (args.help) return args;
  const target = resolve(spec, args._);
  for (const key of Object.keys(args)) {
    if (key !== '_' && !(key in target.options)) throw new Error(`Option --${key} does not apply to ${target.name}. Options for ${target.name}: ${describe(target.options)}. Add --help for usage.`);
  }
  const extra = args._.slice(target.used);
  if (extra.length < target.args.length) throw new Error(`${target.name} needs ${target.args.join(' ')}`);
  if (extra.length > target.args.length) throw new Error(`Unexpected ${extra.slice(target.args.length).join(' ')} after ${target.name}${target.args.length ? ` ${target.args.join(' ')}` : ''}. Add --help for usage.`);
  // Items are trimmed as phaseCommand trims them: "00, 00b" is 00 and 00b.
  const values = (value, separator = '|') => placeholder(value) ? [] : value.split(separator).map(v => v.trim()).filter(v => !placeholder(v));
  for (const [key, value] of Object.entries(args)) {
    const allowed = key === '_' ? null : optionChoices(target.options[key]);
    for (const v of allowed ? values(value) : []) if (!allowed.includes(v)) throw new Error(`--${key} must be one of ${allowed.join(', ')}, not ${v}`);
  }
  target.choices.forEach((allowed, i) => {
    if (!allowed) return;
    // phase complete takes a comma list; documentation may also write a|b.
    for (const v of values(extra[i], /[|,]/)) if (!allowed.includes(v)) throw new Error(`${target.name} ${target.args[i]} must be one of ${allowed.join(', ')}, not ${v}`);
  });
  return args;
}

// Usage text for a script that has no hand-written one.
export function usageText(spec) {
  const line = (words, node) => `  ${[spec.script, ...words, ...(node.args ?? [])].join(' ')}${Object.keys(node.options ?? {}).length ? ` [${describe(node.options).replaceAll(', ', '] [')}]` : ''}`;
  const lines = [];
  if (!spec.commands) lines.push(line([], spec));
  else for (const [cmd, entry] of Object.entries(spec.commands)) {
    if (entry.sub) for (const [sub, leaf] of Object.entries(entry.sub)) lines.push(line([cmd, sub], leaf));
    else lines.push(line([cmd], entry));
  }
  const global = Object.keys(spec.global ?? {}).length ? `\nOptions for every command: ${describe(spec.global)}` : '';
  return `Usage:\n${lines.join('\n')}${global}`;
}
