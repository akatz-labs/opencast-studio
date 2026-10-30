import fs from 'node:fs';
import path from 'node:path';
import {ExecutorClient,closeExecutorConnections} from './executor-client.mjs';
import {bootstrapPlan,bootstrapExecutor} from '../vendor/shared-runtime/src/executor-bootstrap.mjs';
import {closeExecutorConnections as closeBootstrapConnections} from '../vendor/shared-runtime/src/executor-client.mjs';
import {runtimeProfiles,installationPlan} from './setup-plan.mjs';

const request=JSON.parse(fs.readFileSync(process.argv[2])),{configuration,configurationFile,statusFile,journalFile}=request;
let job={...request.job,pid:process.pid,status:'running'},journal=fs.existsSync(journalFile)?JSON.parse(fs.readFileSync(journalFile)):{};
const atomic=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.next',JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(file+'.next',file)};
const update=(message,progress,extra={})=>{job={...job,message,progress,...extra,updatedAt:new Date().toISOString()};atomic(statusFile,job)};
const pause=()=>new Promise(resolve=>setTimeout(resolve,1500));
const client=new ExecutorClient(configuration.target);
async function waitJob(id,type){
 while(true){
  const row=type==='installation'?await client.job(id):(await client.json('/v1/resources/opencast/jobs')).items.find(j=>j.id===id);
  if(!row)throw new Error('Saved setup receipt is unavailable; inspect the executor before retrying.');
  const state=row.phase||row.status;
  if(['completed','succeeded'].includes(state))return row;
  if(['failed','cancelled','uncertain','interrupted'].includes(state))throw new Error(row.error||'Setup '+state);
  update(row.activity||row.message||'Installing resources',job.progress,{workerJobId:id});await pause();
 }
}
try{
 update('Connecting to the selected executor',0.01);
 let health;
 try{health=await client.health()}catch(error){
  if(configuration.target.kind!=='local'||configuration.executorId)throw new Error('The configured executor is offline. Restore that connection before setup.');
  if(error.status)throw new Error('The local executor port is occupied by an incompatible service. It was preserved.');
  update('Installing the shared local worker',0.03);
  const plan=await bootstrapPlan(configuration.target,{requiredCapabilities:['model-resources-v1']});
  health=await bootstrapExecutor(plan,plan.digest);
 }
 if(configuration.executorId&&health.executorId!==configuration.executorId)throw new Error('Executor identity changed; setup did not touch the replacement worker.');
 configuration.executorId=health.executorId;
 if(journal.executorId&&journal.executorId!==health.executorId)throw new Error('Saved setup belongs to another executor.');
 journal.executorId=health.executorId;atomic(journalFile,journal);atomic(configurationFile,configuration);
 update('Registering model requirements',0.06,{executorId:health.executorId});
 const catalog=JSON.parse(fs.readFileSync(new URL('../resources/models.json',import.meta.url))),downloadable=catalog.models.filter(m=>m.acquisition==='download');
 await client.json('/v1/resources',catalog);
 const inventory=await client.json('/v1/resources/opencast',undefined,'GET',{signal:AbortSignal.timeout(300000)});
 const selectedRoot=configuration.settings.modelsRoot||inventory.storage?.path;
 if(selectedRoot&&selectedRoot!==inventory.storage?.path){
  update('Selecting and indexing the model folder',0.08);
  // The shared executor checks active jobs and updates ComfyGit paths. It does
  // not move or delete files from the previous folder.
  const storageJob=await client.json('/v1/resources/opencast/storage',{path:selectedRoot});
  await waitJob(storageJob.id,'resource');
 }
 if(selectedRoot){configuration.settings.modelsRoot=selectedRoot;atomic(configurationFile,configuration)}
 const rootChanged=journal.modelsRoot!==selectedRoot;
 if(rootChanged){
  if(journal.downloadId){const oldJob=(await client.json('/v1/resources/opencast/jobs')).items.find(j=>j.id===journal.downloadId);if(oldJob&&['queued','running'].includes(oldJob.status))await waitJob(oldJob.id,'resource')}
  journal.downloadId=null;journal.downloadPending=null;journal.modelsRoot=selectedRoot;atomic(journalFile,journal);
 }
 for(const [index,profile] of runtimeProfiles.entries()){
  update('Preparing '+profile.name,0.1+index*0.2);
  const prepared=await installationPlan(client,profile,configuration.settings),key=prepared.installation.id;
  let saved=journal[key];
  if(!saved){saved={planId:prepared.plan.id,digest:prepared.plan.digest,installationId:key};journal[key]=saved;atomic(journalFile,journal)}
  // Exact plan replay reconciles acceptance; a lost response does not create a
  // second installation or replace an existing environment.
  const admitted=await client.json('/v1/install',{planId:saved.planId,digest:saved.digest});
  if(admitted.job)await waitJob(admitted.job.id,'installation');
  else if(!admitted.readiness?.ready)throw new Error('Installed environment needs repair; existing files were preserved.');
  saved.complete=true;atomic(journalFile,journal);
  update('Refreshing the shared model index',0.25+index*0.2);
  const {workspace,modelsRoot,pythonExecutable,cgExecutable,environment}=prepared.installation.configuration;
  await client.json('/v1/resources/opencast/settings',{workspace,modelsRoot,pythonExecutable,cgExecutable,environment},'POST',{signal:AbortSignal.timeout(300000)});
 }
 update('Installing missing models into shared storage',0.6);
 const old=(await client.json('/v1/resources/opencast/jobs')).items;
 let download=journal.downloadId?old.find(j=>j.id===journal.downloadId):null;
 if(journal.downloadPending&&!download){
  const candidates=old.filter(j=>j.kind==='download'&&JSON.stringify(j.resourceIds)===JSON.stringify(journal.downloadIds)&&Date.parse(j.createdAt)>=Date.parse(journal.downloadPending));
  if(candidates.length!==1)throw new Error('Model download acceptance is uncertain. Inspect the executor before retrying.');download=candidates[0];
 }
 if(download&&JSON.stringify(journal.downloadIds)!==JSON.stringify(downloadable.map(m=>m.id))){await waitJob(download.id,'resource');download=null;journal.downloadId=null;journal.downloadPending=null;atomic(journalFile,journal)}
 if(download&&(['failed','cancelled'].includes(download.status)||download.status==='succeeded'&&inventory.models.some(m=>downloadable.some(d=>d.id===m.id)&&m.state!=='installed'))){download=null;journal.downloadPending=null;journal.downloadId=null;atomic(journalFile,journal)}
 if(!download){
  journal.downloadIds=downloadable.map(m=>m.id);journal.downloadPending=new Date().toISOString();atomic(journalFile,journal);
  download=await client.json('/v1/resources/opencast/download',{resourceIds:journal.downloadIds});journal.downloadId=download.id;journal.downloadPending=null;atomic(journalFile,journal);
 }
 await waitJob(download.id,'resource');
 const finalInventory=await client.json('/v1/resources/opencast',undefined,'GET',{signal:AbortSignal.timeout(300000)});
 const pending=catalog.models.filter(m=>m.acquisition==='manual'&&!finalInventory.models.some(row=>row.id===m.id&&row.state==='installed')).map(m=>m.name);
 update(pending.length?'Runtimes and public models installed. Download the gated models from their linked Hugging Face pages, then Scan models: '+pending.join(', ')+'.':'Runtimes, models and motion workflows are ready.',1,{status:pending.length?'blocked':'succeeded',pending,workerJobId:null});
}catch(error){update(error.message,job.progress||0,{status:'failed',error:error.message})}
finally{await closeExecutorConnections();await closeBootstrapConnections()}
