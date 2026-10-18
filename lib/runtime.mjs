// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from './vendor/yaml.mjs';
import { readUtf8 } from './text.mjs';

export const pluginRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
export function runtimeLayout(root, config = {}) {
  if (config.runtime !== undefined && !['repository', 'plugin'].includes(config.runtime)) throw new Error('runtime must be repository or plugin');
  const plugin = config.runtime === 'plugin';
  if (plugin) {
    const project = fs.realpathSync(root);
    if (project === pluginRoot || pluginRoot.startsWith(`${project}${path.sep}`)) throw new Error('Plugin runtime must be outside the migration target repository');
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
    if (manifest.name !== 'code-migration-kit' || manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') throw new Error('Invalid migration plugin manifest');
  }
  // nativeInput file selects the request-file reader profiles (repository layout only).
  const file = config.nativeInput === 'file' ? '-file' : '';
  return {
    plugin, root: plugin ? pluginRoot : root,
    nativeAgentId: role => `${plugin ? 'code-migration-kit:code-migration-plugin' : 'migration'}-native-${role}${file}`,
    nativeAgentPath: role => `${plugin ? 'com.github.copilot' : '.github'}/agents/${plugin ? 'code-migration-plugin' : 'migration'}-native-${role}${file}.agent.md`,
    agentId: role => `${plugin ? 'code-migration-kit:code-migration-plugin' : 'migration'}-${role}`,
    agentPath: role => `${plugin ? 'com.github.copilot' : '.github'}/agents/${plugin ? 'code-migration-plugin' : 'migration'}-${role}.agent.md`,
    hookPath: plugin ? 'com.github.copilot/hooks/hooks.json' : '.github/hooks/code-migration.json'
  };
}

export function agentMetadata(content, file) {
  const front = content.replace(/^\uFEFF/, '').match(/^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/);
  if (!front) return null; // CLI ignores Markdown without YAML frontmatter.
  try {
    const value = parseYAML(front[1], { maxAliasCount: 100, prettyErrors: false, logLevel: 'silent' });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('frontmatter must be a mapping');
    return value;
  } catch (e) {
    // Agent metadata may contain credentials for MCP servers; omit YAML excerpts.
    throw new Error(`Cannot verify agent frontmatter in ${file}${e.code ? ` (${e.code})` : ''}; fix the YAML before migration`);
  }
}

function* agentFiles(directory, relative = '') {
  if (!fs.existsSync(directory)) return;
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Cannot verify symlinked agent directory: ${directory}`);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.name.startsWith('.')) continue;
    const file = path.join(directory, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Cannot verify symlinked agent path: ${file}`);
    if (entry.isDirectory()) yield* agentFiles(file, name);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Copilot derives nested IDs from the relative file path, preserving case.
      const id = name.replace(/(?:\.agent)?\.md$/, '').replaceAll('/', '--');
      yield { file, id };
    }
  }
}

// Copilot 1.0.93 can select by file-derived ID OR YAML name. Reserve the fully
// qualified plugin selector in every local discovery root, including definitions
// currently hidden by another local ID. Native hosts can also select by name;
// callers must reserve those aliases too. CLI callers only use the qualified ID.
// Plain, quoted, folded and aliased names must all resolve before comparison.
export function assertNoPluginAgentOverride(root, agentId, aliases = []) {
  const selectors = new Set([agentId, ...aliases]);
  const ancestors = [];
  for (let dir = fs.realpathSync(root); ; dir = path.dirname(dir)) {
    ancestors.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  const copilotHome = path.resolve(root, process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'));
  const directories = [path.join(copilotHome, 'agents'),
    ...ancestors.map(dir => path.join(dir, '.github/agents')),
    ...ancestors.map(dir => path.join(dir, '.claude/agents'))];
  for (const directory of directories) for (const { file, id } of agentFiles(directory)) {
    const metadata = agentMetadata(readUtf8(file, file), file);
    if (!metadata || typeof metadata.description !== 'string') continue;
    if (selectors.has(id) || selectors.has(metadata.name)) throw new Error(`Plugin worker selector is shadowed or duplicated by ${file}; rename its name or ID before migration`);
  }
}
