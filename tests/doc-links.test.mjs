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

test('relative links in documents and guides resolve to files in the kit', () => {
  const broken = [];
  const files = documents();
  assert.ok(files.includes(path.join('docs', 'REFERENCE.md')));
  for (const file of files) {
    const text = fs.readFileSync(path.join(kitRoot, file), 'utf8');
    const links = file.endsWith('.md') ? text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g) : text.matchAll(/(?:href|src)="([^"]+)"/g);
    for (const [, link] of links) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\$\{|migration\/)/i.test(link)) continue;
      const target = decodeURI(link.split('#')[0]);
      if (target && !fs.existsSync(path.join(kitRoot, path.dirname(file), target))) broken.push(`${file} -> ${link}`);
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
