// SPDX-License-Identifier: Apache-2.0
// Experimental Copilot SDK extension; module resolution is supplied by Copilot CLI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineWorkflow, joinSession } from '@github/copilot-sdk/extension';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const installed = path.join(root, 'migration-kit/lib/workflow.mjs');
const modulePath = fs.existsSync(installed) ? installed : path.join(root, 'lib/workflow.mjs');
const { createWorkflowDefinition } = await import(pathToFileURL(modulePath).href);
await joinSession({ workflows: [defineWorkflow(createWorkflowDefinition(root))] });
