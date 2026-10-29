// SPDX-License-Identifier: Apache-2.0
// Translation policies the source cannot decide (what replaces Web Forms,
// LINQ to SQL, Session, local time...). Found mechanically from the source so
// they are asked once at setup, before any survey, instead of surfacing as
// thousands of UNKNOWN inventory rows. Answers go into one managed RULEBOOK
// block; rulebook-coverage then shows, without a model, which census
// constructs still have no rule.
import fs from 'node:fs';
import { safePath, filesUnder, atomicWrite, readGeneratedFiles, lockRun, pathMemo, stamp } from './core.mjs';
import { readReviewSource } from './review.mjs';
import { censusSites } from './survey.mjs';

const conservativeNote = 'most conservative option: closest to the original structure, no new framework or dependency';
// Suggestions only; the person may name anything. Keyed by targetLanguage.
const suggestions = {
  'web-ui': { 'C#': ['ASP.NET Core Razor Pages', 'ASP.NET Core MVC', 'Blazor'], Java: ['Spring MVC with Thymeleaf', 'Jakarta Faces'],
    TypeScript: ['Express with server templates', 'Next.js'], JavaScript: ['Express with server templates', 'Next.js'], Python: ['Django', 'Flask'] },
  'data-access': { 'C#': ['EF Core (scaffold from the database)', 'Dapper', 'ADO.NET (System.Data)'], Java: ['Spring Data JPA', 'JDBC'],
    TypeScript: ['Prisma', 'Knex', 'node-postgres / mysql2'], JavaScript: ['Prisma', 'Knex', 'node-postgres / mysql2'], Python: ['SQLAlchemy', 'Django ORM', 'DB-API'] },
  'session-state': { '*': ['Server-side session of the target framework', 'Stateless: hidden fields / query string'] },
  'date-time': { '*': ['Keep local server time as the source does', 'Store UTC, convert at input/output'] },
  configuration: { 'C#': ['appsettings.json', 'Environment variables'], '*': ['One configuration file', 'Environment variables'] },
  services: { 'C#': ['ASP.NET Core Web API (REST)', 'gRPC', 'CoreWCF (same SOAP contract)'], '*': ['REST', 'gRPC', 'Keep SOAP'] },
  'desktop-ui': { 'C#': ['WinForms on .NET 8', 'WPF', 'Web UI'], '*': ['Keep a desktop UI', 'Web UI'] },
  'text-encoding': { '*': ['UTF-8 everywhere (convert data at the edges)', 'Keep the original encoding for text I/O'] },
};
export const policyTopics = [
  { id: 'web-ui', constructs: ['external-framework', 'web-forms', 'web-ui', 'ui-framework', 'view', 'page'],
    paths: /\.(?:aspx|ascx|master|jsp|jspx|xhtml|cshtml|vbhtml)$/i, content: /System\.Web\.UI\b|<%@\s*(?:Page|Control|Master)\b|javax\.faces\b|org\.apache\.struts\b|javax\.servlet\b/,
    question: 'What should the web pages and controls become in the target?',
    conservative: 'Keep one target page/component per source page with the same structure and names; reach framework APIs through a thin adapter marked TODO(port).' },
  { id: 'data-access', constructs: ['data-query', 'data-access', 'orm', 'database', 'sql', 'query'],
    paths: /\.(?:dbml|edmx)$|\.hbm\.xml$/i, content: /System\.Data\.Linq\b|System\.Data\.Entity\b|\bSqlConnection\b|\bOleDbConnection\b|\bOracleConnection\b|java\.sql\.|org\.hibernate\b|javax\.persistence\b|\bmysqli?_\w+\(|\bnew PDO\b|\bsqlalchemy\b|django\.db\b/,
    question: 'What should the data access use in the target?',
    conservative: "Keep the same SQL, query shapes and transaction boundaries through the target's built-in database API (no new ORM); TODO(port) where a dialect or mapping is unclear." },
  { id: 'session-state', constructs: ['web-state', 'session', 'state', 'viewstate', 'view-state'],
    content: /\bSession\s*\[|\bViewState\s*\[|\bHttpSessionState\b|\bHttpSession\b|\$_SESSION\b|request\.session\b|\bgetSession\(/,
    question: 'How should per-user web state (Session, ViewState) be kept in the target?',
    conservative: "Keep the same keys and lifetimes in the target framework's server-side session; keep a ViewState value as a hidden field only where the page reads it back, TODO(port)." },
  { id: 'date-time', constructs: ['datetime', 'date-time', 'time', 'timezone', 'date'],
    content: /\bDateTime\.(?:Now|Today)\b|\bnew Date\(\)|java\.util\.(?:Date|Calendar)\b|\bLocalDateTime\.now\(|\bdatetime\.(?:now|today)\(|\bdate\(\s*['"]|\bstrftime\(/,
    question: 'Which clock and time zone should date/time values use in the target?',
    conservative: 'Keep local server time exactly as the source uses it (same time zone, formatting and rounding); do not convert to UTC.' },
  { id: 'configuration', constructs: ['configuration', 'config', 'settings'],
    paths: /(?:^|\/)(?:web|app)\.config$|\.properties$|\.ini$/i, content: /\bConfigurationManager\b|\bWebConfigurationManager\b|System\.Configuration\b|\bparse_ini_file\(|\bProperties\(\)\.load\b/,
    question: 'Where should configuration live in the target?',
    conservative: 'Keep the same keys and values in one target configuration file read at the same points; keep secrets out of source with TODO(port).' },
  { id: 'services', constructs: ['service', 'web-service', 'remote-call', 'rpc', 'soap'],
    paths: /\.(?:asmx|svc|wsdl)$/i, content: /System\.ServiceModel\b|\[WebMethod\b|javax\.jws\b|javax\.xml\.ws\b|\bSoapClient\b/,
    question: 'What should the web services become in the target?',
    conservative: "Keep the same operations, message shapes and endpoints with the target's nearest built-in mechanism; TODO(port) where none exists." },
  { id: 'desktop-ui', constructs: ['desktop-ui', 'ui-framework', 'forms', 'window'],
    content: /System\.Windows\.Forms\b|\bjavax\.swing\b|\bjava\.awt\b|\bimport tkinter\b/,
    question: 'What should the desktop windows and forms become in the target?',
    conservative: 'Keep one target window/form per source form with the same controls and events through a thin adapter marked TODO(port).' },
];

function suggestionsFor(id, target) {
  const table = suggestions[id] ?? {};
  return table[target] ?? table['*'] ?? [];
}
function examplesOf(list) { return list.slice(0, 3); }

// policy-questions: read-only; one question per topic the source uses, plus
// one per kind of generated-file input (regenerate or translate).
export function policyQuestions(root, config) {
  const memo = pathMemo();
  const files = [...new Set(config.sourceRoots.flatMap(dir => filesUnder(root, dir, memo)))].sort();
  const hits = new Map(policyTopics.map(t => [t.id, []])), legacy = new Map();
  for (const file of files) {
    let text = null, encoding = 'utf-8';
    try { ({ content: text, encoding } = readReviewSource(root, file)); } catch { continue; }
    if (encoding !== 'utf-8') { if (!legacy.has(encoding)) legacy.set(encoding, []); legacy.get(encoding).push(file); }
    for (const topic of policyTopics) if (topic.paths?.test(file) || topic.content?.test(text)) hits.get(topic.id).push(file);
  }
  const target = config.targetLanguage;
  const questions = policyTopics.filter(t => hits.get(t.id).length).map(t => ({ topic: t.id, constructs: t.constructs, question: t.question,
    evidence: { files: hits.get(t.id).length, examples: examplesOf(hits.get(t.id)) },
    options: [...suggestionsFor(t.id, target), `Most conservative: ${t.conservative}`], conservative: t.conservative }));
  if (legacy.size) {
    const all = [...legacy.values()].flat();
    questions.push({ topic: 'text-encoding', constructs: ['encoding', 'text-encoding', 'charset'], question: `Sources use ${[...legacy.keys()].join(', ')}. Which encoding should the target files and text I/O use?`,
      evidence: { files: all.length, examples: examplesOf(all) }, options: [...suggestionsFor('text-encoding', target), 'Most conservative: Keep the original encoding for every text the program reads or writes; write the ported source files in UTF-8.'],
      conservative: 'Keep the original encoding for every text the program reads or writes; write the ported source files in UTF-8.' });
  }
  // Generated files with an input in the repository: regenerate or translate.
  const groups = new Map();
  for (const e of readGeneratedFiles(root)) {
    if (!e.input) continue;
    const ext = (e.input.match(/\.[^./]+$/)?.[0] ?? e.input).toLowerCase();
    if (!groups.has(ext)) groups.set(ext, []);
    groups.get(ext).push(e);
  }
  for (const [ext, list] of groups) questions.push({ topic: `generated${ext}`, generatedFiles: list.map(e => e.file), question: `${list.length} generated file(s) are built from ${ext} inputs (${examplesOf(list.map(e => e.input)).join(', ')}). How should they be produced in the target?`,
    evidence: { files: list.length, examples: examplesOf(list.map(e => e.file)) },
    options: ["Regenerate with the target's generator (name the command)", 'Most conservative: translate them as ordinary code'], conservative: 'Translate them as ordinary code.' });
  return { kind: 'policy-questions', questions,
    next: questions.length ? 'Ask each question once (setup, before the inventory survey), recommending an option; record each answer with policy-record --topic ID --answer TEXT. For generated inputs record a regeneration with generated-files --regenerate FILE --how TEXT. In auto mode record the conservative option with policy-record --topic ID --answer TEXT --auto.' : 'No policy question found in the source.' };
}

const blockStart = '<!-- code-migration-kit:policy:start -->', blockEnd = '<!-- code-migration-kit:policy:end -->';
const blockHeading = '## Policy decisions (asked before the inventory survey)';
const policyLine = /^- \[policy:([A-Za-z0-9._-]+)\] constructs: ([^—]*?) — /;
function policyBlock(text) {
  const start = text.indexOf(blockStart), end = text.indexOf(blockEnd);
  if (start === -1 || end === -1 || end < start) return { before: text.replace(/\s*$/, '\n'), lines: [], other: [], after: '' };
  // Hand-written lines inside the block are kept as they are.
  // Blank lines inside hand text stay; only the block's edges are trimmed.
  const body = text.slice(start + blockStart.length, end).split(/\r?\n/).filter(l => l.trim() !== blockHeading);
  const other = body.filter(l => !policyLine.test(l)).join('\n').replace(/^\s*\n|\n\s*$/g, '').replace(/^\s+$/, '');
  return { before: text.slice(0, start), lines: body.filter(l => policyLine.test(l)), other: other ? other.split('\n') : [], after: text.slice(end + blockEnd.length) };
}
// policy-record: writes one decision into the RULEBOOK's managed block
// (replacing an earlier answer to the same topic).
export function recordPolicy(root, config, { topic, answer, auto = false } = {}) {
  if (typeof topic !== 'string' || !/^[A-Za-z0-9._-]+$/.test(topic)) throw new Error('--topic must be a policy-questions topic id');
  if (typeof answer !== 'string' || !answer.trim() || /[\r\n]/.test(answer)) throw new Error('--answer must be one line of text');
  const known = policyTopics.find(t => t.id === topic);
  const constructs = known?.constructs ?? (topic === 'text-encoding' ? ['encoding', 'text-encoding', 'charset'] : []);
  const release = lockRun(root, 'policy-record');
  try {
    const file = safePath(root, 'migration/RULEBOOK.md'), text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# RULEBOOK\n';
    const block = policyBlock(text);
    const line = `- [policy:${topic}] constructs: ${constructs.join(', ') || '-'} — ${answer.trim().replace(/—/g, '-')} (${auto ? `auto mode chose the ${conservativeNote}; TODO(port): confirm with the person` : 'decided by the person'}, ${stamp().slice(0, 10)})`;
    const lines = [...block.other, ...(block.other.length ? [''] : []), ...block.lines.filter(l => l.match(policyLine)[1] !== topic), line];
    const next = `${block.before.replace(/\s*$/, '\n\n')}${blockStart}\n${blockHeading}\n\n${lines.join('\n')}\n${blockEnd}${block.after.startsWith('\n') ? block.after : `\n${block.after}`}`;
    atomicWrite(file, next);
    const surveyed = fs.existsSync(safePath(root, 'migration/surveys/inventory/plan.json'));
    return { kind: 'policy-record', topic, constructs, line, ...(surveyed ? { warning: 'The RULEBOOK is part of every inventory survey input: results of the inventory survey already run are now stale and will run again.' } : {}) };
  } finally { release(); }
}

// rulebook-coverage: census constructs without a rule, largest first. A
// construct counts as covered when a policy line lists it or a hand-written
// rule is tagged "construct: NAME" (prose that only mentions a word does not count).
export function rulebookCoverage(root, config, { sites } = {}) {
  const generated = new Set(readGeneratedFiles(root).map(e => e.file));
  const census = censusSites(root, sites), counted = new Map();
  let generatedSites = 0;
  for (const s of census) { if (generated.has(s.file)) { generatedSites++; continue; } counted.set(s.source_construct, (counted.get(s.source_construct) ?? 0) + 1); }
  const file = safePath(root, 'migration/RULEBOOK.md'), text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const viaPolicy = new Map();
  for (const l of policyBlock(text).lines) { const [, topic, list] = l.match(policyLine); for (const c of list.split(',').map(x => x.trim()).filter(Boolean)) viaPolicy.set(c.toLowerCase(), `policy:${topic}`); }
  const named = c => new RegExp(`\\bconstruct:\\s*${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'iu').test(text);
  const constructs = [...counted].map(([construct, n]) => {
    const via = viaPolicy.get(construct.toLowerCase()) ?? (named(construct) ? 'construct tag' : null);
    return { construct, sites: n, covered: Boolean(via), ...(via ? { via } : {}) };
  }).sort((a, b) => b.sites - a.sites || (a.construct < b.construct ? -1 : 1));
  const uncovered = constructs.filter(c => !c.covered);
  return { kind: 'rulebook-coverage', sites: census.length - generatedSites, generatedSites, constructs, uncovered: uncovered.map(c => c.construct),
    uncoveredSites: uncovered.reduce((n, c) => n + c.sites, 0),
    next: uncovered.length ? 'Before the survey: decide the uncovered constructs with the most sites (ask once, or in auto mode the most conservative option), write each into the RULEBOOK tagged "construct: NAME" or with policy-record, then try them with survey run --trial.' : 'Every census construct has a rule; try a few sites with survey run --trial before the full survey.' };
}
