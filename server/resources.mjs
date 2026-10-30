import fs from 'node:fs';
import {z} from 'zod';
import {ExecutorClient} from './executor-client.mjs';
import {fail} from './api-state.mjs';
import path from 'node:path';
import {dataDirectory} from './deployment.mjs';
import {setupService} from './setup.mjs';
import {modelStorageRoot} from '../vendor/shared-runtime/src/index.mjs';

const target=z.strictObject({kind:z.enum(['local','ssh']),port:z.number().int().min(1).max(65535).default(8841),host:z.string().regex(/^(?:[\w.-]+@)?[\w.-]+$/).optional(),sshPort:z.number().int().min(1).max(65535).optional()}).refine(v=>v.kind!=='ssh'||!!v.host,'SSH target requires a host');
const configSchema=z.strictObject({target,executorId:z.string().min(1).optional(),name:z.string().min(1).max(80).default('Configured executor'),settings:z.record(z.string(),z.string()).default({})}).refine(v=>v.target.kind==='local'||!!v.executorId,'Remote executors require a pinned identity');
const statusSchema=z.object({models:z.array(z.object({id:z.string(),state:z.string(),verified:z.boolean().optional()}).passthrough()),storage:z.object({freeBytes:z.number().nullable(),path:z.string().optional()}).passthrough().optional(),runtimes:z.array(z.object({id:z.string(),name:z.string(),installed:z.boolean(),detail:z.string().optional()}).passthrough()).default([])});
const jobsSchema=z.object({items:z.array(z.object({id:z.string(),status:z.string(),kind:z.string(),progress:z.number().nullable().optional(),message:z.string().optional(),error:z.string().nullable().optional()}).passthrough())});
export {resourceAction} from './resource-contract.mjs';

export function resourceService({configuration,client,setup,catalog=JSON.parse(fs.readFileSync(new URL('../resources/models.json',import.meta.url)))}){
 const config=configuration?configSchema.parse(configuration):null;
 const worker=client||(config?new ExecutorClient(config.target):null),base='/v1/resources/'+catalog.appId;
 async function identity(){
  if(!worker||!config)throw fail(409,'Configure a shared executor before managing models.');
  const health=await worker.json('/v1/health',undefined,'GET');
  if((config.executorId||setup?.status()?.executorId)&&health.executorId!==(config.executorId||setup?.status()?.executorId))throw fail(409,'Executor identity changed. Check the backend configuration before continuing.');
  return health;
 }
 const models=(inventory=[])=>catalog.models.map(model=>{
  const row=inventory.find(r=>r.id===model.id);
  return {...model,state:row?.state||'unknown',verified:row?.verified||false};
 });
 let pending=null,cached=null,observedAt=0;
 async function inspect(){
   if(!config)return {connection:'unconfigured',executorName:'No executor configured',message:'Set OPENCAST_RESOURCE_CONFIG on the backend to connect a shared executor.',models:models(),jobs:[],runtimes:[],storage:null};
   try{
    await identity();
    const inventory=statusSchema.parse(await worker.json(base,undefined,'GET',{signal:AbortSignal.timeout(300000)}));
    const jobs=jobsSchema.parse(await worker.json(base+'/jobs')).items;
    const installations=z.array(z.object({ready:z.boolean(),installation:z.object({configuration:z.object({profile:z.string().optional()}).passthrough()}).passthrough()})).parse(await worker.json('/v1/installations?appId=opencast'));
    const dependenciesReady=['krea','pika'].every(profile=>installations.some(i=>i.ready&&i.installation.configuration.profile===profile));
    return {connection:'connected',dependenciesReady,executorName:config.name,models:models(inventory.models),jobs:jobs.map(({id,status,kind,progress,message,error})=>({id,status,kind,progress,message,error})),runtimes:inventory.runtimes.map(({id,name,installed,detail})=>({id,name,installed:installed||(id==='comfyui'&&dependenciesReady),detail:id==='comfyui'&&dependenciesReady?'Pinned runtime installed; starts when generating.':detail})),storage:inventory.storage?{freeBytes:inventory.storage.freeBytes,path:inventory.storage.path}:null};
   }catch(error){
    return {connection:error.status===404?'unregistered':error.status===409?'mismatch':'offline',executorName:config.name,message:error.status===404?'Connect this model catalog to the executor.':error.status===409?error.message:config.target.kind==='local'?'Select Install missing to set up the worker on this machine.':'The configured remote executor is unavailable. Restore its connection before installing.',models:models(),jobs:[],runtimes:[],storage:null};
   }
  }
 return {
  async snapshot({refresh=false}={}){
   const setupJob=setup?.status();
   const decorate=value=>{
    const modelPath=config?.settings.modelsRoot||value.storage?.path||(config?.target.kind==='local'?modelStorageRoot():null);
    const folderChanged=!!(config?.settings.modelsRoot&&value.storage?.path&&config.settings.modelsRoot!==value.storage.path);
    const ready=value.connection==='connected'&&value.dependenciesReady&&value.models.every(m=>m.state==='installed')&&!folderChanged;
    const state=value.connection==='checking'?'checking':ready?'ready':value.connection==='offline'&&setupJob?.status==='succeeded'?'unavailable':'required';
    return {...value,executorKind:config?.target.kind||'local',setupAvailable:!!setup,setupJob,modelDirectory:{path:modelPath,currentPath:value.storage?.path||null,pending:folderChanged},onboarding:{state,message:state==='ready'?'Runtime and model checks passed.':folderChanged?'Select Install missing to apply the model folder and check its contents.':state==='required'?'Set up the runtimes and models before generating.':state==='unavailable'?'The configured worker is offline.':'Checking setup…'}};
   };
   if(refresh)observedAt=0;
   if(cached&&Date.now()-observedAt<300000){
    if(cached.connection==='connected'){
     try{
      const jobs=jobsSchema.parse(await worker.json(base+'/jobs',undefined,'GET',{signal:AbortSignal.timeout(5000)})).items.map(({id,status,kind,progress,message,error})=>({id,status,kind,progress,message,error}));
      if(cached.jobs.some(j=>['queued','running'].includes(j.status))&&!jobs.some(j=>['queued','running'].includes(j.status)))observedAt=0;
      cached={...cached,jobs};
     }catch{observedAt=0;} // Recheck the connection through inspect below.
    }
    if(Date.now()-observedAt<300000)return decorate(cached);
   }
   if(!pending)pending=inspect().then(result=>{cached=result;observedAt=Date.now();return result}).finally(()=>{pending=null});
   // Large shared indexes can take time to inspect. Keep the UI responsive and
   // coalesce all callers onto one read instead of starting repeated scans.
   let timer;
   const waiting=new Promise(resolve=>{timer=setTimeout(()=>resolve(cached||{connection:'checking',executorName:config?.name||'Configured executor',message:'Checking the shared model index…',models:models(),jobs:[],runtimes:[],storage:null}),500)});
   try{return decorate(await Promise.race([pending,waiting]))}finally{clearTimeout(timer)}
  },
  async action(input){
   cached=null;observedAt=0;
   try{
    if(input.action==='model-folder'){if(!setup)throw fail(409,'Model folder configuration is unavailable.');setup.configureModelsRoot(input.path);config.settings.modelsRoot=input.path;return {accepted:true}}
    if(input.action==='setup'){if(!setup)throw fail(409,'Automatic setup is unavailable on this backend.');return setup.start()}
    await identity();
    if(input.action==='initialize'){
     await worker.json('/v1/resources',catalog);
     const {jobLauncher,...resourceSettings}=config.settings;
     if(Object.keys(resourceSettings).length)await worker.json(base+'/settings',resourceSettings);
     return {accepted:true};
    }
    if(input.action==='scan')return await worker.json(base+'/scan',{});
    if(new Set(input.resourceIds).size!==input.resourceIds.length)throw fail(400,'Choose each resource once.');
    for(const id of input.resourceIds){const model=catalog.models.find(m=>m.id===id);if(!model)throw fail(400,'Unknown model.');if(model.acquisition==='manual')throw fail(409,'Download this gated model from its linked source and scan the model folder.');}
    return await worker.json(base+'/download',{resourceIds:input.resourceIds});
   }catch(error){if(error.status)throw error;throw fail(503,'The executor did not confirm this action. Refresh its status before retrying.');}
  },
 };
}

export function configuredResources(){
 const location=process.env.OPENCAST_RESOURCE_CONFIG||path.join(dataDirectory,'resources.json');
 const configuration=configSchema.parse(fs.existsSync(location)?JSON.parse(fs.readFileSync(location)):{target:{kind:'local',port:8841},name:'This machine'});
 const setup=setupService({directory:dataDirectory,configuration,configurationFile:location});
 return resourceService({configuration,setup});
}
