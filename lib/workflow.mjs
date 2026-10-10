// SPDX-License-Identifier: Apache-2.0
import { loadConfig, contextHash, fileHash, safePath, hash } from './core.mjs';
import { translate, runStage } from './pipeline.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';
import { validateResult } from './results.mjs';
import { validateWorkerProfile } from './review.mjs';

export function workflowResultSchema(role, target) {
  const base = { type: 'object', required: ['schemaVersion', 'target', 'kind'], properties: {
    schemaVersion: { type: 'integer', const: 1 }, target: { type: 'string', const: target }, kind: { type: 'string' }
  } };
  const add = properties => { Object.assign(base.properties, properties); base.required.push(...Object.keys(properties)); return base; };
  if (role === 'implementer' || role === 'fixer') {
    base.properties.kind.const = 'implementation';
    return add({ content: { type: 'string' }, summary: { type: 'string' } });
  }
  if (role.startsWith('reviewer-')) {
    base.properties.kind.const = 'review';
    return add({ verdict: { type: 'string', enum: ['pass', 'changes'] }, findings: { type: 'array', items: { type: 'object', required: ['id', 'message', 'rule', 'evidence'], properties: {
      id: { type: 'string' }, message: { type: 'string' }, rule: { type: 'string' }, evidence: { type: 'string' }
    } } } });
  }
  base.properties.kind.const = 'arbitration';
  return add({ decisions: { type: 'array', items: { type: 'object', required: ['finding', 'confirmed', 'reason'], properties: {
    finding: { type: 'string' }, confirmed: { type: 'boolean' }, reason: { type: 'string' }
  } } } });
}
export function createWorkflowDefinition(root) {
  let limits;
  try { const c = loadConfig(root); limits = { maxConcurrentSubagents: c.concurrency, maxTotalSubagents: c.maxAgentCalls }; } catch { /* Validate configuration when invoked. */ }
  return {
    meta: {
      name: 'code-migration', description: 'Run ONE approved migration stage. args: {stage: "translate"|"judge"|"build"|"smoke"|"parity"}. Never approves a stage.',
      phases: [{ title: 'Validate inputs' }, { title: 'Run approved stage' }, { title: 'Report' }],
      argsSchema: { type: 'object', required: ['stage'], properties: { stage: { type: 'string', enum: ['translate', 'judge', 'build', 'smoke', 'parity'] } } },
      ...(limits ? { limits } : {})
    },
    run: async ctx => {
      const stage = ctx.args?.stage;
      if (!['translate', 'judge', 'build', 'smoke', 'parity'].includes(stage)) throw new Error('Choose exactly one supported stage');
      ctx.phase('Validate inputs');
      const config = loadConfig(root), context = contextHash(root, config);
      ctx.phase('Run approved stage');
      const adapter = async ({ role, unit, extra, reviewInput }) => {
        validateWorkerProfile(root, role);
        const prompt = agentPrompt({ role, unit, extra, reviewInput });
        const result = await ctx.agent(prompt, {
          // Labels are unique by role and input version. Resuming the same input can reuse a durable result.
          label: `${unit.id}:${role}:${hash(context + String(fileHash(safePath(root, unit.target))) + prompt).slice(0, 20)}`,
          model: config.models[role], agent: `migration-${role}`, schema: workflowResultSchema(role, unit.target)
        });
        if (result === null || result === undefined) throw new Error(`Workflow agent ${role} returned no usable result`);
        try { return { result: validateResult(role, result, unit), requestedModel: config.models[role], observedModel: null, tokens: null, aiCredits: null }; }
        catch (e) { e.response = result; throw e; }
      };
      // Do not journal side-effecting stages under a fixed key: disk receipts are authoritative.
      // Workflow cancellation propagates into the same resumable engine used by CLI.
      const result = stage === 'translate'
        ? await translate(root, config, adapter, { signal: ctx.signal, onProgress: e => ctx.log(`${e.unit}: ${e.stage}`) })
        : await runStage(root, config, stage, { signal: ctx.signal });
      ctx.phase('Report');
      ctx.log('Stage finished. Review artifacts and approve the next stage separately.');
      return result;
    }
  };
}
