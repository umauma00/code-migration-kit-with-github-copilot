// SPDX-License-Identifier: Apache-2.0
// PR #2 review follow-ups: read-only commands near migration/guardrails.json,
// root-anchored migration/ protection, deny-list parsing, worker environment
// and transient failure classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from './helpers.mjs';
import { safePath } from '../lib/core.mjs';
import { interactiveDecision } from '../lib/guardrails.mjs';
import { isTransientFailure, isSystemicFailure } from '../lib/failures.mjs';

test('reading migration/ is allowed while writes to the guardrails file and the directory stay denied', t => {
  const f = prepare(t);
  const decide = (command, cwd = f.root) => interactiveDecision({ toolName: 'bash', toolArgs: { command }, cwd }, f.root)?.decision ?? null;
  for (const command of ['cat migration/guardrails.json 2>/dev/null || echo none', 'cat migration/guardrails.json 2>&1 | head -20',
    'jq . migration/guardrails.json > /tmp/out.json', "find migration -maxdepth 2 -name '*.json'", 'find migration -type f | head -20',
    'find migration -name guardrails.json', "find src/db/migration -name '*.sql'", 'rm -rf src/db/migration', 'mv src/db/migration src/db/migrations',
    'grep -rn denyCommands migration/ 2>/dev/null', 'ls -la migration/', 'rm -rf migration/runs', 'cat migration/guardrails.json',
    'rsync -a migration/ /tmp/backup/']) {
    assert.equal(decide(command), null, command);
  }
  for (const command of [`echo '{}' > migration/guardrails.json`, `echo '{}' | tee migration/guardrails.json`, 'cp /tmp/x migration/guardrails.json',
    "sed -i 's/a/b/' migration/guardrails.json", `python3 -c "open('migration/guardrails.json','w').write('{}')"`,
    `cd migration && echo '{}' > guardrails.json`, 'dd of=migration/guardrails.json if=/dev/null', 'truncate -s 0 migration/guardrails.json',
    'rm migration/guardrails.json', 'rm -rf migration', 'mv migration migration.bak', 'git checkout -- migration/guardrails.json',
    'git rm -f migration/guardrails.json', 'rm -rf ./migration/../migration', 'find migration -name guardrails.json -delete',
    'find migration -exec rm {} +', 'cat migration/guardrails.json > migration/guardrails.json', ': > migration/guardrails.json',
    'cat x >migration/guardrails.json', 'cat x 2> "migration/guardrails.json"', 'rsync -a /tmp/x/ migration', 'rsync --remove-source-files migration/ /tmp/x/']) {
    assert.equal(decide(command), 'deny', command);
  }
  // Paths resolve from the shell's working directory; a cd makes that unknown.
  const src = safePath(f.root, 'src');
  assert.equal(decide('rm -rf ../migration', src), 'deny');
  assert.equal(decide('rm -rf migration', src), null);
  assert.equal(decide('cd .. && rm -rf migration', src), 'deny');
  assert.equal(decide('rm -rf *', src), null);
  assert.equal(decide('rm -rf *'), 'deny');
  assert.equal(decide('rm guardrails.json'), null);
  assert.equal(decide('rm guardrails.json', safePath(f.root, 'migration')), 'deny');
  assert.equal(decide(`echo '{}' > guardrails.json`, safePath(f.root, 'migration')), 'deny');
  // The denial names the file only for writes.
  assert.match(interactiveDecision({ toolName: 'bash', toolArgs: { command: 'rm -rf migration' }, cwd: f.root }, f.root).reason, /guardrails install/);
});

test('HTTP 500 from the model is retried like 502-504; 501, sign-in and quota are not', () => {
  const error = message => new Error(message);
  for (const message of ['session.error server_error 500: Internal Server Error', 'session.error 500: boom', 'session.error rate_limit 429: slow down',
    'session.error unavailable 502: Bad Gateway', 'session.error unavailable 503: Service Unavailable', 'session.error unavailable 504: Gateway Timeout']) {
    assert.equal(isTransientFailure(error(message)), true, message);
  }
  for (const message of ['session.error authentication 401: Unauthorized', 'session.error quota_exceeded 402: no credits']) {
    assert.equal(isSystemicFailure(error(message)), true, message);
    assert.equal(isTransientFailure(error(message)), false, message);
  }
  for (const message of ['session.error not_implemented 501: Not Implemented', 'Copilot implementer failed (exit 1): output exceeded 500 lines']) {
    assert.equal(isTransientFailure(error(message)), false, message);
  }
});
