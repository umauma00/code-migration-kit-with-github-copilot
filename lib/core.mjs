// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
const generatedMigrationState = ['migration/state', 'migration/results', 'migration/gates', 'migration/runs', 'migration/run.lock'];
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
  if (config.schemaVersion !== 1) throw new Error('Unsupported config schemaVersion');
  for (const field of ['sourceLanguage', 'targetLanguage']) {
    if (typeof config[field] !== 'string' || !config[field].trim()) throw new Error(`${field} is required`);
  }
  if (!['preserve', 'redesign'].includes(config.mode)) throw new Error('mode must be preserve or redesign');
  for (const key of ['sourceRoots', 'outputRoots', 'verificationRoots']) {
    if (!Array.isArray(config[key]) || !config[key].length) throw new Error(`${key} must be a nonempty array`);
    config[key].forEach(p => safePath(root, p));
  }
  for (const dir of config.sourceRoots) {
    if (['.git', '.github', '.claude', '.copilot', 'migration', 'migration-kit'].some(r => inside(dir, r) || inside(r, dir))) throw new Error(`Source root overlaps migration metadata: ${dir}`);
  }
  if (config.verificationInputs !== undefined && !Array.isArray(config.verificationInputs)) throw new Error('verificationInputs must be an array of file paths');
  for (const name of config.verificationInputs ?? []) {
    safePath(root, name);
    if (['.git', ...generatedMigrationState, ...config.outputRoots].some(r => inside(name, r) || inside(r, name))) throw new Error(`verificationInputs overlaps outputs or runtime state: ${name}`);
  }
  if (config.maxReviewInputBytes !== undefined && (!Number.isInteger(config.maxReviewInputBytes) || config.maxReviewInputBytes < 1024 || config.maxReviewInputBytes > 4 * 1024 * 1024)) throw new Error('maxReviewInputBytes must be between 1024 and 4194304');
  for (const out of config.outputRoots) {
    for (const reserved of ['.git', '.github', '.claude', '.copilot', 'migration', 'migration-kit', ...config.sourceRoots, ...config.verificationRoots]) {
      if (inside(out, reserved) || inside(reserved, out)) throw new Error(`Output root overlaps protected path: ${out}`);
    }
  }
  if (config.buildArtifactRoots !== undefined && !Array.isArray(config.buildArtifactRoots)) throw new Error('buildArtifactRoots must be an array of directory paths');
  for (const dir of config.buildArtifactRoots ?? []) {
    relativeName(dir);
    const protectedPaths = ['.git', '.github', '.claude', '.copilot', 'migration', 'migration-kit',
      ...config.sourceRoots, ...config.outputRoots, ...config.verificationRoots, ...(config.verificationInputs ?? [])];
    if (buildFile.test(dir.split('/')[0]) || protectedPaths.some(p => inside(dir, p) || inside(p, dir))) throw new Error(`buildArtifactRoots overlaps protected input/output or metadata: ${dir}`);
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
    if (!config.outputRoots.some(r => inside(target, r))) throw new Error(`Target outside outputRoots: ${target}`);
    if (!fs.existsSync(safePath(root, source)) || !fs.statSync(safePath(root, source)).isFile()) throw new Error(`Missing source: ${source}`);
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
export function contextHash(root, config) {
  for (const p of ['migration/RULEBOOK.md', 'migration/inventory.tsv', 'migration/manifest.tsv']) {
    if (!fileHash(safePath(root, p))) throw new Error(`Required artifact missing: ${p}`);
  }
  for (const dir of [...config.sourceRoots, ...config.verificationRoots]) {
    if (!fs.existsSync(safePath(root, dir))) throw new Error(`Input root missing: ${dir}`);
  }
  return hash(JSON.stringify({ config, configFile: fileHash(safePath(root, 'migration/config.json')), source: treeHash(root, config.sourceRoots), judge: treeHash(root, config.verificationRoots),
    manifestSources: readManifest(root, config).map(u => [u.source, fileHash(safePath(root, u.source))]),
    verificationInputs: verificationFiles(root, config).map(p => [p, fileHash(safePath(root, p))]),
    artifacts: ['migration/RULEBOOK.md', 'migration/inventory.tsv', 'migration/manifest.tsv'].map(p => fileHash(safePath(root, p))),
    runtime: treeHash(root, ['.github/copilot-instructions.md', '.github/agents', '.github/hooks', '.github/skills', '.github/extensions',
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
export function lockRun(root, task) {
  const lock = safePath(root, 'migration/run.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Migration locked. Check the owner process, then use unlock --pid OWNER_PID if it has stopped.'); throw e; }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, task, startedAt: stamp() })); fs.closeSync(fd);
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
