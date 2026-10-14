// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readUtf8 } from './text.mjs';
import { runtimeLayout } from './runtime.mjs';

export const roles = ['implementer', 'reviewer-semantics', 'reviewer-rules', 'arbiter', 'fixer'];
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const stamp = () => new Date().toISOString();
export const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function relativeName(value) {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f]/.test(value) ||
      path.posix.isAbsolute(value) || value.split('/').some(x => !x || x === '.' || x === '..')) {
    throw new Error(`Expected a normalized repository-relative path: ${JSON.stringify(value)}`);
  }
  return value;
}
export function safePath(root, name) {
  relativeName(name);
  let current = fs.realpathSync(root);
  const parts = name.split('/');
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    if (fs.existsSync(current) ? fs.lstatSync(current).isSymbolicLink() : isLink(current)) {
      throw new Error(`Symlinks are not supported in migration paths: ${name}`);
    }
    if (i < parts.length - 1 && fs.existsSync(current) && !fs.statSync(current).isDirectory()) {
      throw new Error(`Parent is not a directory: ${name}`);
    }
  }
  return current;
}
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { if(e.code === 'ENOENT') return false; throw e; } }
export const inside = (file, dir) => file === dir || file.startsWith(`${dir}/`);
const metadataRoots = ['.git', '.github', '.claude', '.copilot', 'migration', 'migration-kit'];
const outputProtectedPaths = config => [...metadataRoots, ...config.sourceRoots, ...config.verificationRoots, ...(config.verificationInputs ?? [])];
function pathLocation(file) {
  const ancestors = [];
  for (let current = file;; current = path.dirname(current)) {
    if (fs.existsSync(current)) ancestors.push({ file: current, real: fs.realpathSync(current), stat: fs.statSync(current, { bigint: true }) });
    if (path.dirname(current) === current) break;
  }
  const parent = ancestors[0];
  // Resolve the existing parent even when the eventual output does not exist.
  return { resolved: path.resolve(parent.real, path.relative(parent.file, file)),
    stat: parent.file === file ? parent.stat : null, ancestors };
}
const sameFile = (a, b) => a && b && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
function pathsOverlap(root, left, right) {
  if (inside(left, right) || inside(right, left)) return true;
  const a = pathLocation(safePath(root, left)), b = pathLocation(safePath(root, right));
  const within = (file, dir) => file === dir || file.startsWith(`${dir}${path.sep}`);
  // realpath may preserve an alias's spelling, so compare file identities too.
  return within(a.resolved, b.resolved) || within(b.resolved, a.resolved) ||
    b.ancestors.some(parent => sameFile(a.stat, parent.stat)) || a.ancestors.some(parent => sameFile(b.stat, parent.stat));
}
export function assertOutputPath(root, config, target, source) {
  const full = safePath(root, target);
  if (!config.outputRoots.some(dir => inside(target, dir))) throw new Error(`Target outside outputRoots: ${target}`);
  for (const protectedPath of [...outputProtectedPaths(config), ...(source ? [source] : [])]) {
    if (pathsOverlap(root, target, protectedPath)) throw new Error(`Output target overlaps protected path: ${target} (${protectedPath})`);
  }
  return full;
}
export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, content, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function writeJSON(file, object) { atomicWrite(file, `${JSON.stringify(object, null, 2)}\n`); }
export function fileHash(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? hash(fs.readFileSync(file)) : null;
}
export function filesUnder(root, directory) {
  const out = [];
  const visit = name => {
    const full = safePath(root, name);
    if (!fs.existsSync(full)) return;
    const stat = fs.statSync(full);
    if (stat.isFile()) { out.push(name); return; }
    if (!stat.isDirectory()) throw new Error(`Unsupported path: ${name}`);
    for (const entry of fs.readdirSync(full).sort()) {
      if (['.git', 'node_modules', '__pycache__'].includes(entry)) continue;
      visit(`${name}/${entry}`);
    }
  };
  visit(directory);
  return out;
}
export function treeHash(root, directories) {
  return hash(JSON.stringify([...new Set(directories.flatMap(d => filesUnder(root, d)))].sort()
    .map(p => [p, fileHash(safePath(root, p))])));
}
// Convenience defaults, not a dependency resolver. Declare project-specific
// transitive build inputs in verificationInputs as well.
const buildFile = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-(lock|workspace)\.yaml|yarn\.lock|bun\.lockb?|deno\.(jsonc?|lock)|tsconfig(?:\.[^.]+)*\.json|pyproject\.toml|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|setup\.(py|cfg)|tox\.ini|Cargo\.(toml|lock)|go\.(mod|sum)|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|gradle\.properties|gradlew(?:\.bat)?|Makefile|makefile|CMakeLists\.txt|global\.json|NuGet\.config|Directory\.(Build\.(props|targets)|Packages\.props)|.*\.(sln|csproj|fsproj)|\.nvmrc|\.node-version|\.python-version|\.tool-versions)$/;
const generatedMigrationState = ['migration/state', 'migration/results', 'migration/gates', 'migration/runs', 'migration/run.lock', 'migration/phases', 'migration/cost-log.tsv'];
function inlineProgramArguments(argv) {
  const executable = path.posix.basename(argv[0].replaceAll('\\', '/')).replace(/\.exe$/i, '').toLowerCase();
  const node = /^(node|nodejs)$/.test(executable), python = /^(python|pypy)(\d+(\.\d+)*)?$/.test(executable);
  const shell = /^(sh|bash|dash|zsh|ksh)$/.test(executable);
  const options = node ? ['-e', '--eval', '-p', '--print'] : python || shell ? ['-c'] : [];
  // Only interpreter options before its entrypoint have inline-program meaning.
  // File options such as cc/node's -c are not treated as inline programs.
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--' || !arg.startsWith('-')) break;
    if (options.includes(arg) || (shell && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))) return new Set([i + 1]);
    if (node && ['--eval', '--print'].some(option => arg.startsWith(`${option}=`))) return new Set([i]);
    if ((node && ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions'].includes(arg)) ||
        (python && ['-W', '-X'].includes(arg))) i++;
  }
  return new Set();
}
export function verificationFiles(root, config) {
  const inputs = new Set();
  for (const name of config.verificationInputs ?? []) {
    const full = safePath(root, name);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`verificationInputs file missing: ${name}`);
    inputs.add(name);
  }
  for (const name of fs.readdirSync(root)) {
    if (buildFile.test(name) && fs.statSync(safePath(root, name)).isFile()) inputs.add(name);
  }
  for (const argv of Object.values(config.commands ?? {})) {
    if (!argv) continue;
    const inlinePrograms = inlineProgramArguments(argv);
    for (const [index, raw] of argv.entries()) {
      if (inlinePrograms.has(index)) continue;
      let value = raw;
      if (value.includes('{target}')) continue;
      if (value.startsWith('--') && value.includes('=')) value = value.slice(value.indexOf('=') + 1);
      if (value.startsWith('-')) continue;
      const name = path.relative(root, path.resolve(root, value)).split(path.sep).join('/');
      if (!name || name.startsWith('../') || config.outputRoots.some(r => inside(name, r))) continue;
      if (inside(name, '.git')) continue;
      // State/results are rewritten by the runner. Treating them as command
      // inputs would either miss changes or make validation invalidate itself.
      if (generatedMigrationState.some(r => inside(name, r))) throw new Error(`Configured command path overlaps generated migration state: ${name}; move command scripts and inputs outside runtime state directories`);
      // Generated binaries, reports and objects are declared by the project. An
      // unknown tool's -o/--output option is not assumed to mean an output path.
      if ((config.buildArtifactRoots ?? []).some(r => inside(name, r))) continue;
      try { relativeName(name); } catch { continue; }
      let full;
      try { full = safePath(root, name); } catch (e) { if (e.code === 'ENAMETOOLONG') continue; throw e; }
      if (fs.existsSync(full) && fs.statSync(full).isFile()) inputs.add(name);
    }
  }
  return [...inputs].sort();
}
export function loadConfig(root) {
  const config = readJSON(safePath(root, 'migration/config.json'));
  runtimeLayout(root, config);
  if (config.verificationMode !== undefined && !['runtime', 'source-only'].includes(config.verificationMode)) throw new Error('verificationMode must be runtime or source-only');
  if (config.phasePolicy !== undefined && !['strict', 'legacy'].includes(config.phasePolicy)) throw new Error('phasePolicy must be strict or legacy');
  if (config.schemaVersion !== 1) throw new Error('Unsupported config schemaVersion');
  if (config.workerBackend !== undefined && !['copilot-cli', 'native'].includes(config.workerBackend)) throw new Error('workerBackend must be copilot-cli or native');
  if (config.workerBackend === 'native' && !['vscode-local', 'copilot'].includes(config.nativeHarness)) throw new Error('nativeHarness must be vscode-local or copilot for native workers');
  if (config.workerBackend === 'native' && config.nativeHarness === 'vscode-local' && config.runtime === 'plugin') throw new Error('Native vscode-local uses repository layout; the plugin profiles target the Copilot harness');
  for (const field of ['sourceLanguage', 'targetLanguage']) {
    if (typeof config[field] !== 'string' || !config[field].trim()) throw new Error(`${field} is required`);
  }
  if (!['preserve', 'redesign'].includes(config.mode)) throw new Error('mode must be preserve or redesign');
  for (const key of ['sourceRoots', 'outputRoots', 'verificationRoots']) {
    if (!Array.isArray(config[key]) || !config[key].length) throw new Error(`${key} must be a nonempty array`);
    config[key].forEach(p => safePath(root, p));
  }
  for (const dir of config.sourceRoots) {
    if (metadataRoots.some(r => pathsOverlap(root, dir, r))) throw new Error(`Source root overlaps migration metadata: ${dir}`);
  }
  if (config.verificationInputs !== undefined && !Array.isArray(config.verificationInputs)) throw new Error('verificationInputs must be an array of file paths');
  for (const name of config.verificationInputs ?? []) {
    safePath(root, name);
    if (['.git', ...generatedMigrationState, ...config.outputRoots].some(r => pathsOverlap(root, name, r))) throw new Error(`verificationInputs overlaps outputs or runtime state: ${name}`);
  }
  if (config.maxReviewInputBytes !== undefined && (!Number.isInteger(config.maxReviewInputBytes) || config.maxReviewInputBytes < 1024 || config.maxReviewInputBytes > 4 * 1024 * 1024)) throw new Error('maxReviewInputBytes must be between 1024 and 4194304');
  const dependencyPath = reviewDependencyPath(config);
  safePath(root, dependencyPath);
  if (!inside(dependencyPath, 'migration') || generatedMigrationState.some(r => pathsOverlap(root, dependencyPath, r))) throw new Error('reviewDependencyMap must be a file under migration outside generated runtime state');
  for (const out of config.outputRoots) {
    for (const reserved of outputProtectedPaths(config)) {
      if (pathsOverlap(root, out, reserved)) throw new Error(`Output root overlaps protected path: ${out}`);
    }
  }
  if (config.buildArtifactRoots !== undefined && !Array.isArray(config.buildArtifactRoots)) throw new Error('buildArtifactRoots must be an array of directory paths');
  for (const dir of config.buildArtifactRoots ?? []) {
    relativeName(dir);
    const protectedPaths = [...metadataRoots,
      ...config.sourceRoots, ...config.outputRoots, ...config.verificationRoots, ...(config.verificationInputs ?? [])];
    // Report protected descendants before resolving a parent that may be a file.
    if (buildFile.test(dir.split('/')[0]) || protectedPaths.some(p => inside(dir, p) || inside(p, dir)) ||
        protectedPaths.some(p => pathsOverlap(root, dir, p))) throw new Error(`buildArtifactRoots overlaps protected input/output or metadata: ${dir}`);
    const full = safePath(root, dir);
    if (fs.existsSync(full) && !fs.statSync(full).isDirectory()) throw new Error(`buildArtifactRoots must name directories: ${dir}`);
  }
  for (const [key, min, max] of [['concurrency', 1, 16], ['maxFixRounds', 0, 10], ['maxAgentCalls', 1, 10000], ['timeoutSeconds', 1, 86400], ['commandTimeoutSeconds', 1, 86400]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}`);
  }
  for (const r of roles) {
    if (typeof config.models?.[r] !== 'string' || !config.models[r].trim() || /SELECT_MODEL|[<>]/.test(config.models[r])) {
      throw new Error(`Set an available model ID for models.${r}`);
    }
  }
  for (const [key, command] of Object.entries(config.commands ?? {})) {
    if (command !== null && (!Array.isArray(command) || !command.length || command.some(x => typeof x !== 'string' || x.includes('\0')) || !command[0])) {
      throw new Error(`commands.${key} must be null or an argv array`);
    }
  }
  return config;
}
export function readManifest(root, config, manifest = 'migration/manifest.tsv') {
  const lines = fs.readFileSync(safePath(root, manifest), 'utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  if (lines.shift() !== 'source\ttarget') throw new Error('Manifest header must be source<TAB>target');
  const sources = new Set(), targets = new Set();
  const units = lines.filter(Boolean).map(line => {
    const parts = line.split('\t');
    if (parts.length !== 2) throw new Error(`Malformed manifest row: ${line}`);
    const [source, target] = parts;
    for (const p of parts) safePath(root, p);
    if (!config.sourceRoots.some(r => inside(source, r))) throw new Error(`Source outside sourceRoots: ${source}`);
    if (!fs.existsSync(safePath(root, source)) || !fs.statSync(safePath(root, source)).isFile()) throw new Error(`Missing source: ${source}`);
    assertOutputPath(root, config, target, source);
    if (sources.has(source.toLowerCase()) || targets.has(target.toLowerCase())) throw new Error(`Duplicate manifest mapping: ${line}`);
    sources.add(source.toLowerCase()); targets.add(target.toLowerCase());
    return { source, target, id: hash(`${source}\0${target}`).slice(0, 24) };
  });
  for (const target of targets) {
    const parts = target.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (targets.has(parts.join('/'))) throw new Error('Manifest target is also a parent of another target');
    }
  }
  return units;
}
export const reviewDependencyPath = config => config.reviewDependencyMap ?? 'migration/review-dependencies.json';
export function loadReviewDependencies(root, config) {
  const name = reviewDependencyPath(config), file = safePath(root, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Required review dependency map missing: ${name}; generate and audit it in phase 01`);
  const map = JSON.parse(readUtf8(file, name));
  const graph = map?.dependencies;
  if (map?.schemaVersion !== 1 || !graph || Array.isArray(graph) || typeof graph !== 'object') throw new Error('Review dependency map requires schemaVersion: 1 and dependencies object');
  const check = p => {
    const full = safePath(root, p);
    if (!config.sourceRoots.some(r => inside(p, r))) throw new Error(`Review dependency outside sourceRoots: ${p}`);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`Review dependency file missing: ${p}`);
  };
  for (const [source, deps] of Object.entries(graph)) {
    check(source);
    if (!Array.isArray(deps) || new Set(deps).size !== deps.length) throw new Error(`Review dependencies must be a unique array: ${source}`);
    deps.forEach(check);
  }
  return graph;
}
export function reviewSources(root, config, source, graph = loadReviewDependencies(root, config)) {
  const seen = new Set(), queue = [source];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    if (!Object.hasOwn(graph, name)) throw new Error(`Review dependency declaration missing: ${name}; explicitly declare [] for audited independent files`);
    seen.add(name); queue.push(...graph[name]);
  }
  return [...seen].sort();
}
export function sourceOnlyPlan(root, config) {
  const name = 'migration/judge-plan.json';
  const plan = readJSON(safePath(root, name));
  const text = value => typeof value === 'string' && value.trim().length > 0;
  if (plan.schemaVersion !== 1 || plan.verificationMode !== 'source-only' || !text(plan.method) ||
      !Array.isArray(plan.sources) || !plan.sources.length || !Array.isArray(plan.scenarios) || !plan.scenarios.length ||
      !Array.isArray(plan.unverified) || !plan.unverified.length || !plan.unverified.every(text)) {
    throw new Error('Source-only judge plan requires schemaVersion 1, verificationMode source-only, method, nonempty sources, scenarios and unverified limitations');
  }
  const check = (p, roots, kind) => {
    const full = safePath(root, p);
    if (!roots.some(r => inside(p, r)) || [...config.outputRoots, ...generatedMigrationState, ...(config.buildArtifactRoots ?? []), '.git'].some(r => inside(p, r))) throw new Error(`Invalid ${kind} input path: ${p}`);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile() || fs.statSync(full).size === 0) throw new Error(`Missing or empty ${kind} input: ${p}`);
    return p;
  };
  const files = new Set([name]);
  for (const p of plan.sources) files.add(check(p, config.sourceRoots, 'source'));
  for (const scenario of plan.scenarios) {
    if (!scenario || !text(scenario.contract) || scenario.expectationBasis !== 'source-inferred') throw new Error('Source-only scenarios require contract and expectationBasis: source-inferred; do not claim observed original behavior');
    files.add(check(scenario.path, [...config.verificationRoots, ...(config.verificationInputs ?? [])], 'scenario'));
  }
  return { plan, files: [...files].sort().map(p => [p, fileHash(safePath(root, p))]) };
}
export function contextHash(root, config) {
  const layout = runtimeLayout(root, config);
  for (const p of ['migration/RULEBOOK.md', 'migration/inventory.tsv', 'migration/manifest.tsv']) {
    if (!fileHash(safePath(root, p))) throw new Error(`Required artifact missing: ${p}`);
  }
  for (const dir of [...config.sourceRoots, ...config.verificationRoots]) {
    if (!fs.existsSync(safePath(root, dir))) throw new Error(`Input root missing: ${dir}`);
  }
  const graph = loadReviewDependencies(root, config);
  readManifest(root, config).forEach(u => reviewSources(root, config, u.source, graph));
  return hash(JSON.stringify({ config, ...(config.verificationMode === 'source-only' ? { sourceOnlyPlan: sourceOnlyPlan(root, config).files } : {}), configFile: fileHash(safePath(root, 'migration/config.json')), source: treeHash(root, config.sourceRoots), judge: treeHash(root, config.verificationRoots),
    ...(config.workerBackend === 'native' ? { nativeInstructions: treeHash(root, ['AGENTS.md', '.github/copilot-instructions.md', '.github/instructions', '.github/skills']) } : {}),
    reviewDependencies: { map: fileHash(safePath(root, reviewDependencyPath(config))), files: Object.keys(graph).sort().map(p => [p, fileHash(safePath(root, p))]) },
    manifestSources: readManifest(root, config).map(u => [u.source, fileHash(safePath(root, u.source))]),
    verificationInputs: verificationFiles(root, config).map(p => [p, fileHash(safePath(root, p))]),
    artifacts: ['migration/RULEBOOK.md', 'migration/inventory.tsv', 'migration/manifest.tsv'].map(p => fileHash(safePath(root, p))),
    runtime: layout.plugin
      ? { plugin: treeHash(layout.root, ['plugin.json', 'package.json', 'com.github.copilot', 'skills', 'lib', 'scripts', 'prompts', 'docs', 'templates']),
        project: treeHash(root, ['.github/agents', '.claude/agents', '.github/hooks']) }
      : treeHash(root, ['.github/copilot-instructions.md', '.github/agents', '.github/hooks', '.github/skills', '.github/extensions',
        'migration-kit/lib', 'migration-kit/scripts', 'migration-kit/prompts', 'migration-kit/docs']) }));
}
export const statePath = (root, unit) => safePath(root, `migration/state/units/${unit.id}.json`);
export function unitState(root, unit) {
  const file = statePath(root, unit);
  try { return fs.existsSync(file) ? readJSON(file) : null; }
  catch (e) { if (e instanceof SyntaxError) return null; throw e; }
}
export function done(root, unit, context) {
  const state = unitState(root, unit), output = safePath(root, unit.target);
  if (!(state?.status === 'done' && state.contextHash === context && state.target === unit.target &&
    fs.existsSync(output) && fs.statSync(output).isFile() && fs.statSync(output).size > 0 &&
    state.outputHash === fileHash(output) && state.reviewInputHash && state.reviews?.length === 2 && state.reviewEvidence?.length === 2 &&
    state.reviewEvidence.every(e => fileHash(safePath(root, e.path)) === e.hash) &&
    (!state.arbitration || fileHash(safePath(root, state.arbitration.path)) === state.arbitration.hash))) return false;
  try {
    const findings = [];
    for (const [i, role] of ['reviewer-semantics', 'reviewer-rules'].entries()) {
      if (state.reviews[i] !== state.reviewEvidence[i].path) return false;
      const record = readJSON(safePath(root, state.reviews[i])), result = record.result;
      if (record.role !== role || record.reviewInputHash !== state.reviewInputHash || result?.kind !== 'review' || result.target !== unit.target ||
          !Array.isArray(result.findings) || (result.verdict === 'pass') !== (result.findings.length === 0)) return false;
      findings.push(...result.findings.map(f => `${role}:${f.id}`));
    }
    if (!findings.length) return true;
    if (!state.arbitration) return false;
    const record = readJSON(safePath(root, state.arbitration.path)), result = record.result;
    return record.role === 'arbiter' && result?.kind === 'arbitration' && result.target === unit.target &&
      result.decisions?.length === findings.length && new Set(result.decisions.map(d => d.finding)).size === findings.length &&
      result.decisions.every(d => findings.includes(d.finding) && d.confirmed === false);
  } catch { return false; }
}
export function lockRun(root, task, { runId } = {}) {
  const lock = safePath(root, 'migration/run.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const pending = `${lock}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(pending, JSON.stringify({ pid: process.pid, task, runId, startedAt: stamp() }), { flag: 'wx' });
    // Publish complete metadata atomically without replacing another owner's
    // lock. Opening the public path first lets native clients read empty JSON.
    try { fs.linkSync(pending, lock); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('Migration locked. Check the owner process, then use unlock --pid OWNER_PID if it has stopped.'); throw e; }
  } finally { fs.rmSync(pending, { force: true }); }
  return () => fs.rmSync(lock, { force: true });
}
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) args._.push(arg);
    else {
      const key = arg.slice(2);
      if (['apply', 'json', 'check-cli', 'with-workflow'].includes(key)) args[key] = true;
      else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`); args[key] = argv[++i]; }
    }
  }
  return args;
}
