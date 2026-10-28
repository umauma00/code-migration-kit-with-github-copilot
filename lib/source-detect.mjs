// SPDX-License-Identifier: Apache-2.0
// Guesses the language to migrate from by counting source files by extension,
// so setup asks one question (the target, with the guess shown) instead of
// two. The runner migrates one source language: a second language with a
// comparable share is reported as mixed, so the person chooses the main one,
// and smaller ones are listed as files the migration leaves out.
import fs from 'node:fs';
import path from 'node:path';

// Extension -> the language name the bundled mappers recognize (lib/source-spec.mjs).
const extensions = {
  '.cs': 'C#', '.vb': 'VB.NET', '.java': 'Java', '.py': 'Python', '.php': 'PHP',
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.cbl': 'COBOL', '.cob': 'COBOL', '.cpy': 'COBOL', '.c': 'C', '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++',
  '.go': 'Go', '.rb': 'Ruby', '.kt': 'Kotlin', '.scala': 'Scala', '.rs': 'Rust', '.swift': 'Swift', '.pl': 'Perl',
  '.frm': 'VB6', '.bas': 'VB6', '.sql': 'SQL'
};
// Languages that accompany a program rather than make it: never the guess
// while another language is present.
const auxiliary = ['SQL'];
// Directories that hold dependencies, build output, tooling or the kit's own files.
const skipped = new Set(['node_modules', '__pycache__', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor', 'packages', 'venv', 'migration', 'migration-kit', 'coverage']);
const testDirectory = /^(tests?|specs?|__tests__)$/i;
const limit = 100000;
// A second language this large next to the first is a mixed source, not a few helper files.
const mixedShare = 0.3, mixedMinimum = 10;

export const commonTargets = ['TypeScript', 'Java', 'C#', 'Go', 'Python'];

// Returns { languages: [{ language, files, roots }], primary, mixed, minor, truncated }.
// roots are the top-level folders holding the language's files, without test
// folders and the configured output and test roots; files directly at the
// repository root are counted but name no folder.
export function detectSourceLanguages(root, { exclude = [] } = {}) {
  const counts = new Map();
  const excluded = new Set(exclude.map(p => String(p).replace(/^\.\//, '').replace(/\/+$/, '')));
  let seen = 0, truncated = false;
  const visit = (rel, top) => {
    let entries;
    try { entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || skipped.has(entry.name) || excluded.has(name)) continue;
        visit(name, top ?? entry.name);
      } else if (entry.isFile()) {
        if (++seen > limit) { truncated = true; return; }
        const ext = path.extname(entry.name).toLowerCase();
        const language = entry.name.endsWith('.d.ts') ? null : extensions[ext];
        if (!language) continue;
        const item = counts.get(language) ?? { language, files: 0, roots: new Set() };
        item.files++;
        if (top && !testDirectory.test(top)) item.roots.add(top);
        counts.set(language, item);
      }
    }
  };
  visit('', null);
  const languages = [...counts.values()].map(l => ({ ...l, roots: [...l.roots].sort() }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
  const main = languages.filter(l => !auxiliary.includes(l.language));
  const primary = (main[0] ?? languages[0])?.language ?? null;
  const top = languages.find(l => l.language === primary);
  const others = languages.filter(l => l.language !== primary);
  const mixed = others.filter(l => !auxiliary.includes(l.language) && l.files >= mixedMinimum && l.files >= top.files * mixedShare).map(l => l.language);
  return { languages, primary, mixed, minor: others.filter(l => !mixed.includes(l.language)).map(l => l.language), truncated };
}

// The one setup question: the guessed source and a choice of target, in the
// report language. Free text corrects the source or names another target.
export function languageQuestion(detected, language) {
  const ja = language === 'ja';
  const describe = l => ja ? `${l.language}（${l.roots.length ? `${l.roots.join('、')} 配下、` : ''}${l.files} ファイル）`
    : `${l.language} (${l.files} files${l.roots.length ? ` in ${l.roots.join(', ')}` : ''})`;
  const top = detected.languages.find(l => l.language === detected.primary);
  const choices = commonTargets.filter(t => t !== detected.primary);
  if (!top) return { question: ja ? '移行元のソースが見つかりませんでした。移行元と移行先の言語を「移行元→移行先」の形で書いてください。' : 'No source files were found. Write the languages as "source -> target".', choices: [], freeText: true };
  const mixedNote = detected.mixed.length ? (ja
    ? `${detected.mixed.map(m => describe(detected.languages.find(l => l.language === m))).join('、')}も同じくらいあります。キットが一度に移行できる移行元の言語は1つです。主言語が違う場合は自由記入で書いてください。`
    : ` ${detected.mixed.map(m => describe(detected.languages.find(l => l.language === m))).join(', ')} is also substantial. The kit migrates one source language at a time; if the main one is another, write it as free text.`) : '';
  const minorNote = detected.minor.length ? (ja ? `${detected.minor.join('、')}のファイルは移行の対象外になります。` : ` ${detected.minor.join(', ')} files are left out of the migration.`) : '';
  return {
    question: ja ? `移行元は ${describe(top)}と判定しました。${mixedNote}${minorNote}移行先はどの言語にしますか？`
      : `The source looks like ${describe(top)}.${mixedNote}${minorNote} Which language do you migrate to?`,
    choices,
    freeText: ja ? '別の移行先、または移行元の訂正（例: VB.NET→TypeScript）' : 'Another target, or a corrected source (for example VB.NET -> TypeScript)'
  };
}
