// SPDX-License-Identifier: Apache-2.0
// Copilot has no repository setting that denies shell commands, so the
// upstream settings.json deny list becomes a human-installed policy file that
// the preToolUse hook enforces for every agent session (not only workers).
// Like the upstream deny rules, this is a guardrail, not a security boundary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameRetry } from './text.mjs';
import { runnerFlags, specs } from './cli.mjs';

export const guardrailsFile = 'migration/guardrails.json';
// write_bash / write_powershell type into a running shell (write_powershell is
// Copilot CLI's tool on Windows). Their input is keystrokes, so the lines they
// run are replayed: {enter}, a raw CR or LF runs the line and fixes it, and
// {left}/{right}/{backspace} edit the current one. Anything whose result this
// check cannot see is unknown: {up}/{down} (history or a menu), other control
// characters (Tab completes, Ctrl-U clears, raw escape sequences), an edit reaching text typed before
// this call, and text left unrun for a later call's {enter}.
const shellTools = new Set(['bash', 'Bash', 'shell', 'powershell', 'write_bash', 'write_powershell', 'run_in_terminal', 'runInTerminal', 'terminal']);
function typedLines(input) {
  const lines = [];
  let line = '', at = 0, unknown = null;
  // Keys are lowercase only, as the CLI reads them; anything else is typed text.
  for (const [text, key] of input.matchAll(/\{(enter|up|down|left|right|backspace)\}|\r\n?|\n|[\x00-\x09\x0b-\x1f\x7f]|[^{\x00-\x1f\x7f]+|\{/g)) {
    if (key === 'enter' || /^[\r\n]/.test(text)) { lines.push(line); line = ''; at = 0; }
    else if (key === 'up' || key === 'down') unknown ??= `{${key}} recalls a line this check cannot see`;
    else if (key === 'left') { if (at) at--; else unknown ??= '{left} reaches text typed before this call'; }
    else if (key === 'right') at = Math.min(line.length, at + 1);
    else if (key === 'backspace') { if (at) { line = line.slice(0, at - 1) + line.slice(at); at--; } else unknown ??= '{backspace} reaches text typed before this call'; }
    else if (/^[\x00-\x09\x0b-\x1f\x7f]$/.test(text)) unknown ??= `control character U+${text.charCodeAt(0).toString(16).padStart(4, '0')} edits the line in a way this check cannot replay`;
    else { line = line.slice(0, at) + text + line.slice(at); at += text.length; }
  }
  if (line) unknown ??= 'text left on the line runs with a later {enter}';
  return { command: [...lines, line].join('\n'), unknown };
}
const shellInput = (name, args) => {
  const command = args?.command ?? args?.input ?? args?.cmd;
  return typeof command === 'string' && /^write_/.test(name) ? typedLines(command) : { command, unknown: null };
};
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
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); renameRetry(temp, file);
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
  if (words[0] !== tokens[0].toLowerCase()) return false;
  let j = 1;
  for (const token of tokens.slice(1)) {
    if (!token.startsWith('-')) {
      for (; j < words.length && words[j].startsWith('-'); j++) if (tokens[0] === 'git' && valueOptions.git.has(words[j])) j++;
    }
    if (words[j++] !== token) return false;
  }
  return true;
}
// Windows names a command with its extension (npm.cmd, git.exe, gradlew.bat)
// and starts Python 3 through the py launcher (py -3 -m pytest).
// Start-Process parameters by full name, plus aliases; PowerShell also accepts
// any unambiguous prefix (-File, -Arg). Unknown names are read as switches.
const startProcessValues = ['filepath', 'argumentlist', 'credential', 'workingdirectory', 'redirectstandarderror', 'redirectstandardinput',
  'redirectstandardoutput', 'verb', 'windowstyle', 'environment', 'erroraction', 'warningaction', 'informationaction', 'progressaction',
  'errorvariable', 'warningvariable', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable'];
const startProcessSwitches = new Set(['loaduserprofile', 'nonewwindow', 'passthru', 'wait', 'usenewenvironment', 'verbose', 'debug', 'whatif', 'confirm']);
const startProcessAliases = { pspath: 'filepath', path: 'filepath', args: 'argumentlist', rse: 'redirectstandarderror', rsi: 'redirectstandardinput',
  rso: 'redirectstandardoutput', lup: 'loaduserprofile', nnw: 'nonewwindow', ea: 'erroraction', wa: 'warningaction', infa: 'informationaction',
  proga: 'progressaction', ev: 'errorvariable', wv: 'warningvariable', iv: 'informationvariable', ov: 'outvariable', ob: 'outbuffer',
  pv: 'pipelinevariable', vb: 'verbose', db: 'debug', wi: 'whatif', cf: 'confirm' };
function startProcessParameter(word) {
  const lower = word.toLowerCase();
  if (startProcessAliases[lower]) return startProcessAliases[lower];
  const names = [...startProcessValues, ...startProcessSwitches];
  if (names.includes(lower)) return lower;
  const matches = names.filter(name => name.startsWith(lower));
  return matches.length === 1 ? matches[0] : null;
}
// Windows command names are case-insensitive (GIT push, Remove-Item), so the
// command word is compared in lower case; arguments keep their case.
const commandName = word => word.split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
function windowsForms(words) {
  if (words[0] === 'py') {
    let i = 1;
    while (/^-(?:[23](?:\.\d+)?(?:-(?:32|64))?|V:\S+)$/i.test(words[i] ?? '')) i++;
    return ['python', ...words.slice(i)];
  }
  // Start-Process git -ArgumentList push (or saps / start): the started command with its arguments.
  if (/^(?:start-process|saps|start)$/i.test(words[0])) {
    let file = null; const args = [];
    const split = value => String(value ?? '').split(/[,\s]+/).filter(Boolean);
    for (let i = 1; i < words.length; i++) {
      const option = /^-([a-z]+)(?::(.*))?$/is.exec(words[i]);
      if (!option) { if (file === null) file = words[i]; else args.push(...split(words[i])); continue; }
      const name = startProcessParameter(option[1]);
      // -Wait, -NoNewWindow, -PassThru and the like take no value; -Name:value carries its own.
      const value = option[2] !== undefined ? option[2] : name && !startProcessSwitches.has(name) ? words[++i] : undefined;
      if (name === 'filepath') file = value;
      else if (name === 'argumentlist') args.push(...split(value));
    }
    return file ? [commandName(file), ...args] : words;
  }
  return words;
}
export function deniedRule(command, denyCommands, depth = 0) {
  for (const { words: all } of shellSegments(command)) {
    if (depth < 3) for (const word of all) if (substitution.test(word)) { const inner = deniedRule(word, denyCommands, depth + 1); if (inner) return inner; }
    let words = commandWords(all);
    if (!words.length) continue;
    words[0] = commandName(words[0]);
    words = windowsForms(words);
    if (depth < 3 && shells.has(words[0])) {
      const at = words.findIndex((w, i) => i > 0 && shellCommandOption(words[0], w));
      if (at > 0 && words[at + 1] !== undefined) { const inner = deniedRule(words[at + 1], denyCommands, depth + 1); if (inner) return inner; }
    }
    // cmd /c git push, cmd.exe /d /s /c "npm test": the rest of the line is the command.
    if (depth < 3 && words[0].toLowerCase() === 'cmd') {
      const at = words.findIndex((w, i) => i > 0 && /^\/[ck]$/i.test(w));
      if (at > 0 && words.length > at + 1) { const inner = deniedRule(words.slice(at + 1).map(w => /\s/.test(w) && at + 2 < words.length ? `"${w}"` : w).join(' '), denyCommands, depth + 1); if (inner) return inner; }
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
  const { command, unknown } = shellInput(name, args);
  if (typeof command !== 'string') return null;
  const rule = deniedRule(command, policy.denyCommands);
  if (rule) return `"${rule}" is denied by ${guardrailsFile} during the migration. This is the design working: report it instead of routing around it; the runner or the human runs builds and tests.`;
  // A guarded command cannot be ruled out in keystrokes this check cannot replay.
  return unknown ? `Keystrokes sent with ${name} cannot be checked against ${guardrailsFile}: ${unknown}. Send each complete command line ending in {enter} instead, or run the command with the shell tool.` : null;
}

// Interactive (parent) sessions: the human's acts stay the human's.
// - Agents never create or edit migration/guardrails.json (upstream: installing
//   the denies is the human's act; Claude Code protected its settings file).
// - Recording an approval, a phase completion, a pilot grant or a verification
//   profile switch asks the person to confirm that exact command in the host.
// Like the deny rules, this is a guardrail against accidental self-approval,
// not a security boundary.
const readOnlyWords = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'jq', 'ls', 'stat', 'wc', 'diff', 'file', 'test', '[', 'git', 'type', 'Get-Content', 'gc']);
// PowerShell and cmd.exe commands that only read or format. PowerShell names
// are case-insensitive, so they are compared in lower case (Get-Content,
// get-content, GC). A redirection or substitution in the segment still counts
// as a write.
const windowsReadOnly = new Set(['get-content', 'gc', 'type', 'test-path', 'get-item', 'gi', 'get-childitem', 'gci', 'dir', 'get-itemproperty', 'gp', 'resolve-path', 'rvpa',
  'select-string', 'sls', 'findstr', 'get-filehash', 'measure-object', 'measure', 'select-object', 'select', 'where-object', 'where', '?', 'sort-object',
  'format-table', 'ft', 'format-list', 'fl', 'out-string', 'convertfrom-json', 'convertto-json', 'write-output', 'write', 'echo', 'write-host', 'get-location', 'pwd', 'tree']);
// A pipe may feed the files a reader lists to a command that changes them
// (Get-ChildItem migration/* | Remove-Item; Set-Content takes -Path from the
// pipeline too). So a reader stays a read only when every command it pipes into
// is a reader, or writes only to a target named in its own segment, which is
// checked on its own. A script block ({ ... }) can run anything, so it voids the
// exemption.
const namedTargetWriters = new Set(['out-file', 'tee-object', 'export-csv', 'export-clixml', 'out-null', 'out-host']);
const windowsName = word => word.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|com)$/, '');
// A method call on a reader's result ((Get-Item f).Delete()) or a static
// .NET call ([IO.File]::Delete) changes files too.
const methodCall = /\)\s*\.\s*\w+\s*\(|::/;
function pipesOnlyToReaders(command) {
  if (/[{}]/.test(command) || methodCall.test(command)) return false;
  return [...command.matchAll(/(?<!\|)\|(?!\|)\s*([^\s|;&()]+)/g)].every(([, word]) => {
    const name = windowsName(word);
    return windowsReadOnly.has(name) || namedTargetWriters.has(name) || readOnlyWords.has(word);
  });
}
const readsOnly = (name, command) => readOnlyWords.has(name) || (windowsReadOnly.has(windowsName(name)) && pipesOnlyToReaders(command));
const writeTool = /edit|write|create|patch|replace|insert|rename|delete|move|remove/i;
const mentionsGuardrails = text => /(?:^|[\\/"'\s=>:])migration[\\/]+guardrails\.json/.test(text);
// Compared through windowsName (lower case, no .exe), like the readers.
const destructive = new Set(['rm', 'rmdir', 'unlink', 'mv', 'shred', 'trash', 'rsync', 'remove-item', 'del', 'erase', 'rd', 'ri', 'move-item', 'mi', 'move',
  'rename-item', 'rni', 'ren', 'rename']);
// Commands that take the files to change from the pipeline
// (Get-ChildItem migration | Remove-Item, ls migration | xargs rm).
const pipelineChangers = new Set([...destructive, 'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc', 'copy-item', 'cpi', 'copy', 'cp', 'xargs']);
const pipesIntoChanger = command => [...command.matchAll(/(?<!\|)\|(?!\|)\s*([^\s|;&()]+)/g)].some(([, word]) => pipelineChangers.has(windowsName(word)));
// find only searches unless one of these actions deletes, runs or writes.
const findActions = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
const cwdWords = new Set(['cd', 'pushd', 'popd', 'chdir', 'set-location', 'push-location', 'pop-location', 'sl']);
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
// Returns the word that makes the command a write to the guardrails file, or null.
function guardrailsWrite(command, where = {}, depth = 0) {
  const parts = shellSegments(command);
  if (!depth) where = { ...where, moved: parts.some(({ words }) => words.some(w => cwdWords.has(windowsName(w)))) };
  for (const { words, raw } of parts) {
    let head = 0;
    while (head < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[head]) || wrappers.has(words[head]))) head++;
    // -Path:value is the same argument as -Path value.
    const rest = words.slice(head).map(w => w.replace(/^-[A-Za-z]+:(?=.)/, '')), name = rest[0]?.split(/[\\/]/).pop();
    if (!name) continue;
    if (depth < 3) for (const w of words) { const inner = substitution.test(w) ? guardrailsWrite(w, where, depth + 1) : null; if (inner) return inner; }
    const finds = name === 'find' && rest.some(w => findActions.has(w));
    const redirect = redirectTargets(raw).find(t => t === null || namesGuardrails(t, where)), redirected = redirect !== undefined;
    const readOnly = (readsOnly(name, command) || (name === 'find' && !finds)) && !redirected && !substitution.test(raw) && !(name === 'jq' && rest.includes('-i')) && !(name === 'git' && !['diff', 'log', 'status', 'show'].includes(rest[1]));
    // The file itself, by path, glob or bare name.
    const file = rest.slice(1).find(w => namesGuardrails(w, where)) ?? (redirect ? `> ${redirect}` : mentionsGuardrails(` ${raw}`) ? guardrailsFile : null);
    if (file && !readOnly) return file;
    // Removing or moving the whole migration directory removes the file too.
    // rsync changes only its destination unless it removes its sources.
    const touched = windowsName(name) === 'rsync' && !rest.includes('--remove-source-files') ? rest.slice(-1) : rest.slice(1);
    const dir = (destructive.has(windowsName(name)) || finds) ? touched.find(w => namesMigrationDir(w, where)) : undefined;
    if (dir) return `${name} ${dir}`;
    // A listing of migration/ (or of the file by bare name) piped into a
    // command that changes what it receives.
    const listed = pipesIntoChanger(command) && rest.slice(1).find(w => namesMigrationDir(w, where) || namesGuardrails(w, where) || /(?:^|[\\/])guardrails\.json$/.test(w));
    if (listed) return `${name} ${listed} |`;
  }
  return null;
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
// Options the runner reads as flags come from its spec; every other --option
// takes the next word, exactly as cli.parseCommandLine does.
const runnerCommands = new Set(Object.keys(specs.run_migration.commands));
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
    let help = false;
    for (let i = at + 1; i < words.length; i++) {
      // A value option takes the next word first, as the runner does, so
      // `--note -h` is a note, not a help request.
      if (words[i] === '-h' || words[i] === '--help') { help = true; continue; }
      if (words[i].startsWith('--')) { if (!runnerFlags.has(words[i])) i++; continue; }
      positional.push(words[i]);
    }
    // With --help or -h the runner prints its usage and does nothing else.
    // Other segments of a compound command are still checked on their own.
    // The words here are not exactly the runner's argv: a comment (# --help),
    // a redirection target (> --help), a substitution or a line continuation
    // would put a help flag here that the runner never receives. Only a plain
    // segment, free of those, is exempt; anything else keeps its gate.
    if (help && !/[#<>$`]|\\\r?\n/.test(raw)) return null;
    const [cmd, sub] = positional;
    // approve translation --complete-phase 03 records both acts under one confirmation.
    if (cmd === 'approve') return `approve ${sub ?? ''}${words.includes('--complete-phase') ? ' + phase complete' : ''}`.trim();
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
const japanese = /[\u3040-\u30ff\u3400-\u9fff]/, hiragana = /[\u3040-\u309f]/;
// Japanese sentences carry hiragana (particles, verb endings); file names
// rarely do. Hiragana outside `code` and URLs is Japanese prose, however a
// path is attached to it (src/a.pyを, Java/Goの). Without hiragana, a
// whitespace-separated path or file name is set aside, so 売上集計.java does
// not make an English sentence Japanese, and English words are counted.
const unquoted = text => text.replace(/`[^`]*`|https?:\/\/\S+/g, ' ');
const pathToken = /(?:^|\s)\S*(?:[\/\\]|\.[A-Za-z0-9]{1,8}(?![\w.]))\S*/g;
// An ASCII identifier carrying a digit (gpt-5-mini, claude-sonnet-4, o3) is a
// name shown as is, not English words. Only its ASCII run is set aside, so
// adjacent Japanese stays (候補1), and read-only still counts as English.
const nameToken = /[A-Za-z0-9._-]*\d[A-Za-z0-9._-]*/g;
function prose(text) {
  const rest = unquoted(text);
  if (hiragana.test(rest)) return { japanese: true, words: 0 };
  const bare = rest.replace(pathToken, ' ').replace(nameToken, ' ');
  return { japanese: japanese.test(bare), words: (bare.match(/[A-Za-z]{2,}/g) ?? []).length };
}
// Each question is judged on its own text, never on a header or a neighbour:
// ask_user {question, choices}, VS Code askQuestions {questions: [{header,
// question, options: [{label, description}]}]}. A question needs Japanese
// prose with at most one English word beside kanji/katakana alone; a choice or
// description of two or more English words needs it too, while one word (Java,
// Go) or a `quoted` name passes. A character-class test, not language detection.
const englishQuestion = text => { const p = prose(text); return !p.japanese || p.words > 1; };
const englishChoice = text => { const p = prose(text); return !p.japanese && p.words > 1; };
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
    ...(englishQuestion(question) ? [question] : []), ...choices.filter(englishChoice)]);
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
  const { command } = shellInput(name, args);
  if (typeof command !== 'string') return null;
  const hit = guardrailsWrite(command, { root, cwd: event.cwd ?? cwd });
  // Name the word that matched: a pattern such as migration/* or a bare * after
  // cd also names the file, and the agent needs to see what to take out.
  if (hit) return { decision: 'deny', reason: `${guardReason}${ja
    ? ` 該当した語: \`${hit}\`。変更するつもりがない場合は、その語を含まない形に直すか、別のコマンドに分けて実行してください。`
    : ` Matched: \`${hit}\`. If you did not mean to change the file, rewrite the command without that word or run that part as a separate command.`}` };
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
    ? `「${gate}」は、指定回数（--max-rounds、既定5）までbuild（--through smoke|parityならsmoke・parityも）の承認・実行を、AI呼び出しの合計（--max-calls、既定はmaxAgentCalls）までレビュー付きの修正を繰り返す一括の許可で、人間の判断です。buildやテストはAIが書いたコードを実行し、この許可はまだ書かれていない修正の承認も含みます（入力量の上限maxRunInputBytesでも止まります）。チャットで合意した範囲・回数・呼び出し数・内容の場合だけ許可してください。`
    : `"${gate}" grants repeated build approvals (with --through smoke|parity, smoke and parity approvals too) up to the round limit (--max-rounds, default 5) and reviewed repairs up to a total AI call budget (--max-calls, default maxAgentCalls), which is the human's decision. Builds and tests run model-written code, and the grant covers repairs not yet written (the input budget maxRunInputBytes also stops the loop). Allow it only if it matches the stages, rounds, calls and note you agreed in chat.` };
  if (gate === 'sessions prune') return { decision: 'ask', reason: ja
    ? `「${gate}」はこのキットのワーカーが残したCopilot CLIのセッション記録を削除します（元に戻せません）。チャットで同意した場合だけ許可してください。`
    : `"${gate}" deletes the Copilot CLI session transcripts left by this kit's workers (not undoable). Allow it only if you agreed in chat.` };
  if (gate === 'models set') return { decision: 'ask', reason: ja
    ? `「${gate}」はワーカーのモデルとエフォートを変更します。選ぶのは利用者です。チャットであなたが選んだ担当・モデル・エフォートと一致する場合だけ許可してください（レビュー済みの単位は次の実行で再レビューされます）。`
    : `"${gate}" changes the workers' model and reasoning effort, which is the person's choice. Allow it only if the roles, model and effort match what you chose in chat (units reviewed under the old choice are reviewed again on the next run).` };
  if (gate === 'approve translation + phase complete') return { decision: 'ask', reason: ja
    ? '工程03（事前試行）の完了と本番の変換開始を、まとめて記録します。人間の判断です。03の報告（ルール修正案・遵守の指摘・pilot結果）を確認し、変換を始めてよい場合だけ許可してください。'
    : 'This records phase 03 (stress test) as reviewed and approves production translation in one step, which is the human\'s decision. Allow it only if you reviewed the 03 report (amendments, adherence findings, pilot results) and want translation to start.' };
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
  // Windows paths are case-insensitive, and the CLI may store the folder with
  // another drive-letter case than Node reports (c:\work from a VS Code terminal).
  const fold = p => process.platform === 'win32' ? p.toLowerCase() : p;
  const project = fold(fs.realpathSync(root));
  const real = folder => { try { return fold(fs.realpathSync(folder)); } catch { return fold(path.resolve(folder)); } };
  const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`);
  return folders.some(folder => typeof folder === 'string' && under(project, real(folder))) ? 'trusted' : 'untrusted';
}
