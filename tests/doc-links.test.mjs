import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { kitRoot } from '../scripts/install.mjs';

// Every relative link in the kit's documents and guides points at a file that
// exists, so a moved or deleted document cannot leave a dead link behind.
// Links into migration/ name a project's own files (examples), not the kit's.
const skippedDirs = new Set(['.git', 'node_modules', 'fixtures', 'tests', 'lib', 'examples']);
function documents(dir = '.') {
  return fs.readdirSync(path.join(kitRoot, dir), { withFileTypes: true }).flatMap(entry => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return skippedDirs.has(entry.name) ? [] : documents(rel);
    return /\.(md|html)$/.test(entry.name) ? [rel] : [];
  });
}

// Anchors a link may name: GitHub's heading slugs for Markdown, plus any id="..."
// (explicit <a id> in Markdown, element ids in HTML).
const anchorCache = new Map();
function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const text = fs.readFileSync(file, 'utf8');
  const ids = new Set([...text.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  if (file.endsWith('.md')) {
    const seen = new Map();
    let fenced = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      const heading = !fenced && line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
      if (!heading) continue;
      const base = heading[1].replace(/<[^>]+>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/ /g, '-');
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      ids.add(count ? `${base}-${count}` : base);
    }
  }
  anchorCache.set(file, ids);
  return ids;
}

test('relative links in documents and guides resolve to files and anchors in the kit', () => {
  const broken = [];
  const files = documents();
  assert.ok(files.includes(path.join('docs', 'REFERENCE.md')));
  for (const file of files) {
    const text = fs.readFileSync(path.join(kitRoot, file), 'utf8');
    const links = file.endsWith('.md') ? text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g) : text.matchAll(/(?:href|src)="([^"]+)"/g);
    for (const [, link] of links) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\$\{|migration\/)/i.test(link)) continue;
      const [rawTarget, fragment] = link.split('#');
      const target = decodeURI(rawTarget);
      const resolved = path.join(kitRoot, path.dirname(file), target);
      if (target && !fs.existsSync(resolved)) broken.push(`${file} -> ${link}`);
      else if (target && fragment && /\.(md|html)$/.test(target) && !anchors(resolved).has(decodeURIComponent(fragment))) broken.push(`${file} -> ${link} (no such anchor)`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every Japanese document with an English twin links to it, and back', () => {
  for (const file of fs.readdirSync(path.join(kitRoot, 'docs')).filter(f => f.endsWith('.en.md'))) {
    const ja = file.replace(/\.en\.md$/, '.md');
    assert.ok(fs.existsSync(path.join(kitRoot, 'docs', ja)), ja);
    assert.ok(fs.readFileSync(path.join(kitRoot, 'docs', ja), 'utf8').includes(`](${file})`), `${ja} links ${file}`);
    assert.ok(fs.readFileSync(path.join(kitRoot, 'docs', file), 'utf8').includes(`](${ja})`), `${file} links ${ja}`);
  }
});
