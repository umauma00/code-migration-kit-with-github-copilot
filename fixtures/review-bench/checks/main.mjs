// Static check for a fixed ported/main.mjs, which reads stdin when imported:
// node checks/main.mjs FILE
import assert from 'node:assert/strict';
import fs from 'node:fs';
const text = fs.readFileSync(process.argv[2], 'utf8');
assert.match(text, /PORT STATUS/, 'PORT STATUS trailer missing');
assert.match(text, /from '\.\/math_ops\.mjs'/, 'math_ops import must use .mjs');
assert.match(text, /from '\.\/text_ops\.mjs'/, 'text_ops import must use .mjs');
assert.doesNotMatch(text, /from '\.\/[a-z_]+\.js'/, 'a .js import remains');
assert.match(text, /catch \(error\)/, 'error handling was removed');
