// Opt-in check against a real CLI. No model requests or account are needed.
// node tests/verify_plugin.mjs /absolute/path/to/copilot
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roles } from '../lib/core.mjs';
import { pluginRoot, runtimeLayout } from '../lib/runtime.mjs';
import { runProcess } from '../lib/process.mjs';
import { copilotArgs } from '../scripts/copilot_adapter.mjs';

const command = process.argv[2];
if (!command || !path.isAbsolute(command)) throw new Error('Supply an absolute Copilot executable path');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-plugin-cli-'));
try {
  const root = path.join(sandbox, 'project'); fs.mkdirSync(root);
  const env = { ...process.env, COPILOT_HOME: path.join(sandbox, 'copilot-home'),
    COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '', COPILOT_AUTO_UPDATE: 'false',
    // A loopback-only dummy provider bypasses account checks. The invalid
    // agent aborts before sending a request; no provider is listening here.
    COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1/v1',
    COPILOT_PROVIDER_API_KEY: 'local-test-only', COPILOT_PROVIDER_BEARER_TOKEN: '',
    COPILOT_PROVIDER_WIRE_API: 'completions' };
  const run = args => runProcess(command, args, { cwd: root, env, timeoutMs: 20000 });
  const added = await run(['plugin', 'marketplace', 'add', pluginRoot]);
  assert.equal(added.code, 0, added.stderr);
  const installed = await run(['plugin', 'install', 'code-migration-kit@code-migration-kit-marketplace']);
  assert.equal(installed.code, 0, installed.stderr);
  const listed = await run(['--plugin-dir', pluginRoot, 'plugin', 'list', '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  const plugins = JSON.parse(listed.stdout);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  assert.ok(plugins.some(p => p.name === manifest.name && p.version === manifest.version && p.enabled));
  // An unknown agent fails before session/model execution and lists the IDs
  // actually discovered by the CLI. This catches unqualified --agent values.
  const layout = runtimeLayout(root, { runtime: 'plugin' });
  const args = copilotArgs('reviewer-rules', 'diagnostic-model', 'No model request should be made.', layout);
  args[args.indexOf('--agent') + 1] = '__migration_plugin_probe_missing_agent__';
  const probe = await run(args);
  assert.notEqual(probe.code, 0);
  assert.match(probe.stderr, /No such agent:/);
  for (const role of ['orchestrator', ...roles]) assert.ok(probe.stderr.includes(layout.agentId(role)), `Missing plugin profile: ${role}`);
  console.log(JSON.stringify({ plugin: manifest.name, version: manifest.version,
    marketplaceInstall: true, agentIDs: ['orchestrator', ...roles].map(layout.agentId), externalAI: false }, null, 2));
} finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
