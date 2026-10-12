// SPDX-License-Identifier: Apache-2.0
import { loadConfig, contextHash } from './core.mjs';
import { translate, runStage } from './pipeline.mjs';
import { createCopilotAdapter } from '../scripts/copilot_adapter.mjs';

// The SDK hosts the stage, but workers use fresh CLI processes. ctx.agent has
// no per-call instruction-discovery switch in the referenced SDK; inheriting
// the host session would weaken the frozen-input contract.
export function createWorkflowDefinition(root, { command = 'copilot', prefixArgs = [] } = {}) {
  return {
    meta: {
      name: 'code-migration', description: 'Run ONE approved migration stage. args: {stage: "translate"|"judge"|"build"|"smoke"|"parity", copilot?: "/path/to/copilot"}. Never approves a stage.',
      phases: [{ title: 'Validate inputs' }, { title: 'Run approved stage' }, { title: 'Report' }],
      argsSchema: { type: 'object', required: ['stage'], properties: {
        stage: { type: 'string', enum: ['translate', 'judge', 'build', 'smoke', 'parity'] }, copilot: { type: 'string', minLength: 1 }
      } }
    },
    run: async ctx => {
      const stage = ctx.args?.stage, executable = ctx.args?.copilot ?? command;
      if (!['translate', 'judge', 'build', 'smoke', 'parity'].includes(stage)) throw new Error('Choose exactly one supported stage');
      if (typeof executable !== 'string' || !executable.trim()) throw new Error('copilot must name a CLI executable');
      ctx.phase('Validate inputs');
      const config = loadConfig(root); contextHash(root, config);
      if (config.workerBackend === 'native') throw new Error('Native workers are driven by the host session through run_migration.mjs, not Dynamic Workflows');
      ctx.phase('Run approved stage');
      const adapter = createCopilotAdapter({ command: executable, prefixArgs });
      // Disk receipts, not SDK agent/step journals, decide what remains on resume.
      const result = stage === 'translate'
        ? await translate(root, config, adapter, { signal: ctx.signal, onProgress: e => ctx.log(`${e.unit}: ${e.stage}`) })
        : await runStage(root, config, stage, { signal: ctx.signal });
      ctx.phase('Report');
      ctx.log('Stage finished. Review artifacts and approve the next stage separately.');
      return result;
    }
  };
}
