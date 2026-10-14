// Offline fixed-delay simulation of host dispatch policies, not real AI timing.
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {prepare,result} from '../../tests/helpers.mjs';
import {writeJSON,safePath,atomicWrite} from '../../lib/core.mjs';
import {approve,runStage,translate} from '../../lib/pipeline.mjs';
import {createNativeAdapter,listNativeTasks,claimNativeTask,submitNativeTask} from '../../lib/native-workers.mjs';

const labels={'ported/math_ops.mjs':'A','ported/text_ops.mjs':'B','ported/main.mjs':'C'};
const milliseconds={A:100,B:1800,C:1200};
async function measure(policy){
  const f=prepare(null,{count:3});
  const abort=new AbortController();
  let settled=false,completed,maxActive=0,active=0,run;
  const trace=[],inflight=new Map();
  try{
    Object.assign(f.config,{workerBackend:'native',nativeHarness:'vscode-local',concurrency:2,timeoutSeconds:15});
    f.config.commands.typecheck=null;
    writeJSON(safePath(f.root,'migration/config.json'),f.config);
    // C depends only on A; B is an unrelated long-running job.
    atomicWrite(safePath(f.root,'src/main.py'),'from math_ops import divide\n');
    writeJSON(safePath(f.root,'migration/review-dependencies.json'),{schemaVersion:1,dependencies:{
      'src/math_ops.py':[],'src/text_ops.py':[],'src/main.py':['src/math_ops.py']}});
    await runStage(f.root,f.config,'judge');
    approve(f.root,f.config,'translation','Offline fixed-delay dispatch simulation only');
    const start=performance.now();
    const elapsed=()=>Math.round(performance.now()-start);
    run=translate(f.root,f.config,createNativeAdapter({pollMs:5}),{signal:abort.signal})
      .then(report=>{completed={report};},error=>{completed={error};}).finally(()=>{settled=true;});
    function launch(descriptor){
      const task=claimNativeTask(f.root,descriptor.task),unit=labels[task.unit.target];
      active++;maxActive=Math.max(maxActive,active);
      trace.push({event:'start',unit,role:task.role,ms:elapsed()});
      const state={task,done:false};
      state.promise=delay(task.role==='implementer'?milliseconds[unit]:50).then(()=>{
        active--;state.done=true;trace.push({event:'finish',unit,role:task.role,ms:elapsed()});
      });
      inflight.set(task.task,state);return state;
    }
    function submit(state){
      const task=state.task,unit=labels[task.unit.target];
      const response=result(task.role,task.unit,task.role==='implementer'&&unit==='C'
        ?{content:'export { divide } from "./math_ops.mjs";\n// PORT STATUS: complete; fixed simulation\n'}:{});
      submitNativeTask(f.root,task.task,task.claimToken,{result:response,model:task.model});
      trace.push({event:'submit',unit,role:task.role,ms:elapsed()});
      inflight.delete(task.task);
    }
    while(!settled){
      if(policy==='background')for(const state of [...inflight.values()])if(state.done)submit(state);
      const pending=listNativeTasks(f.root).tasks.filter(t=>t.status==='pending');
      if(policy==='serial'&&pending.length){const state=launch(pending[0]);await state.promise;submit(state);}
      else if(policy==='batch'&&pending.length){
        const batch=pending.map(launch);await Promise.all(batch.map(s=>s.promise));batch.forEach(submit);
      }else if(policy==='background')pending.forEach(launch);
      await delay(5);
    }
    await run;if(completed.error)throw completed.error;
    const first=(unit,role,event)=>trace.find(t=>t.unit===unit&&t.role===role&&t.event===event)?.ms;
    return {policy,elapsedMs:elapsed(),maxConcurrentFakeWorkers:maxActive,agentCalls:completed.report.agentCalls,
      fastImplementationFinishedMs:first('A','implementer','finish'),fastImplementationSubmittedMs:first('A','implementer','submit'),
      dependentImplementationStartedMs:first('C','implementer','start'),trace};
  }finally{
    abort.abort();await run;await Promise.allSettled([...inflight.values()].map(s=>s.promise));
    fs.rmSync(f.root,{recursive:true,force:true});
  }
}
const results=[];
for(const policy of ['serial','batch','background'])results.push(await measure(policy));
const report={syntheticOnly:true,externalAI:false,actualCopilotToolsInvoked:false,
  scenario:'A short, B long and independent, C depends on reviewed A; two reviews per file',
  fixedImplementationMs:milliseconds,fixedReviewMs:50,concurrency:2,results};
fs.writeFileSync(process.argv[2] ?? '/tmp/copilot-parallel-queue-probe.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,results:results.map(({trace,...summary})=>summary)},null,2));
