// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, fake } from './helpers.mjs';
import { safePath, writeJSON, atomicWrite, readJSON } from '../lib/core.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { costHeader } from '../lib/cost.mjs';
import { install, kitRoot } from '../scripts/install.mjs';
import { runProcess } from '../lib/process.mjs';
import { failureGuidance } from '../lib/guidance.mjs';

function fixture(t, mode = 'runtime') {
  const f = prepare(t);
  Object.assign(f.config,{phasePolicy:'strict',verificationMode:mode});
  writeJSON(safePath(f.root,'migration/config.json'),f.config);
  // The human-installed command guardrails that phases 03/04 require.
  fs.copyFileSync(path.join(kitRoot,'templates/guardrails.json'),safePath(f.root,'migration/guardrails.json'));
  atomicWrite(safePath(f.root,'migration/judge-report.md'),'Reviewed public arithmetic scenarios, commands, normalization and limitations.');
  atomicWrite(safePath(f.root,'migration/depmap/report.md'),'Audited parser coverage, isolated files and source dependency map.');
  atomicWrite(safePath(f.root,'migration/gap-report.md'),'Audited floor division, Unicode semantics and inventory coverage.');
  if(mode==='source-only') writeJSON(safePath(f.root,'migration/judge-plan.json'),{
    schemaVersion:1,verificationMode:'source-only',method:'Review source contracts',sources:['src/math_ops.py'],
    scenarios:[{path:'tests/judge.py',contract:'Arithmetic boundary cases',expectationBasis:'source-inferred'}],
    unverified:['Original runtime was not executed; behavioral equivalence unverified.']
  });
  phaseCommand(f.root,f.config,'init'); return f;
}
function complete(f,id) {
  phaseCommand(f.root,f.config,'start',id);
  return phaseCommand(f.root,f.config,'complete',id,{note:`Reviewed fixture phase ${id} evidence`});
}
async function preparation(f) {
  for(const id of ['00','00b','01','02']) complete(f,id);
  await runStage(f.root,f.config,'judge'); complete(f,'03');
  approve(f.root,f.config,'translation','Reviewed all preparation phases and pilot');
}
const rows = root => fs.readFileSync(safePath(root,'migration/cost-log.tsv'),'utf8').trimEnd().split('\n').slice(1).map(r=>r.split('\t'));

test('new installations default to strict and the installed CLI enforces order',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ordered-installed-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  install(root,{apply:true,model:'test-double'});
  assert.equal(readJSON(safePath(root,'migration/config.json')).phasePolicy,'strict');
  const script=safePath(root,'migration-kit/scripts/run_migration.mjs');
  const next=await runProcess(process.execPath,[script,'phase','next'],{cwd:root});
  assert.equal(next.code,0,next.stderr);assert.equal(JSON.parse(next.stdout).next,'00');
  const skipped=await runProcess(process.execPath,[script,'phase','start','04'],{cwd:root});
  assert.equal(skipped.code,1);assert.match(skipped.stderr,/Phase 03/);
});

test('skill initialization enables strict order on an existing legacy configuration without changing it',t=>{
  const f=prepare(t),file=safePath(f.root,'migration/config.json'),before=fs.readFileSync(file);
  phaseCommand(f.root,f.config,'init');
  assert.equal(migrationStatus(f.root).workflow.policy,'strict');
  assert.equal(migrationStatus(f.root).workflow.next,'00');
  assert.throws(()=>phaseCommand(f.root,f.config,'start','04'),/Phase 03/);
  assert.deepEqual(fs.readFileSync(file),before);
});

test('existing artifacts cannot skip early phases, including through direct runner calls',async t=>{
  const f=fixture(t);
  assert.equal(phaseCommand(f.root,f.config,'next').next,'00');
  assert.throws(()=>phaseCommand(f.root,f.config,'start','04'),/Phase 03/);
  await assert.rejects(runStage(f.root,f.config,'judge'),/Phase 02/);
  assert.throws(()=>approve(f.root,f.config,'translation','Try skipping'),/Phase 03/);
  complete(f,'00');assert.equal(phaseCommand(f.root,f.config,'next').next,'00b');
  assert.throws(()=>complete(f,'02'),/Phase 01/);
  for(const id of ['00b','01','02']) complete(f,id);
  assert.throws(()=>complete(f,'03'),/Run judge/);
  await runStage(f.root,f.config,'judge');complete(f,'03');
  assert.equal(phaseCommand(f.root,f.config,'next').next,'04');
});

test('runtime completes ten ordered phases and phase 06 needs its reviewed final report',async t=>{
  const f=fixture(t);await preparation(f);await translate(f.root,f.config,fake);
  assert.equal(phaseCommand(f.root,f.config,'next').next,'05');
  assert.throws(()=>phaseCommand(f.root,f.config,'start','05c'),/Run smoke/);
  for(const stage of ['build','smoke','parity']) {approve(f.root,f.config,stage,'Reviewed current evidence');await runStage(f.root,f.config,stage);}
  approve(f.root,f.config,'post-parity','Reviewed parity for cleanup');
  assert.equal(phaseCommand(f.root,f.config,'next').next,'06');
  assert.throws(()=>complete(f,'06'),/handoff.md/);
  atomicWrite(safePath(f.root,'migration/handoff.md'),'Actual cleanup outcomes, marker decisions, parity results and remaining limitations.');
  complete(f,'06');
  const report=migrationStatus(f.root);assert.equal(report.workflow.done,10);assert.equal(report.workflow.next,null);
  assert.equal(report.phases.find(p=>p.id==='06').status,'reviewed');
  await runStage(f.root,f.config,'parity');assert.equal(migrationStatus(f.root).workflow.next,'06');
});

test('source-only parity requires explicit applicability acknowledgment before handoff',async t=>{
  const f=fixture(t,'source-only');await preparation(f);await translate(f.root,f.config,fake);
  for(const stage of ['build','smoke']) {approve(f.root,f.config,stage,'Reviewed current evidence');await runStage(f.root,f.config,stage);}
  assert.equal(phaseCommand(f.root,f.config,'next').next,'05c');
  atomicWrite(safePath(f.root,'migration/handoff.md'),'Source-based complete; equivalence unverified; runtime parity pending.');
  const refusal=(()=>{try{approve(f.root,f.config,'handoff','Try skipping acknowledgment');}catch(e){return e;}})();
  assert.match(refusal?.message??'',/Phase 05c/);
  // Source-only 05c is the person's acknowledgment, not a runner stage to rerun.
  const ack=failureGuidance(refusal,{root:f.root,language:'en'});
  assert.equal(ack.recommended,'acknowledge-unverified');assert.match(ack.options[0].command,/phase complete 05c --note/);
  assert.ok(!ack.options.some(o=>o.id==='finish-runner-phase'));
  complete(f,'05c');assert.equal(readJSON(safePath(f.root,'migration/phases/05c.json')).equivalence,'unverified');
  approve(f.root,f.config,'handoff','Reviewed smoke and limitations');await runStage(f.root,f.config,'handoff');
  assert.equal(migrationStatus(f.root).workflow.done,10);assert.equal(migrationStatus(f.root).equivalence,'unverified');
  assert.equal(fs.existsSync(safePath(f.root,'migration/results/parity.json')),false);
});

test('phase evidence changes invalidate the chain and block existing translation approval',async t=>{
  const f=fixture(t);await preparation(f);
  fs.appendFileSync(safePath(f.root,'migration/depmap/report.md'),' Changed audited coverage.');
  assert.equal(phaseCommand(f.root,f.config,'next').next,'01');
  let calls=0;await assert.rejects(translate(f.root,f.config,c=>{calls++;return fake(c);}),/Phase 03/);
  assert.equal(calls,0);
});

test('main-compatible cost rows preserve unknowns, measured usage, existing rows and idempotent exports',async t=>{
  const f=fixture(t);
  atomicWrite(safePath(f.root,'migration/cost-log.tsv'),`${costHeader}\nlegacy\t2026-01-01T00:00:00Z\t1\tunknown\tunknown\tunknown\n`);
  phaseCommand(f.root,f.config,'start','00');
  phaseCommand(f.root,f.config,'complete','00',{note:'Reviewed actual usage',tokens:'12',subagents:'2',model:'host-measured-model'});
  let table=rows(f.root);assert.equal(table.length,2);assert.deepEqual(table[1].slice(3),['12','2','host-measured-model']);
  assert.ok(Number.isFinite(Number(table[1][2])));
  fs.rmSync(safePath(f.root,'migration/cost-log.tsv'));
  phaseCommand(f.root,f.config,'complete','00',{note:'Same reviewed evidence'});
  assert.deepEqual(rows(f.root),table);
  for(const id of ['00b','01','02']) complete(f,id);
  await runStage(f.root,f.config,'judge');complete(f,'03');approve(f.root,f.config,'translation','Reviewed');
  await translate(f.root,f.config,async c=>({...await fake(c),tokens:7,observedModel:'verified-worker-model'}));
  table=rows(f.root);assert.ok(table.every(r=>r.length===6));
  assert.deepEqual(table.findLast(r=>r[0]==='04').slice(3),['21','3','verified-worker-model']);
  assert.deepEqual(table.find(r=>r[0]==='01').slice(3),['unknown','unknown','unknown']);
  assert.throws(()=>phaseCommand(f.root,f.config,'complete','00',{note:'Usage',tokens:'-1'}),/nonnegative/);
});

test('failed worker logs actual calls and unknown usage, not unused reservations',async t=>{
  const f=fixture(t);f.config.concurrency=1;writeJSON(safePath(f.root,'migration/config.json'),f.config);
  await preparation(f);
  await assert.rejects(translate(f.root,f.config,c=>{if(c.role==='reviewer-semantics')throw new Error('Review transport failed: Bad credentials');return fake(c);}),/transport failed/);
  assert.deepEqual(rows(f.root).findLast(r=>r[0]==='04').slice(3),['unknown','2','unknown']);
});

test('phases 03 and 04 refuse to start without human-installed guardrails or a recorded waiver',async t=>{
  const f=fixture(t),file=safePath(f.root,'migration/guardrails.json');
  for(const id of ['00','00b','01','02']) complete(f,id);
  await runStage(f.root,f.config,'judge');
  fs.rmSync(file);
  assert.throws(()=>phaseCommand(f.root,f.config,'start','03'),/requires human-installed command guardrails/);
  writeJSON(file,{schemaVersion:1,denyCommands:[]});
  assert.throws(()=>phaseCommand(f.root,f.config,'start','03'),/deny nothing and record no waiver/);
  fs.writeFileSync(file,'{not json');
  assert.throws(()=>phaseCommand(f.root,f.config,'start','03'),/guardrails are invalid/);
  writeJSON(file,{schemaVersion:1,waiver:{note:'Human accepted: disposable sandbox run'}});
  assert.equal(phaseCommand(f.root,f.config,'start','03').phase,'03');
  phaseCommand(f.root,f.config,'complete','03',{note:'Reviewed fixture stress evidence'});
  fs.rmSync(file);
  assert.throws(()=>phaseCommand(f.root,f.config,'start','04'),/Phase 04 requires human-installed/);
});
