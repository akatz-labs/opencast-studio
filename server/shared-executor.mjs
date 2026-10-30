import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ExecutorClient} from './executor-client.mjs';
import {atomicJson,digest,fail,serial} from './api-state.mjs';
import {compileCharacterSheet} from '../shared/prompt.mjs';

const terminal=new Set(['complete','failed','cancelled','uncertain']);
const phases={completed:'complete',preparing:'preparing',rendering:'running',finalizing:'retaining',queued:'queued-worker',failed:'failed',cancelled:'cancelled',uncertain:'uncertain'};
// Configuration and recipe modules are trusted server files, never request input.
// Each recipe prepares the pinned installation's inputs and names its output roles.
export function sharedExecutor({directory,assets,configuration,recipes,storage,client=new ExecutorClient(configuration.target)}){
 const ledger=path.join(directory,'shared-jobs.json'),jobs=fs.existsSync(ledger)?JSON.parse(fs.readFileSync(ledger)):[];
 const save=()=>atomicJson(ledger,jobs),lock=serial();let busy=false;
 const own=(id,owner)=>{const j=jobs.find(j=>j.id===id&&j.owner===owner);if(!j)throw fail(404,'Job not found.');return j};
 async function present(j){
  const outputs={};for(const [role,output] of Object.entries(j.outputs||{}))outputs[role]=await assets.output(j.owner,`shared:${j.id}:${role}`,output);
  for(const [input,role] of Object.entries({video:'source',character:'reference',background:'background'})){
   const id=j.request.inputs?.[input];if(id)outputs[role]={assetId:id,access:await assets.access(id,j.owner)};
  }
  return {id:j.id,kind:j.request.kind,name:j.name,status:j.status,createdAt:j.createdAt,requestKey:j.request.idempotencyKey,details:j.details||{},outputs,...(j.error?{error:j.error}:{})};
 }
 async function progress(j){
  const recipe=recipes[j.request.kind];
  const boundClient=client.target?new ExecutorClient(j.binding.target):client;
  if(!j.plan&&!recipe)throw fail(503,'Waiting for the configured worker.');
  if(!j.plan&&(recipe.revision!==j.binding.revision||recipe.installationId!==j.binding.installationId))throw fail(409,'Pinned recipe changed before preparation; this job requires reconciliation.');
  if(!j.plan){
   const inputFiles=Object.fromEntries(Object.entries(j.request.inputs||{}).map(([role,id])=>[role,assets.get(id,j.owner).storage.path]));
   const dir=path.join(directory,'jobs',j.id);fs.mkdirSync(dir,{recursive:true});
   const plan=await recipe.prepare({request:j.request,jobId:j.id,inputFiles,directory:dir});
   j.plan={...plan,appId:j.binding.appId,instanceId:j.binding.instanceId,executorId:j.binding.executorId,installationId:j.binding.installationId,feature:j.binding.feature,revision:recipe.revision,outputs:recipe.outputs};
   j.details={...j.details,...plan.details};save();
  }
  if(!j.admission){
   const files=[];for(const [name,source] of Object.entries(j.plan.files))files.push(await boundClient.upload(source,name));
   j.admission={appId:j.plan.appId,instanceId:j.plan.instanceId,sourceJobId:j.id,executorId:j.plan.executorId,installationId:j.plan.installationId,feature:j.plan.feature,inputs:j.plan.inputs,files};
   // The shared executor deduplicates this exact source identity and request digest.
   j.admissionDigest=digest(j.admission);j.status='submitting';save();
  }
  let remote;
  if(j.remoteId)remote=await boundClient.job(j.remoteId);
  else{
   remote=await boundClient.submit(j.admission);
   j.remoteId=remote.id;save();
  }
  if(remote.executorId!==j.plan.executorId||remote.sourceJobId!==j.id||remote.instanceId!==j.plan.instanceId)throw fail(409,'Executor receipt identity differs.');
  if(!phases[remote.phase])throw fail(409,'Unknown executor phase.');
  if(remote.phase==='completed'&&!j.outputs){
   j.status='retaining';save();const outputs={};
   if(storage&&!j.outputAllocation){j.outputAllocation=await storage('begin-write','--expected-bytes',String(remote.result.files.reduce((n,f)=>n+f.size,0)+1048576),'--key','opencast-motion-'+j.id);save()}
   const outputDirectory=j.outputAllocation?.path||path.join(directory,'jobs',j.id);fs.mkdirSync(outputDirectory,{recursive:true});
   for(const [role,spec] of Object.entries(j.plan.outputs)){
    const output=remote.result?.files?.find(f=>f.name===spec.name);if(!output)throw fail(409,`Missing contracted ${role} output.`);
    if(!/^[\w.-]+$/.test(spec.name))throw fail(409,'Output name must be a basename.');
    const dest=path.join(outputDirectory,spec.name);
    await boundClient.download(remote.id,output,dest); // SDK verifies size and SHA256.
    outputs[role]={kind:spec.contentType.startsWith('video/')?'video':spec.contentType.startsWith('image/')?'image':'document',contentType:spec.contentType,name:spec.name,bytes:output.size,sha256:output.hash,storage:{path:dest}};
   }
   // Retain the complete provenance, not only the browser's selected roles.
   for(const output of remote.result.files){if(!/^[\w.-]+$/.test(output.name))throw fail(409,'Unsafe output name.');if(!Object.values(j.plan.outputs).some(s=>s.name===output.name))await boundClient.download(remote.id,output,path.join(outputDirectory,output.name))}
   if(storage)j.storageVersion=(await storage('commit-write',j.outputAllocation.id,'--source-key','opencast-motion-'+j.id,'--key','opencast-motion-'+j.id,'--kind','media')).version_id;
   j.details={...j.details,...remote.result.details};
   j.outputs=outputs;
  }
  j.status=phases[remote.phase];j.error=remote.error;j.details.activity=remote.activity;save();
 }
 return {
  async capabilities(){return {operations:Object.fromEntries(['character','character-swap','motion-transfer'].map(kind=>[kind,{available:!!recipes[kind],...(!recipes[kind]?{reason:'No pinned workflow installation configured.'}:{})}])),authentication:'local',billing:false}},
  async list(owner,kind){return Promise.all(jobs.filter(j=>j.owner===owner&&(!kind||j.request.kind===kind)).slice().reverse().map(present))},
  async get(id,owner){return present(own(id,owner))},
  async importAsset(ref,owner){
   if(ref.kind!=='generated')throw fail(409,'This runner has no example catalog configured. Upload a character sheet or use a generated character.');
   const j=await present(own(ref.id,owner)),role={sheet:'image',body:'full-body',portrait:'portrait',manifest:'manifest'}[ref.role||'sheet'];if(j.status!=='complete'||!j.outputs[role])throw fail(409,'Choose a completed character sheet.');
   return {id:j.outputs[role].assetId,status:'ready'};
  },
  async submit(request,owner){return lock(async()=>{
   const previous=jobs.filter(j=>j.owner===owner&&j.request.idempotencyKey===request.idempotencyKey);
   if(previous.length){if(previous[0].fingerprint!==digest(request))throw fail(409,'Request key belongs to different settings.');return Promise.all(previous.map(present))}
   if(!recipes[request.kind])throw fail(409,'Workflow not configured.');
   const count=request.kind==='character'?request.parameters.batchSize:1,created=[];
   for(let index=0;index<count;index++){
    const frozen=structuredClone(request);if(frozen.kind==='character'){frozen.parameters.seed=(request.parameters.seed+index)%2147483648;if(frozen.parameters.bodySeed!==undefined)frozen.parameters.bodySeed=(frozen.parameters.bodySeed+index)%2147483648;frozen.parameters.batchSize=1}
    const matching=jobs.filter(j=>j.owner===owner&&j.request.kind===request.kind);
    const number=request.kind==='character'?Math.max(configuration.characterNumberFloor||0,0,...matching.map(j=>j.details.number))+1:matching.length+1;
    const recipe=recipes[request.kind];
    const binding={target:configuration.target,appId:configuration.appId||'opencast',instanceId:configuration.instanceId,executorId:configuration.executorId,installationId:recipe.installationId,feature:recipe.feature,revision:recipe.revision};
    let details;
    if(frozen.kind==='character'){
     const p=frozen.parameters,{compiled,prompt,fullBodyPrompt}=compileCharacterSheet(p.traits,p);
     details={...p,number,batchId:request.idempotencyKey,batchIndex:index+1,compiled,prompt,fullBodyPrompt,templateVersion:compiled.version,manualPrompt:!!p.promptOverride,framing:'character-sheet',width:2048,height:1536,cfg:1,passes:2};
    }else{
     const source=assets.get(frozen.inputs.video,owner),reference=assets.get(frozen.inputs.character,owner);
     details={...frozen.parameters,target:frozen.parameters.prompt,sourceName:source.name,referenceName:reference.name,duration:source.metadata?.duration};
    }
    const j={id:crypto.randomUUID(),owner,binding,request:frozen,details,fingerprint:digest(request),name:`${request.kind==='character'?'Character':'Video'} ${number}`,status:'queued',createdAt:new Date().toISOString()};jobs.push(j);created.push(j);
   }
   save();return Promise.all(created.map(present));
  })},
  async tick(){if(busy)return;busy=true;try{await lock(async()=>{
   for(const j of jobs.filter(j=>!terminal.has(j.status))){
    try{await progress(j)}catch(error){j.error=error.status===409?error.message:'Waiting for the worker connection. This job is saved and will resume when the worker reconnects.';if(error.status===409)j.status='uncertain';else if(!j.admission)j.status='queued-worker';save();console.error('OpenCast shared executor:',error.message)}
   }
  })}finally{busy=false}},
  async cancel(id,owner){return lock(async()=>{
   const j=own(id,owner);if(terminal.has(j.status))throw fail(409,'Job is already terminal.');
   if(j.admission){const boundClient=client.target?new ExecutorClient(j.binding.target):client;const result=j.remoteId?await boundClient.cancel(j.remoteId):await boundClient.cancelAdmission(j.admission);j.remoteId=result.id;j.status=phases[result.phase];}
   else j.status='cancelled';save();return present(j);
  })},
  async rename(id,name,owner){const j=own(id,owner);j.name=name;save();return present(j)},
 };
}
