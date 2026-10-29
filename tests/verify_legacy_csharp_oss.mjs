// SPDX-License-Identifier: Apache-2.0
// Opt-in integration probe over pinned, downloaded OSS sources. Model answers
// are EXPLICIT transport doubles: this never claims semantic or human review.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { install, kitRoot } from '../scripts/install.mjs';
import { atomicWrite, safePath, readJSON, writeJSON, readManifest, fileHash, hash } from '../lib/core.mjs';
import { initSourceSpec, sourceSpecReadiness } from '../lib/source-spec.mjs';
import { runSurvey, planSurvey, surveyInput, surveyStatus, mergeSurvey } from '../lib/survey.mjs';
import { surveyRequests } from '../lib/survey-parts.mjs';
import { previewInventory } from '../lib/preparation.mjs';
import { runProcess } from '../lib/process.mjs';

const directory = path.resolve(process.argv[2] ?? '/workspace/scratch/legacy-csharp-oss-20261026');
const reportPath = path.resolve(process.argv[3] ?? path.join(directory, 'verification.json'));
const corpus = readJSON(path.join(directory, 'corpus.json'));
const inputLimit = 65536, warning = 'TRANSPORT TEST ONLY: semantic analysis and human review have not run';
const header = 'file\tsymbol\tsource_construct\tclassification\ttarget_translation\tevidence\tstatus';
const sha = data => createHash('sha256').update(data).digest('hex');
const textBody = text => text.replace(/\r\n|\r/g, '\n').replace(/\n$/, '');
const unnumber = text => text.split('\n').map(line => line.slice(line.indexOf('|') + 1)).join('\n');
const keyOf = site => JSON.stringify([site.file, site.symbol, site.source_construct]);
const log = (id, text) => console.error(`${id}: ${text}`);
const timer = async action => { const before=performance.now(); const value=await action(); return { value, seconds: Number(((performance.now()-before)/1000).toFixed(3)) }; };

function setup(root) {
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(safePath(root,'migration/config.json'))) throw new Error(`Verification output already exists at ${root}; prepare a fresh corpus to preserve previous results`);
  install(root, { apply: true, layout: 'plugin', model: 'test-double-transport-only', preparationProfile: 'source-as-spec' });
  const config=readJSON(safePath(root,'migration/config.json'));
  Object.assign(config,{sourceLanguage:'C#',targetLanguage:'Java',sourceRoots:['source'],outputRoots:['ported'],verificationRoots:['checks'],maxReviewInputBytes:inputLimit,executionMode:'continuous',concurrency:2,phasePolicy:'strict'});
  writeJSON(safePath(root,'migration/config.json'),config);
  atomicWrite(safePath(root,'checks/README.md'),`${warning}\n`);
  initSourceSpec(root,config,{apply:true});
  return config;
}

function probe(root, kind) {
  const source = new Map(), fileRanges = new Map(), siteRanges = new Map(), requestHashes = [];
  let bytes=0,maxBytes=0;
  const raw = file => { if(!source.has(file))source.set(file,textBody(fs.readFileSync(safePath(root,file),'utf8')));return source.get(file); };
  const answer = async args => {
    const input=JSON.parse(args.reviewInput), size=Buffer.byteLength(args.reviewInput);
    assert.ok(size<=inputLimit,`oversized frozen input: ${size}`);bytes+=size;maxBytes=Math.max(maxBytes,size);requestHashes.push(hash(args.reviewInput));
    for(const file of input.files) {
      const body=raw(file.path), interval=input.fragment?[input.fragment.start,input.fragment.end]:[0,body.length];
      assert.equal(unnumber(file.content),body.slice(...interval),`source content changed in ${file.path}`);
      const ranges=fileRanges.get(file.path)??new Map();ranges.set(interval.join(':'),interval);fileRanges.set(file.path,ranges);
    }
    const evidence=file=>`${file.path}:${file.firstLine}-${file.lastLine}`;
    const items=kind==='contracts'?input.files.map(file=>({file:file.path,publicInterface:warning,inputsOutputsErrors:'unknown: transport probe',edgeCases:'unknown: transport probe',evidence:evidence(file),unknowns:warning}))
      :input.sites.map(site=>{
        const file=input.files.find(file=>file.path===site.file),body=raw(site.file),interval=input.fragment?[input.fragment.start,input.fragment.end]:[0,body.length];
        const ranges=siteRanges.get(keyOf(site))??new Set();ranges.add(interval.join(':'));siteRanges.set(keyOf(site),ranges);
        return {...site,classification:'UNKNOWN',status:'unknown',target_translation:`Preserve source representation; TODO(port): ${warning}`,evidence:evidence(file)};
      });
    return {result:{schemaVersion:1,kind:'survey',survey:kind,target:args.unit.target,items}};
  };
  const verify = files => {
    assert.equal(fileRanges.size,files.length);
    for(const file of files) {
      const ranges=[...fileRanges.get(file).values()].sort((a,b)=>a[0]-b[0]);let end=0;
      for(const range of ranges){assert.equal(range[0],end,`gap/overlap in ${file}`);end=range[1];}
      assert.equal(end,raw(file).length,`source coverage incomplete: ${file}`);
    }
    for(const [key,ranges] of siteRanges) {
      const [file]=JSON.parse(key),expected=new Set(fileRanges.get(file).keys());assert.deepEqual(ranges,expected,`a census site missed source fragments: ${key}`);
    }
    return {files:fileRanges.size,sites:siteRanges.size,requests:requestHashes.length,requestBytes:bytes,maxRequestBytes:maxBytes,sourceCharacters:[...source.values()].reduce((n,s)=>n+s.length,0)};
  };
  return {answer,verify,requestHashes};
}

async function verifyProject(meta) {
  const base=path.join(directory,meta.id),root=path.join(base,'utf8-project'),config=setup(root),stage={};
  log(meta.id,'dependency map → manifest → review dependency declaration');
  const commands=sourceSpecReadiness(root,config).commands;
  for(const [name,command] of Object.entries(commands)) {
    const run=await timer(()=>runProcess('bash',['-c',command.replace('.SOURCE_EXT=.TARGET_EXT','.cs=.java')],{cwd:root}));
    fs.writeFileSync(path.join(base,`${name}.stdout.log`),run.value.stdout);fs.writeFileSync(path.join(base,`${name}.stderr.log`),run.value.stderr);
    assert.equal(run.value.code,0,`${name}: ${run.value.stderr}`);stage[name]={seconds:run.seconds};
  }
  const units=readManifest(root,config);assert.equal(units.length,meta.csharpFiles);
  const edges=fs.readFileSync(safePath(root,'migration/depmap/edges.tsv'),'utf8').trimEnd().split('\n').slice(1);
  const unresolved=fs.readFileSync(safePath(root,'migration/depmap/unresolved.tsv'),'utf8').trimEnd().split('\n').slice(1);
  stage.dependencyMap={...stage.dependencyMap,files:units.length,edges:edges.length,unresolved:unresolved.length};

  log(meta.id,'00b contracts: full selected text coverage, conservative transport answers');
  const plan=planSurvey(root,config,'contracts');assert.equal(plan.skipped.length,0);
  const contracts=probe(root,'contracts'),run=await timer(()=>runSurvey(root,config,'contracts',contracts.answer));
  assert.equal(run.value.complete,true);
  stage.contracts={seconds:run.seconds,...contracts.verify(plan.scopes.flatMap(s=>s.files)),scopes:run.value.total,liveModelCalls:0};
  const merged=mergeSurvey(root,config,'contracts');stage.contracts.outputBytes=fs.statSync(safePath(root,merged.out)).size;
  const again=await timer(()=>runSurvey(root,config,'contracts',async()=>assert.fail('completed contracts must be reused')));
  assert.equal(again.value.agentCalls,0);stage.contracts.resume={requests:0,seconds:again.seconds};

  log(meta.id,'02 mechanical census → inventory survey → review candidate');
  atomicWrite(safePath(root,'migration/RULEBOOK.md'),`# C# to Java — transport test policy\n${warning}\nKeep every unreviewed decision UNKNOWN with TODO(port); preserve source representation. No translation is authorized.\n`);
  const sites=[];
  for(const unit of units) {
    const text=fs.readFileSync(safePath(root,unit.source),'utf8');let line=1,column=1,at=0,found=false;
    for(const match of text.matchAll(/\b(?:decimal|DateTime|StringComparison|CultureInfo|Encoding|checked|unchecked|unsafe|DllImport|lock|async|Task|IDisposable|event|dynamic|string|char|ref|out)\b/g)) {
      const between=text.slice(at,match.index).replace(/\r\n|\r/g,'\n'),parts=between.split('\n');
      line+=parts.length-1;column=parts.length>1?parts.at(-1).length+1:column+between.length;
      sites.push({file:unit.source,symbol:`L${line}:C${column}`,source_construct:match[0]});found=true;
      at=match.index+match[0].length;column+=match[0].length;
    }
    if(!found)sites.push({file:unit.source,symbol:'whole-file',source_construct:'unclassified-source-boundary'});
  }
  const sitesFile='migration/inventory-sites.tsv';atomicWrite(safePath(root,sitesFile),'file\tsymbol\tsource_construct\n'+sites.map(s=>[s.file,s.symbol,s.source_construct].join('\t')).join('\n')+'\n');
  const inventoryPlan=planSurvey(root,config,'inventory',{sitesFile}),inventory=probe(root,'inventory');assert.equal(inventoryPlan.skipped.length,0);
  const inventoryRun=await timer(()=>runSurvey(root,config,'inventory',inventory.answer,{sitesFile}));
  assert.equal(inventoryRun.value.complete,true);assert.equal(inventory.verify(inventoryPlan.scopes.flatMap(s=>s.files)).sites,sites.length);
  stage.inventory={seconds:inventoryRun.seconds,...inventory.verify(inventoryPlan.scopes.flatMap(s=>s.files)),scopes:inventoryRun.value.total,censusMode:'all raw-text matches of the documented construct vocabulary plus file fallback; not a semantic-completeness proof',liveModelCalls:0};
  const official=safePath(root,'migration/inventory.tsv'),before=fileHash(official);
  assert.throws(()=>mergeSurvey(root,config,'inventory',{sitesFile}),/Phase 01 is not reviewed/);
  assert.equal(fileHash(official),before,'an unreviewed run cannot publish formal inventory');
  const shards=inventoryPlan.scopes.map(s=>`migration/inventory-shards/survey-${s.id}.tsv`);
  const preview=await timer(()=>previewInventory(root,config,{sites:sitesFile,shards}));
  assert.equal(preview.value.uniqueSites,sites.length);assert.equal(preview.value.unknown,sites.length);
  stage.inventory.preview={seconds:preview.seconds,sites:preview.value.uniqueSites,unknown:preview.value.unknown,outputHash:preview.value.outputHash};
  assert.ok(!fs.existsSync(safePath(root,'migration/phases/02.json')));
  stage.phase02={completed:false,formalInventoryPublished:false,reason:'Live semantic survey, independent preparation audits and human gates have not run'};

  log(meta.id,'largest real file: manual interruption and validated-part resume');
  const largest=meta.largestCsharp[0],resumeRoot=path.join(base,'large-resume-project');fs.mkdirSync(path.join(resumeRoot,'source'),{recursive:true});
  const large=fs.readFileSync(safePath(root,`source/${largest.file}`));atomicWrite(path.join(resumeRoot,'source/Large.cs'),large);
  const resumeConfig=setup(resumeRoot),controller=new AbortController(),first=probe(resumeRoot,'contracts');
  await assert.rejects(runSurvey(resumeRoot,resumeConfig,'contracts',async args=>{
    if(first.requestHashes.length===2){controller.abort();throw new Error('Interrupted by explicit test signal');}
    return first.answer(args);
  },{signal:controller.signal}),/Interrupted/);
  assert.equal(surveyStatus(resumeRoot,resumeConfig,'contracts').complete,false);
  const resumed=probe(resumeRoot,'contracts');await runSurvey(resumeRoot,resumeConfig,'contracts',resumed.answer);
  assert.ok(resumed.requestHashes.every(h=>!first.requestHashes.includes(h)),'a validated fragment was called again');
  assert.equal(surveyStatus(resumeRoot,resumeConfig,'contracts').complete,true);
  stage.largestResume={file:largest.file,originalBytes:largest.bytes,utf8Bytes:large.length,preservedParts:first.requestHashes.length,resumedRequests:resumed.requestHashes.length,repeatedValidatedRequests:0};

  const census=Array.from({length:628},(_,i)=>({file:'source/Large.cs',symbol:`mechanical-line-${i+1}`,source_construct:'source-line-audit'}));
  const scope=planSurvey(resumeRoot,resumeConfig,'contracts').scopes[0],source=JSON.parse(surveyInput(resumeRoot,resumeConfig,'contracts',scope).text).files;
  const denseData={schemaVersion:1,kind:'inventory',task:'Inventory transport stress only',rulebook:warning,sites:census,files:source,scope:'dense',sourceLanguage:'C#',targetLanguage:'Java'};
  const parts=surveyRequests('inventory',{scope:{id:'dense',files:['source/Large.cs']},input:{text:JSON.stringify(denseData),sites:census}},inputLimit);
  stage.dense628={requests:parts.length,maxRequestBytes:Math.max(...parts.map(p=>Buffer.byteLength(p.input.text))),note:'real largest file with a synthetic 628-site load; no live model calls'};
  const normalization=readJSON(path.join(base,'normalization.json'));
  const result={id:meta.id,repository:meta.repository,tag:meta.tag,commit:meta.commit,archiveSha256:meta.archiveSha256,csharpFiles:meta.csharpFiles,csharpBytes:meta.csharpBytes,largeCsharpFiles:units.filter(u=>fs.statSync(safePath(root,u.source)).size>inputLimit).length,normalizedCsharp:normalization.convertedCsharpFiles,stages:stage,semanticStep02Completed:false};
  writeJSON(path.join(base,'verification.json'),result);log(meta.id,'mechanical probes passed; semantic step 02 remains unverified');return result;
}

const startedAt=new Date().toISOString(),results=[];
for(const meta of corpus)results.push(await verifyProject(meta));
const report={schemaVersion:1,kind:'legacy-csharp-oss-transport-verification',startedAt,finishedAt:new Date().toISOString(),kitHead:'0e3c71b plus working-tree fixes',liveModelCalls:0,semanticStep02Completed:false,networkBlock:'Copilot models.list: api.individual.githubcopilot.com tunnel error',scope:'All C# sources plus project/config/license text. Original archives preserved. UTF-8 working copies use explicit benchmark-only cp1252/BOM assumptions; no binaries, markup or original execution.',results};
writeJSON(reportPath,report);console.log(JSON.stringify({report:reportPath,projects:results.length,csharpFiles:results.reduce((n,r)=>n+r.csharpFiles,0),semanticStep02Completed:false}));
