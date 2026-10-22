// SPDX-License-Identifier: Apache-2.0
// Copilot has no repository setting that denies shell commands, so the
// upstream settings.json deny list becomes a human-installed policy file that
// the preToolUse hook enforces for every agent session (not only workers).
// Like the upstream deny rules, this is a guardrail, not a security boundary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const guardrailsFile = 'migration/guardrails.json';
const shellTools = new Set(['bash', 'Bash', 'shell', 'powershell', 'write_bash', 'run_in_terminal', 'runInTerminal', 'terminal']);
const wrappers = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup']);

export function parseGuardrails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) throw new Error(`${guardrailsFile} must be an object with schemaVersion 1`);
  const deny = value.denyCommands ?? [];
  if (!Array.isArray(deny) || deny.some(rule => typeof rule !== 'string' || !rule.trim())) throw new Error(`${guardrailsFile}: denyCommands must be nonempty strings`);
  const waiver = value.waiver;
  if (waiver !== undefined && (typeof waiver !== 'object' || typeof waiver.note !== 'string' || !waiver.note.trim())) throw new Error(`${guardrailsFile}: waiver needs a nonempty note`);
  return { denyCommands: deny.map(rule => rule.trim().split(/\s+/)), waiver };
}

export function readGuardrails(root) {
  const file = path.join(root, guardrailsFile);
  if (!fs.existsSync(file)) return null;
  return parseGuardrails(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Upstream prompts 03/04 refuse to fan out without the human-installed denies.
export function requireGuardrails(root, phase) {
  const install = `Propose the deny list from \`run_migration.mjs guardrails show\` (or a waiver with its reason) to the human in chat. Once they agree, run \`run_migration.mjs guardrails install\` with the agreed --add/--remove/--deny or --waiver options: the host asks the person to confirm that exact command, and that confirmation is their act. Never create or edit ${guardrailsFile} any other way.`;
  let policy;
  try { policy = readGuardrails(root); }
  catch (e) { throw new Error(`Phase ${phase} guardrails are invalid: ${e.message}. ${install}`); }
  if (!policy) throw new Error(`Phase ${phase} requires human-installed command guardrails. ${install}`);
  if (!policy.denyCommands.length && !policy.waiver) throw new Error(`Phase ${phase} guardrails deny nothing and record no waiver. ${install}`);
  return policy;
}

// The upstream deny list is installed by the human. Chat-only use keeps that:
// the agent proposes, and this runner command (a host-confirmed human gate, see
// humanGate) writes the file. Comma-separated lists keep the argv free of the
// separators the hook splits commands on.
const list = value => value === undefined ? [] : String(value).split(',').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
export function guardrailsProposal(root, kitRoot, config) {
  const template = JSON.parse(fs.readFileSync(path.join(kitRoot, 'templates/guardrails.json'), 'utf8'));
  const configured = ['build', 'smoke', 'parity', 'typecheck', 'original', 'mutation'].map(name => config?.commands?.[name])
    .filter(Array.isArray).map(argv => argv.slice(0, 2).map(w => w.split(/[\\/]/).pop()).join(' '));
  let current = null, currentError;
  try { current = readGuardrails(root); } catch (e) { currentError = e.message; }
  return { file: guardrailsFile, installed: current ? { denyCommands: current.denyCommands.map(r => r.join(' ')), waiver: current.waiver ?? null } : null,
    ...(currentError ? { invalid: currentError } : {}), template: template.denyCommands,
    configuredCommands: [...new Set(configured)],
    note: 'Agree the list with the human. Runner-owned commands (config.commands) run as runner processes and are not affected by these denies; listing their command words still stops agents from running the same builds/tests by hand. A cheap per-unit typecheck that dissolves Step 4 must not be denied.' };
}
export function installGuardrails(root, kitRoot, { deny, add, remove, waiver, replace = false } = {}) {
  const file = path.join(root, guardrailsFile);
  if (fs.existsSync(file) && !replace) throw new Error(`${guardrailsFile} already exists; pass --replace to change it (still the human's confirmed act)`);
  if (waiver !== undefined && (deny !== undefined || add !== undefined || remove !== undefined)) throw new Error('Choose a deny list or a waiver, not both');
  let value;
  if (waiver !== undefined) value = { schemaVersion: 1, waiver: { note: String(waiver) } };
  else {
    const template = JSON.parse(fs.readFileSync(path.join(kitRoot, 'templates/guardrails.json'), 'utf8'));
    const base = deny !== undefined ? list(deny) : template.denyCommands;
    const removed = new Set(list(remove));
    for (const r of removed) if (!base.includes(r)) throw new Error(`Cannot remove "${r}": it is not in the deny list`);
    value = { schemaVersion: 1, denyCommands: [...new Set([...base.filter(r => !removed.has(r)), ...list(add)])] };
  }
  parseGuardrails(value);
  if (!value.waiver && !value.denyCommands.length) throw new Error('A guardrails file must deny something or record a waiver');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); fs.renameSync(temp, file);
  return { file: guardrailsFile, written: value, note: 'Installed by the human through the host confirmation of this exact command.' };
}

// Each pipeline/list segment is checked separately, split like a shell
// (shellSegments); leading VAR=value assignments, common wrappers with their
// options and executable directories are ignored. A shell's -c/-Command string
// and a quoted substitution are checked as commands of their own. Between rule
// words that are not options, the command's options are skipped (cargo --locked
// build); an option that takes a value (npm --prefix x run) is a known gap, as
// are indirect forms (xargs -I{} git push {}, a variable holding the command).
const shells = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell']);
const shellCommandOption = (name, word) => /^(?:pwsh|powershell)$/.test(name) ? /^-(?:c|command)$/i.test(word) : /^-[A-Za-z]*c[A-Za-z]*$/.test(word);
// Wrapper and git global options that take the next word as their value.
const valueOptions = { env: new Set(['-u', '--unset', '-C', '--chdir']), sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T']),
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']) };
function commandWords(words) {
  let i = 0;
  while (i < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { i++; continue; }
    const name = words[i].split(/[\\/]/).pop();
    if (!wrappers.has(name)) break;
    for (i++; i < words.length && words[i].startsWith('-'); i++) if (valueOptions[name]?.has(words[i])) i++;
  }
  return words.slice(i);
}
function ruleMatches(tokens, words) {
  if (words[0] !== tokens[0]) return false;
  let j = 1;
  for (const token of tokens.slice(1)) {
    if (!token.startsWith('-')) {
      for (; j < words.length && words[j].startsWith('-'); j++) if (tokens[0] === 'git' && valueOptions.git.has(words[j])) j++;
    }
    if (words[j++] !== token) return false;
  }
  return true;
}
export function deniedRule(command, denyCommands, depth = 0) {
  for (const { words: all } of shellSegments(command)) {
    if (depth < 3) for (const word of all) if (substitution.test(word)) { const inner = deniedRule(word, denyCommands, depth + 1); if (inner) return inner; }
    const words = commandWords(all);
    if (!words.length) continue;
    words[0] = words[0].split(/[\\/]/).pop();
    if (depth < 3 && shells.has(words[0].replace(/\.exe$/i, ''))) {
      const at = words.findIndex((w, i) => i > 0 && shellCommandOption(words[0].replace(/\.exe$/i, ''), w));
      if (at > 0 && words[at + 1] !== undefined) { const inner = deniedRule(words[at + 1], denyCommands, depth + 1); if (inner) return inner; }
    }
    const rule = denyCommands.find(tokens => ruleMatches(tokens, words));
    if (rule) return rule.join(' ');
  }
  return null;
}

function projectRoot(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'migration/config.json'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

export function guardrailDecision(event, cwd = process.cwd()) {
  const name = event.toolName ?? event.tool_name;
  if (!shellTools.has(name)) return null;
  const root = projectRoot(event.cwd ?? cwd);
  if (!root) return null;
  let policy;
  try { policy = readGuardrails(root); }
  catch (e) { return `Migration guardrails are invalid (${e.message}); shell commands are denied until the human fixes ${guardrailsFile}.`; }
  if (!policy?.denyCommands.length) return null;
  let args = event.toolArgs ?? event.tool_input ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return 'Malformed tool arguments'; } }
  const command = args?.command ?? args?.input ?? args?.cmd;
  if (typeof command !== 'string') return null;
  const rule = deniedRule(command, policy.denyCommands);
  return rule ? `"${rule}" is denied by ${guardrailsFile} during the migration. This is the design working: report it instead of routing around it; the runner or the human runs builds and tests.` : null;
}

// Interactive (parent) sessions: the human's acts stay the human's.
// - Agents never create or edit migration/guardrails.json (upstream: installing
//   the denies is the human's act; Claude Code protected its settings file).
// - Recording an approval, a phase completion, a pilot grant or a verification
//   profile switch asks the person to confirm that exact command in the host.
// Like the deny rules, this is a guardrail against accidental self-approval,
// not a security boundary.
const readOnlyWords = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'jq', 'ls', 'stat', 'wc', 'diff', 'file', 'test', '[', 'git', 'type', 'Get-Content', 'gc']);
const writeTool = /edit|write|create|patch|replace|insert|rename|delete|move|remove/i;
const mentionsGuardrails = text => /(?:^|[\\/"'\s=>])migration[\\/]+guardrails\.json/.test(text);
const destructive = new Set(['rm', 'rmdir', 'unlink', 'mv', 'shred', 'trash', 'rsync', 'Remove-Item', 'del', 'erase', 'rd', 'ri', 'Move-Item', 'move']);
// find only searches unless one of these actions deletes, runs or writes.
const findActions = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
const cwdWords = new Set(['cd', 'pushd', 'popd', 'chdir', 'Set-Location', 'Push-Location', 'Pop-Location', 'sl']);
// A command substitution left inside a quoted word ("$(...)", "`...`") runs
// before the outer command, so a read-only outer word says nothing about it.
const substitution = /\$\(|`/;
// Output redirection targets (>, >>, >|, &>, 2> ...); fd duplications such as
// 2>&1 and /dev/null write no file. An operator without a readable target
// counts as unknown.
function redirectTargets(raw) {
  const out = [];
  for (const m of raw.matchAll(/(?:\d*|&)>(?:>|\|)?(&)?\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)?/g)) {
    const target = m[2]?.replace(/^(["'])(.*)\1$/, '$2');
    if (m[1] && /^(?:\d+|-)$/.test(target ?? '')) continue;
    if (/^\/dev\/(?:null|stdout|stderr)$/.test(target ?? '')) continue;
    out.push(target ?? null);
  }
  return out;
}
// A bare name counts only in a shell that is (or may be) inside migration/.
const namesGuardrails = (w, { root, cwd, moved }) => namesPath(w, guardrailsFile)
  || (!/[\\/]/.test(w) && namesPath(w, 'guardrails.json') && (moved || !root || path.resolve(cwd ?? root) === path.join(root, 'migration')));
// The project's migration/ directory. Without a known working directory (a cd
// in the same command line), any path ending in migration counts. Words the
// hook cannot expand ($VAR) are a known gap.
function namesMigrationDir(word, { root, cwd, moved }) {
  const w = word.replace(/\\/g, '/').replace(/\/+\*?$/, '');
  if (!w || /[$`]/.test(w)) return false;
  if (moved || !root) return namesPath(w, 'migration');
  const full = path.resolve(cwd ?? root, w.replace(/^~(?=$|[\\/])/, os.homedir()));
  const dir = path.join(root, 'migration');
  if (!globChars.test(w)) return full === dir;
  if (globChars.test(path.dirname(full))) return namesPath(w, 'migration');
  return path.dirname(full) === root && namesPath(path.basename(full), 'migration');
}
function guardrailsWrite(command, where = {}, depth = 0) {
  const parts = shellSegments(command);
  if (!depth) where = { ...where, moved: parts.some(({ words }) => words.some(w => cwdWords.has(w))) };
  for (const { words, raw } of parts) {
    let head = 0;
    while (head < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[head]) || wrappers.has(words[head]))) head++;
    const rest = words.slice(head), name = rest[0]?.split(/[\\/]/).pop();
    if (!name) continue;
    if (depth < 3 && words.some(w => substitution.test(w) && guardrailsWrite(w, where, depth + 1))) return true;
    const finds = name === 'find' && rest.some(w => findActions.has(w));
    const redirected = redirectTargets(raw).some(t => t === null || namesGuardrails(t, where));
    const readOnly = (readOnlyWords.has(name) || (name === 'find' && !finds)) && !redirected && !substitution.test(raw) && !(name === 'jq' && rest.includes('-i')) && !(name === 'git' && !['diff', 'log', 'status', 'show'].includes(rest[1]));
    // The file itself, by path, glob or bare name.
    const file = mentionsGuardrails(` ${raw}`) || rest.slice(1).some(w => namesGuardrails(w, where));
    if (file && !readOnly) return true;
    // Removing or moving the whole migration directory removes the file too.
    // rsync changes only its destination unless it removes its sources.
    const touched = name === 'rsync' && !rest.includes('--remove-source-files') ? rest.slice(-1) : rest.slice(1);
    if ((destructive.has(name) || finds) && touched.some(w => namesMigrationDir(w, where))) return true;
  }
  return false;
}
function writeTargets(args) {
  const out = [];
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'target', 'destination', 'new_path', 'newPath', 'old_path', 'uri']) if (typeof args?.[key] === 'string') out.push(args[key]);
  for (const key of ['filePaths', 'paths', 'files']) if (Array.isArray(args?.[key])) for (const v of args[key]) { if (typeof v === 'string') out.push(v); else if (typeof v?.path === 'string') out.push(v.path); else if (typeof v?.filePath === 'string') out.push(v.filePath); }
  // apply_patch style inputs name their files in headers.
  for (const key of ['input', 'patch', 'diff']) if (typeof args?.[key] === 'string') {
    for (const m of args[key].matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)) out.push((m[1] ?? m[2]).trim());
  }
  return out;
}
function isGuardrailsFile(root, cwd, p) {
  const value = String(p).replace(/^file:\/\//, '');
  const full = path.resolve(cwd ?? root, value);
  return full === path.join(root, guardrailsFile) || /(?:^|[\\/])migration[\\/]+guardrails\.json$/.test(value) && path.resolve(root, value) === path.join(root, guardrailsFile);
}
// Runner subcommands that record a human decision. Every chained segment is
// checked, so a harmless first command cannot carry an approval past the host.
// Shell-like split: quotes keep their spaces (a --note "two words" value stays
// one argument) and operators outside quotes end a segment. Substitutions
// inside double quotes stay in their word; the fallback scan below sees them.
export function shellSegments(command) {
  const out = [], s = String(command);
  let words = [], word = null, quote = null, raw = '';
  const end = () => { if (word !== null) { words.push(word); word = null; } };
  const cut = () => { end(); if (words.length) out.push({ words, raw }); words = []; raw = ''; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    raw += c;
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && /[$`"\\\n]/.test(s[i + 1] ?? '')) { word += s[++i]; raw += s[i]; }
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word ??= ''; continue; }
    // Inside a word, a backslash before a path character stays: Windows paths
    // (.\gradlew, migration-kit\scripts\run_migration.mjs) keep their separators.
    if (c === '\\' && /[\w.-]/.test(s[i + 1] ?? '') && word !== null) { word += c; continue; }
    if (c === '\\' && i + 1 < s.length) { word = (word ?? '') + s[++i]; raw += s[i]; continue; }
    if (/\s/.test(c) && c !== '\n') { end(); continue; }
    if (c === '$' && s[i + 1] === '(') { raw = raw.slice(0, -1); cut(); i++; continue; }
    // >&, <& and &> are redirections, not a background operator.
    if (c === '&' && (/[<>]/.test(s[i - 1]) || s[i + 1] === '>')) { word = (word ?? '') + c; continue; }
    if (/[;&|\n`()]/.test(c)) { raw = raw.slice(0, -1); cut(); continue; }
    word = (word ?? '') + c;
  }
  cut();
  return out;
}
const globChars = /[*?[]/;
const globRegex = glob => new RegExp(`^${glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
// A path word, glob or not, that names `name` (compared on its last components).
function namesPath(word, name) {
  const parts = word.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean);
  const want = name.split('/');
  if (parts.length < want.length) return false;
  const tail = parts.slice(-want.length).join('/');
  return globChars.test(tail) ? (() => { try { return globRegex(tail).test(name); } catch { return true; } })() : tail === name;
}
const isRunnerWord = word => {
  const base = word.split(/[\\/]/).pop();
  return base === 'run_migration.mjs' || (globChars.test(base) && namesPath(base, 'run_migration.mjs'));
};
// Options the runner reads as flags; every other --option takes the next word,
// exactly as core.parseArgs does.
const runnerFlags = new Set(['--apply', '--json', '--check-cli', '--with-workflow', '--confirm-no-dependencies', '--replace']);
const runnerCommands = new Set(['approve', 'build-loop', 'diagnose', 'doctor', 'guardrails', 'guidance', 'help', 'judge-prepare', 'models', 'phase', 'pilot', 'preferences',
  'repair', 'repair-round', 'sessions', 'source-spec', 'status', 'survey', 'unlock', 'judge', 'build', 'smoke', 'parity', 'handoff', 'translate']);
// Words that can name a human act: runner subcommands and the kit functions behind them.
const gateWords = /\b(?:approve|complete|prepare|install|build-?loop|buildloop|prune|apply)/i;
const kitReference = /run_migration|(?:^|[\\/])lib[\\/](?:pipeline|guardrails|build-loop|sessions|phases|pilot|source-spec)\.mjs/;
export function humanGate(command, depth = 0) {
  for (const segment of shellSegments(command)) {
    const gate = segmentGate(segment, depth);
    if (gate) return gate;
  }
  return null;
}
function segmentGate({ words, raw }, depth) {
  let head = 0;
  while (head < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[head]) || wrappers.has(words[head]))) head++;
  // Reading the kit (cat, grep, git diff...) is never one of its acts, unless a
  // quoted substitution runs another command first.
  const name = words[head]?.split(/[\\/]/).pop();
  if (readOnlyWords.has(name) && !/>/.test(raw) && !substitution.test(raw) && (name !== 'git' || ['diff', 'log', 'status', 'show', 'grep'].includes(words[head + 1]))) return null;
  // A quoted command line (bash -c "...", "$(...)") is checked as its own command.
  if (depth < 3) for (const word of words) if (/\s/.test(word) && kitReference.test(word)) { const inner = humanGate(word, depth + 1); if (inner) return inner; }
  const at = words.findIndex(isRunnerWord);
  if (at >= 0) {
    const positional = [];
    for (let i = at + 1; i < words.length; i++) {
      if (words[i].startsWith('--')) { if (!runnerFlags.has(words[i])) i++; continue; }
      positional.push(words[i]);
    }
    const [cmd, sub] = positional;
    if (cmd === 'approve') return `approve ${sub ?? ''}`.trim();
    if (cmd === 'phase' && sub === 'complete') return `phase complete ${positional[2] ?? ''}`.trim();
    if (cmd === 'pilot' && sub === 'prepare') return 'pilot prepare';
    if (cmd === 'guardrails' && sub === 'install') return 'guardrails install';
    if (cmd === 'build-loop') return 'build-loop';
    if (cmd === 'sessions' && sub === 'prune') return 'sessions prune';
    if (cmd === 'models' && sub === 'set') return 'models set';
    if (cmd === 'source-spec' && sub === 'init' && words.includes('--apply')) return 'source-spec init --apply';
    if (runnerCommands.has(cmd)) return null;
  }
  // Best-effort fallback by text match: within one segment, the runner or a kit
  // module is reached in a form this parser cannot read (an unknown command
  // word, node -e, bash -c, a substitution) and a human-act word appears. Forms
  // split across segments, variables or indirection (R=run_migration.mjs;
  // node "$R" approve ..., xargs) are not detected.
  if (at < 0 && !kitReference.test(raw)) return null;
  return gateWords.test(raw) ? 'unrecognized runner command' : null;
}
function chosenLanguage(root) {
  try { const value = JSON.parse(fs.readFileSync(path.join(root, 'migration/preferences.json'), 'utf8')).userLanguage; return ['ja', 'en'].includes(value) ? value : null; } catch { return null; }
}
const language = root => chosenLanguage(root) ?? 'en';
// Copilot CLI ask_user, VS Code askQuestions. Long sessions drift back to
// English after compaction or English tool output, so the hook holds questions
// to the recorded report language, and asks for that language first.
const questionTool = /^(?:ask_user|ask_questions|(?:vscode[/_])?askQuestions)$/i;
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const japanese = /[\u3040-\u30ff\u3400-\u9fff]/;
// Text shown as is: `code`, URLs, paths and file names. A Japanese file name
// does not make an English sentence Japanese.
const verbatim = /`[^`]*`|https?:\/\/\S+|\S*[\/\\]\S*|\S+\.[A-Za-z0-9]{1,8}(?![\w.])/g;
const prose = text => text.replace(verbatim, ' ');
// Each question is judged on its own text, never on a header or a neighbour:
// ask_user {question, choices}, VS Code askQuestions {questions: [{header,
// question, options: [{label, description}]}]}. A question needs Japanese
// prose; a choice or description of two or more English words needs it too,
// while one word (Java, Go) or a `quoted` name passes. A character-class test,
// not language detection.
function englishOnly(text, words) {
  const rest = prose(text);
  return !japanese.test(rest) && (rest.match(/[A-Za-z]{2,}/g) ?? []).length >= words;
}
function questionItems(args) {
  const items = Array.isArray(args?.questions) ? args.questions : [args];
  return items.map(item => typeof item === 'string' ? { question: item, choices: [] } : {
    question: [item?.question, item?.prompt, item?.message, item?.title].find(v => typeof v === 'string') ?? '',
    choices: [...(Array.isArray(item?.choices) ? item.choices : []), ...(Array.isArray(item?.options) ? item.options : [])]
      .flatMap(c => typeof c === 'string' ? [c] : [c?.label, c?.description].filter(v => typeof v === 'string')) });
}
function questionDecision(root, args) {
  const chosen = chosenLanguage(root);
  if (!chosen) {
    const text = strings(args).join('\n');
    return text.includes('日本語') && /english/i.test(text) ? null : { decision: 'deny', reason:
      'Ask the report language first: 日本語 (ja) or English (en). Then record it with `run_migration.mjs preferences --language ja|en`. / 最初に報告言語（日本語 / English）を質問し、`preferences --language ja|en` で記録してください。' };
  }
  if (chosen !== 'ja') return null;
  const english = questionItems(args).flatMap(({ question, choices }) => [
    ...(japanese.test(prose(question)) ? [] : [question]), ...choices.filter(c => englishOnly(c, 2))]);
  return english.length ? { decision: 'deny', reason:
    `報告言語は日本語です（migration/preferences.json）。次を日本語で書き直して、もう一度質問してください: ${english.map(t => `「${t.slice(0, 80)}」`).join('、')}。見出しではなく、質問文と選択肢そのものを日本語にします。コマンド名・パス・製品名などそのまま見せる語は \`バッククォート\` で囲んでください。` } : null;
}
// Returns null, or { decision: 'deny' | 'ask', reason }.
export function interactiveDecision(event, cwd = process.cwd()) {
  const name = event.toolName ?? event.tool_name;
  const root = projectRoot(event.cwd ?? cwd);
  if (!root || !name) return null;
  let args = event.toolArgs ?? event.tool_input ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return shellTools.has(name) ? { decision: 'deny', reason: 'Malformed tool arguments' } : null; } }
  if (questionTool.test(name)) return questionDecision(root, args);
  const ja = language(root) === 'ja';
  const guardReason = ja
    ? `${guardrailsFile} の設置・変更は人間の判断です。ファイルを直接書かず、禁止リスト（または免除理由）をチャットで提案し、合意後に \`run_migration.mjs guardrails install\` を実行してください（ホストが利用者に確認を求めます）。`
    : `${guardrailsFile} is the human's decision. Do not write it directly: propose the deny list (or a waiver) in chat and, after agreement, run \`run_migration.mjs guardrails install\` (the host asks the person to confirm).`;
  if (!shellTools.has(name)) {
    // Only the files a write tool targets matter, not text that mentions the file.
    if (writeTool.test(name) && writeTargets(args).some(p => isGuardrailsFile(root, event.cwd ?? cwd, p))) return { decision: 'deny', reason: guardReason };
    return null;
  }
  const command = args?.command ?? args?.input ?? args?.cmd;
  if (typeof command !== 'string') return null;
  if (guardrailsWrite(command, { root, cwd: event.cwd ?? cwd })) return { decision: 'deny', reason: guardReason };
  const denied = guardrailDecision(event, cwd);
  if (denied) return { decision: 'deny', reason: denied };
  const gate = humanGate(command);
  if (gate === 'guardrails install') return { decision: 'ask', reason: ja
    ? `「${gate}」はコマンド制限（${guardrailsFile}）の設置で、人間の判断です。チャットで合意した禁止リスト（または免除理由）と一致する場合だけ許可してください。`
    : `"${gate}" installs the command guardrails (${guardrailsFile}), which is the human's decision. Allow it only if it matches the deny list (or waiver) you agreed in chat.` };
  if (gate === 'unrecognized runner command') return { decision: 'ask', reason: ja
    ? 'このコマンドはキットのrunnerやモジュールを、確認対象（承認・完了・設置・削除など）の語を含む読み取れない形で呼び出しています。チャットで合意した操作と一致する場合だけ許可してください。'
    : 'This command reaches the kit runner or its modules in a form the hook cannot read, and it contains a word for a human act (approve, complete, install, prune...). Allow it only if it matches what you agreed in chat.' };
  if (gate === 'build-loop') return { decision: 'ask', reason: ja
    ? `「${gate}」は、指定回数（--max-rounds、既定5）までbuildの承認・実行を、AI呼び出しの合計（--max-calls、既定はmaxAgentCalls）までレビュー付きの修正を繰り返す一括の許可で、人間の判断です。buildはAIが書いたコードを実行し、この許可はまだ書かれていない修正のbuild承認も含みます（入力量の上限maxRunInputBytesでも止まります）。チャットで合意した回数・呼び出し数・内容の場合だけ許可してください。`
    : `"${gate}" grants repeated build approvals up to the round limit (--max-rounds, default 5) and reviewed repairs up to a total AI call budget (--max-calls, default maxAgentCalls), which is the human's decision. Builds run model-written code, and the grant covers builds of repairs not yet written (the input budget maxRunInputBytes also stops the loop). Allow it only if it matches the rounds, calls and note you agreed in chat.` };
  if (gate === 'sessions prune') return { decision: 'ask', reason: ja
    ? `「${gate}」はこのキットのワーカーが残したCopilot CLIのセッション記録を削除します（元に戻せません）。チャットで同意した場合だけ許可してください。`
    : `"${gate}" deletes the Copilot CLI session transcripts left by this kit's workers (not undoable). Allow it only if you agreed in chat.` };
  if (gate === 'models set') return { decision: 'ask', reason: ja
    ? `「${gate}」はワーカーのモデルとエフォートを変更します。選ぶのは利用者です。チャットであなたが選んだ担当・モデル・エフォートと一致する場合だけ許可してください（レビュー済みの単位は次の実行で再レビューされます）。`
    : `"${gate}" changes the workers' model and reasoning effort, which is the person's choice. Allow it only if the roles, model and effort match what you chose in chat (units reviewed under the old choice are reviewed again on the next run).` };
  if (gate) return { decision: 'ask', reason: ja
    ? `「${gate}」は承認・完了の記録で、人間の判断です。対象の成果物をあなたが確認済みの場合だけ許可してください。`
    : `"${gate}" records an approval or completion, which is the human's decision. Allow it only if you reviewed the artifacts it names.` };
  return null;
}

// Copilot CLI loads repository hooks (.github/hooks) only in trusted folders;
// plugin hooks load regardless. A trusted ancestor also trusts the project.
export function cliFolderTrust(root, home = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot')) {
  const file = path.join(home, 'config.json');
  let folders;
  try {
    const text = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');
    folders = JSON.parse(text).trustedFolders ?? [];
    if (!Array.isArray(folders)) return 'unknown';
  } catch { return 'unknown'; }
  const project = fs.realpathSync(root);
  const real = folder => { try { return fs.realpathSync(folder); } catch { return path.resolve(folder); } };
  return folders.some(folder => typeof folder === 'string' && (project === real(folder) || project.startsWith(`${real(folder)}${path.sep}`))) ? 'trusted' : 'untrusted';
}
