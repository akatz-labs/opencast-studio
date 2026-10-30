import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, writeFile, rename, stat, statfs, realpath, open, link, unlink, rm} from 'node:fs/promises';
import {dirname, join, resolve, isAbsolute, relative} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {readConfig} from './index.mjs';
import {executorSystem, runtimePaths} from './executor-setup.mjs';

const ACTIVE=new Set(['queued','running']);
const ID=/^[a-z0-9][a-z0-9._-]{0,99}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const failure=(message,status=409)=>Object.assign(new Error(message),{status});
const safeId=value=>{if(!ID.test(value || ''))throw failure('Invalid resource identifier',400);return value;};
const contained=(root,path)=>{const result=resolve(root,path),rel=relative(resolve(root),result);if(!rel || rel.startsWith('..') || isAbsolute(rel))throw failure('Invalid resource path',400);return result;};
async function atomic(path,value){await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await rename(temp,path);}
async function disk(path){let at=path;while(!await stat(at).catch(()=>null)){const parent=dirname(at);if(parent===at)return {freeBytes:null,totalBytes:null};at=parent;}const s=await statfs(at);return {freeBytes:s.bavail*s.bsize,totalBytes:s.blocks*s.bsize};}
const fileIdentity=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');

/** Model bytes and identity belong to the selected ComfyGit workspace. This
 * service adds shared acquisition jobs and verification receipts, never a
 * second model index. Both app servers and the launcher use its executor API. */
export class ModelResources {
  constructor(executor,{runBridge,fetchImpl=fetch}={}) {
    this.executor=executor;this.root=join(executor.root,'resources');this.bridge=(...args)=>{const task=this.bridgeQueue.catch(()=>{}).then(()=>this.bridgeWithRetry(runBridge || this.runBridge.bind(this),...args));this.bridgeQueue=task;return task;};this.fetch=fetchImpl;
    this.removalPlans=new Map();this.catalogs=new Map();this.jobs=new Map();this.controllers=new Map();this.queues=new Map();this.saves=Promise.resolve();this.receiptSaves=Promise.resolve();this.inventoryCache=new Map();this.indexingApps=new Set();this.inventoryTasks=new Map();this.bridgeQueue=Promise.resolve();
    this.ready=this.load();
  }
  async load(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    for(const [name,map] of [['catalogs',this.catalogs],['jobs',this.jobs]]){
      let records;try{records=JSON.parse(await readFile(join(this.root,name+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
      for(const row of records){if(name==='jobs'&&ACTIVE.has(row.status)){row.status='failed';row.error='Interrupted by resource-service restart. Scan existing files, then retry missing resources.';row.updatedAt=now();}map.set(name==='jobs'?row.id:row.appId,row);}
    }
    await this.save('jobs');
  }
  save(name){const body=[...(name==='jobs'?this.jobs:this.catalogs).values()];const task=this.saves.catch(()=>{}).then(()=>atomic(join(this.root,name+'.json'),body));this.saves=task;return task;}
  async register(input){
    await this.ready;safeId(input.appId);
    if(input.schemaVersion!==1 || !Array.isArray(input.models) || input.models.length>256 || !Array.isArray(input.features))throw failure('Invalid resources catalog',400);
    const ids=new Set();
    for(const model of input.models){
      safeId(model.id);if(ids.has(model.id))throw failure('Duplicate model identifier',400);ids.add(model.id);
      if(!['required','optional'].includes(model.requirement)||!Number.isSafeInteger(model.sizeBytes)||model.sizeBytes<1||!/^[a-f0-9]{64}$/.test(model.sha256)||!/^[a-f0-9]{16}$/.test(model.shortHash))throw failure('Models require pinned size and content identities',400);
      contained('/models',model.relativePath);if(isAbsolute(model.relativePath))throw failure('Model paths must be portable',400);
      if(model.acquisition==='manual'){
        if(typeof model.sourceNote!=='string' || !model.sourceNote.trim() || model.sourceNote.length>500)throw failure('Manual models require an acquisition note',400);
      }
      if(model.url!==undefined||model.acquisition!=='manual'){
        if(model.acquisition!==undefined&&model.acquisition!=='download'&&model.acquisition!=='manual')throw failure('Unknown model acquisition mode',400);
        const url=new URL(model.url);if(url.protocol!=='https:' || url.username||url.password||url.search||url.hash)throw failure('Models require a credential-free HTTPS source',400);
      }
    }
    for(const feature of input.features){safeId(feature.id);if(!Array.isArray(feature.models)||feature.models.some(id=>!ids.has(id)))throw failure('Feature refers to an unknown model',400);}
    const previous=this.catalogs.get(input.appId);
    const record={...input,settings:previous?.settings || {},catalogHash:sha(JSON.stringify(input))};
    if(previous?.catalogHash===record.catalogHash)return previous;
    if(this.listJobs(input.appId).some(job=>ACTIVE.has(job.status)))throw failure('Wait for this app’s resource jobs before updating its catalog');
    this.catalogs.set(input.appId,record);await this.save('catalogs');return record;
  }
  catalog(appId){const value=this.catalogs.get(safeId(appId));if(!value)throw failure('This app has not registered its resources',404);return value;}
  async configure(appId,input){
    await this.ready;const catalog=this.catalog(appId);
    const allowed=['workspace','modelsRoot','pythonExecutable','cgExecutable','comfyUrl','serveUrl','environment'];
    const settings={...catalog.settings};
    for(const [key,value] of Object.entries(input)){
      if((!allowed.includes(key)&&!/^runtime\.[a-z0-9-]+\.(comfyUrl|serveUrl)$/.test(key))||typeof value!=='string')throw failure('Invalid resource setting',400);
      if(!value.trim()){delete settings[key];continue;}
      if(['comfyUrl','serveUrl'].includes(key)||/^runtime\.[a-z0-9-]+\.(comfyUrl|serveUrl)$/.test(key)){const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw failure('Choose a loopback runtime on this machine',400);settings[key]=url.origin;}
      else if(key==='environment'){safeId(value);settings[key]=value;}
      else {if(!isAbsolute(value))throw failure('Use an absolute path on the selected machine',400);settings[key]=resolve(value);}
    }
    if(this.listJobs(appId).some(job=>ACTIVE.has(job.status))&&JSON.stringify(settings)!==JSON.stringify(catalog.settings))throw failure('Wait for resource jobs before changing runtime settings');
    // Storage selection is an explicit separate action; discovery never moves it.
    if(input.modelsRoot&&catalog.settings.modelsRoot&&resolve(input.modelsRoot)!==resolve(catalog.settings.modelsRoot))throw failure('Use the model-storage action to change the shared location');
    catalog.settings=settings;await this.save('catalogs');return this.inventory(appId);
  }
  async context(appId){
    const catalog=this.catalog(appId),system=await executorSystem(this.executor),loaded=readConfig(),shared={...loaded.config.defaults,...loaded.config.apps?.[appId]},settings={...catalog.settings};
    const installations=this.executor.installations().filter(value=>value.appId===appId);
    const installed=installations[0]?.configuration || {};
    const comfyUrl=settings.comfyUrl || installed.comfyUrl || shared.comfyUrl || null;
    let paths=null;if(comfyUrl)try{paths=await runtimePaths(comfyUrl);}catch{}
    const envRoot=paths?.baseDirectory?.endsWith('/ComfyUI')?dirname(paths.baseDirectory):null;
    const workspace=settings.workspace || installed.workspace || shared.workspace || (envRoot&&dirname(envRoot).endsWith('/environments')?dirname(dirname(envRoot)):null) || system.defaultWorkspace;
    const python=system.comfygitDevelopment?.python || settings.pythonExecutable || installed.pythonExecutable || system.comfygitPython || system.tools.python3;
    let index=null,indexError=null;try{index=await this.bridge(python,{action:'inventory',workspace});}catch(e){indexError=e.message;}
    const modelsRoot=index?.models_directory || settings.modelsRoot || installed.modelsRoot || system.defaultModelsRoot;
    const mismatch=Boolean(index?.models_directory&&settings.modelsRoot&&resolve(index.models_directory)!==resolve(settings.modelsRoot));
    return {catalog,system,workspace,modelsRoot,python,index,indexError,mismatch,comfyUrl,serveUrl:settings.serveUrl || installed.serveUrl || shared.serveUrl || null,environment:settings.environment || (envRoot?envRoot.split('/').at(-1):null)};
  }
  async bridgeWithRetry(run,python,input,options={}){
    for(let attempt=0;;attempt++){
      options.signal?.throwIfAborted();
      try{return await run(python,input,options);}catch(error){
        if(attempt>=7||!['inventory','scan','storage'].includes(input.action)||
          !error.message?.startsWith('Another ComfyGit operation is running on this environment.'))throw error;
        options.onProgress?.({stage:'waiting',message:'Waiting for the current ComfyGit operation to finish'});
        await delay(250*(attempt+1),undefined,{signal:options.signal});
      }
    }
  }
  async runBridge(python,input,{signal,onProgress}={}){
    if(!python)throw failure('Install the ComfyGit runtime to manage its model index');
    return new Promise((resolveResult,reject)=>{
      const child=spawn(python,[fileURLToPath(new URL('./model-resources.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],signal,env:{...process.env,PYTHONUNBUFFERED:'1'}});let output='',errors='',pending='';
      child.stdout.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);try{const value=JSON.parse(line);if(value.progress)onProgress?.(value.progress);else output=line;}catch{}}});
      child.stderr.on('data',chunk=>errors=(errors+chunk).slice(-3000));child.once('error',reject);child.stdin.on('error',()=>{});
      child.once('close',code=>{if(code!==0)return reject(new Error(errors.trim() || 'ComfyGit model inspection failed'));try{resolveResult(JSON.parse(output || pending));}catch{reject(new Error('Invalid ComfyGit inventory response'));}});child.stdin.end(JSON.stringify(input));
    });
  }
  async inventory(appId){
    if(this.indexingApps.size&&this.inventoryCache.has(appId))return {...this.inventoryCache.get(appId),refreshing:true};
    if(this.inventoryTasks.has(appId))return this.inventoryTasks.get(appId);
    const task=this.inspectInventory(appId).then(value=>{this.inventoryCache.set(appId,value);return value;}).finally(()=>this.inventoryTasks.delete(appId));this.inventoryTasks.set(appId,task);return task;
  }
  async inspectInventory(appId){
    await this.ready;const ctx=await this.context(appId),{catalog,index,modelsRoot}=ctx;
    const receiptPath=join(this.root,'verification.json');let receipts={};try{receipts=JSON.parse(await readFile(receiptPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const models=await Promise.all(catalog.models.map(async model=>{
      const path=contained(modelsRoot,model.relativePath),s=await stat(path).catch(()=>null);
      const indexed=index?.models.find(row=>row.short_hash===model.shortHash && row.locations?.some(loc=>resolve(loc.base_directory,loc.relative_path)===resolve(path)&&loc.present&&!loc.changed));
      const location=index?.models.flatMap(row=>row.locations || []).find(loc=>resolve(loc.base_directory,loc.relative_path)===resolve(path));
      const verified=Boolean(s?.isFile()&&receipts[path]?.identity===fileIdentity(s)&&receipts[path]?.sha256===model.sha256);
      const rejected=Boolean(s&&receipts[path]?.identity===fileIdentity(s)&&receipts[path]?.failed);
      const changed=Boolean(s&&(rejected||!s.isFile()||s.size!==model.sizeBytes||location?.changed||(location&& !indexed)));
      const state=!s?'missing':changed?'changed':indexed&&s.size===model.sizeBytes?'installed':'unindexed';
      return {...model,path,state,verified,integrity:verified?'sha256':state==='installed'?'comfygit-index':null};
    }));
    let nodes={},runtimeError=null,stats=null;
    if(ctx.comfyUrl)try{
      const [a,b]=await Promise.all([this.fetch(ctx.comfyUrl+'/system_stats',{signal:AbortSignal.timeout(4000)}),this.fetch(ctx.comfyUrl+'/object_info',{signal:AbortSignal.timeout(4000)})]);
      if(!a.ok||!b.ok)throw new Error('ComfyUI is not ready');stats=await a.json();nodes=await b.json();
    }catch(e){runtimeError='Generation runtime is offline';}
    let contracts='';if(ctx.serveUrl)try{const response=await this.fetch(ctx.serveUrl+'/contracts',{signal:AbortSignal.timeout(4000)});if(response.ok)contracts=await response.text();}catch{}
    const runtimes=[{id:'comfygit',name:'ComfyGit & Python',installed:Boolean(index),version:index?.core_version || null,required:true,detail:index?'Shared workspace and model index':ctx.indexError || 'Install the managed runtime'},
      {id:'comfyui',name:'ComfyUI',installed:Boolean(stats),version:stats?.system?.comfyui_version || null,required:true,detail:runtimeError || (stats?'Generation runtime connected':'Not installed or connected')},
      {id:'source-pipeline',name:catalog.nodeRuntime?.name || 'Runtime extensions',installed:(catalog.requiredNodes || []).every(name=>nodes[name]),required:true,detail:catalog.nodeRuntime?.detail || 'App nodes and generation extensions'}];
    const featureRuntimes=new Map();
    for(const key of new Set(catalog.features.map(feature=>feature.runtimeKey).filter(Boolean))){
      const comfyUrl=catalog.settings['runtime.'+key+'.comfyUrl'],serveUrl=catalog.settings['runtime.'+key+'.serveUrl'];
      let online=false,nodes={},contracts='';
      if(comfyUrl)try{const a=await this.fetch(comfyUrl+'/system_stats',{signal:AbortSignal.timeout(4000)}),b=await this.fetch(comfyUrl+'/object_info',{signal:AbortSignal.timeout(4000)});if(a.ok&&b.ok){nodes=await b.json();online=true;}}catch{}
      if(serveUrl)try{const r=await this.fetch(serveUrl+'/contracts',{signal:AbortSignal.timeout(4000)});if(r.ok)contracts=await r.text();}catch{}
      featureRuntimes.set(key,{online,nodes,contracts});
    }
    const features=catalog.features.map(feature=>{
      const state=feature.runtimeKey?featureRuntimes.get(feature.runtimeKey):{online:Boolean(stats),nodes,contracts};
      const missingModels=feature.models.filter(id=>models.find(model=>model.id===id)?.state!=='installed');
      const missingNodes=(feature.nodes || []).filter(name=>!state.nodes[name]);
      const workflowReady=(feature.contracts || []).every(name=>state.contracts.includes(name));
      return {...feature,ready:state.online&&!missingModels.length&&!missingNodes.length&&workflowReady&&!ctx.mismatch,missingModels,missingNodes,workflowReady};
    });
    const required=models.filter(model=>model.requirement==='required'),installed=required.filter(model=>model.state==='installed');
    return {appId,capabilities:['uninstall-model-v1'],title:catalog.title,description:catalog.description,optionalPacks:catalog.optionalPacks || [],observedAt:now(),storage:{path:modelsRoot,workspace:ctx.workspace,indexPath:index?.index_path || join(ctx.workspace,'.metadata','model-cache','models.db'),...await disk(modelsRoot),managedBytes:models.filter(model=>model.state==='installed').reduce((n,m)=>n+m.sizeBytes,0)},models,runtimes,features,
      summary:{ready:runtimes.every(item=>item.installed)&&features.filter(item=>!item.optional).every(item=>item.ready),requiredInstalled:installed.length,requiredTotal:required.length,missingRequiredBytes:required.filter(model=>model.state!=='installed').reduce((n,m)=>n+m.sizeBytes,0)},
      runtime:{comfyUrl:ctx.comfyUrl,serveUrl:ctx.serveUrl,environment:ctx.environment,workspace:ctx.workspace},settings:catalog.settings,
      issues:[...(ctx.mismatch?['Selected model folder differs from the shared ComfyGit workspace. Use the storage control to change it explicitly.']:[])]};
  }
  listJobs(appId){return [...this.jobs.values()].filter(job=>job.appId===appId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  async update(id,patch){const row=this.jobs.get(id);Object.assign(row,patch,{updatedAt:now()});await this.save('jobs');return {...row};}
  async enqueue(appId,kind,resourceIds,run,details={}){
    await this.ready;this.catalog(appId);
    const duplicate=this.listJobs(appId).find(job=>ACTIVE.has(job.status)&&job.kind===kind&&JSON.stringify(job.resourceIds)===JSON.stringify(resourceIds));if(duplicate){if(kind==='storage'&&duplicate.storagePath!==details.storagePath)throw failure('Wait for the current storage change to finish');return {...duplicate};}
    const row={...details,id:randomUUID(),appId,kind,resourceIds,status:'queued',progress:0,completedBytes:0,totalBytes:null,message:'Queued',error:null,createdAt:now(),updatedAt:now()};
    this.jobs.set(row.id,row);await this.save('jobs');
    const task=(this.queues.get(appId)||Promise.resolve()).catch(()=>{}).then(async()=>{
      if(row.status==='cancelled')return;const abort=new AbortController();this.controllers.set(row.id,abort);
      await this.update(row.id,{status:'running',message:'Preparing'});
      try{await run(row,abort.signal);await this.update(row.id,{status:'succeeded',progress:1,message:'Complete',error:null});}
      catch(e){await this.update(row.id,{status:abort.signal.aborted?'cancelled':'failed',message:abort.signal.aborted?'Cancelled':'Needs attention',error:abort.signal.aborted?null:e.message});}
      finally{this.controllers.delete(row.id);}
    });this.queues.set(appId,task);return {...row};
  }
  async cancel(appId,id){const row=this.jobs.get(id);if(!row||row.appId!==appId)throw failure('Resource job not found',404);if(row.status==='queued')await this.update(id,{status:'cancelled',message:'Cancelled'});else {if(row.kind==='storage'&&row.status==='running')throw failure('Storage indexing is finishing. Wait for the shared index update.');if(row.kind==='uninstall'&&row.status==='running')throw failure('Uninstall is finishing its model and index update.');if(row.kind==='setup'&&row.installationJobId){const installation=this.executor.getJob(row.installationJobId);if(installation&&!['completed','failed','cancelled'].includes(installation.phase))throw failure('Runtime installation is still active. Its progress will remain visible until it finishes.');}this.controllers.get(id)?.abort();}return {...row};}
  async withStore(ctx,task){
    await mkdir(ctx.modelsRoot,{recursive:true});const path=join(ctx.modelsRoot,'.akatz-resource.lock');
    try{await mkdir(path,{mode:0o700});}catch(e){
      if(e.code!=='EEXIST')throw e;
      const owner=await readFile(join(path,'owner.json'),'utf8').then(JSON.parse).catch(()=>null);
      let dead=false;if(Number.isInteger(owner?.pid)&&owner.pid>0)try{process.kill(owner.pid,0);}catch(error){dead=error.code==='ESRCH';}
      if(!dead)throw failure('Another app is changing this shared model store. Wait for it to finish, then retry.');
      await rm(path,{recursive:true});await mkdir(path,{mode:0o700});
    }
    try{await writeFile(join(path,'owner.json'),JSON.stringify({pid:process.pid,createdAt:now()}),{mode:0o600});return await task();}finally{await rm(path,{recursive:true,force:true});}
  }
  receipt(path,value){
    const task=this.receiptSaves.catch(()=>{}).then(async()=>{
      const file=join(this.root,'verification.json');let records={};try{records=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
      records[path]=value;await atomic(file,records);
    });this.receiptSaves=task;return task;
  }
  async verify(ctx,model,job,signal){
    const path=contained(ctx.modelsRoot,model.relativePath),before=await stat(path),identity=fileIdentity(before);let total=0;const hash=createHash('sha256');
    try {
      if(!before.isFile()||before.size!==model.sizeBytes)throw failure(model.name+' has a different size. The existing file was preserved.');
      for await(const chunk of createReadStream(path,{signal})){hash.update(chunk);total+=chunk.length;}
      if(hash.digest('hex')!==model.sha256||fileIdentity(await stat(path))!==identity)throw failure(model.name+' failed checksum verification. The existing file was preserved.');
      await this.receipt(path,{sha256:model.sha256,identity,verifiedAt:now()});
    } catch(error){if(!signal?.aborted)await this.receipt(path,{identity,failed:true,verifiedAt:now()});throw error;}
    await this.update(job.id,{completedBytes:job.completedBytes+total,message:'Verified '+model.name});
  }
  async scan(appId){return this.enqueue(appId,'scan',[],async(job,signal)=>{
    const ctx=await this.context(appId);if(!ctx.index)throw failure('Install the ComfyGit runtime before indexing models.');
    await this.withStore(ctx,async()=>{
      const present=ctx.catalog.models;let failures=[];
      for(const model of present){signal.throwIfAborted();if(!await stat(contained(ctx.modelsRoot,model.relativePath)).catch(()=>null))continue;await this.update(job.id,{message:'Verifying '+model.name});try{await this.verify(ctx,model,job,signal);}catch(e){if(signal.aborted)throw e;failures.push(e.message);}}
      await this.update(job.id,{message:'Updating shared ComfyGit index'});await this.bridge(ctx.python,{action:'scan',workspace:ctx.workspace},{signal});
      await this.executor.verifyModels(appId);
      if(failures.length)throw failure(failures.join(' '));
    });
  });}
  async download(appId,ids){
    await this.ready;if(!Array.isArray(ids)||!ids.length||ids.length>256||new Set(ids).size!==ids.length)throw failure('Choose unique model resources to download',400);
    const catalog=this.catalog(appId),models=ids.map(id=>{const model=catalog.models.find(item=>item.id===id);if(!model)throw failure('Unknown model',404);return model;});
    if(models.some(model=>model.acquisition==='manual'))throw failure('Import these models from their declared source, then scan the shared ComfyGit store. No download was started.');
    return this.enqueue(appId,'download',ids,(job,signal)=>this.acquire(appId,models,job,signal));
  }
  async acquire(appId,models,job,signal){
      const ctx=await this.context(appId);if(!ctx.index)throw failure('Install the ComfyGit runtime before downloading models.');
      await this.withStore(ctx,async()=>{
        const current=await this.inventory(appId);const missing=models.filter(model=>current.models.find(item=>item.id===model.id)?.state==='missing');
        const bytes=missing.reduce((n,m)=>n+m.sizeBytes,0),space=await disk(ctx.modelsRoot);if(space.freeBytes!==null&&space.freeBytes<bytes+1024**3)throw failure('Not enough free space for these models and 1 GiB of working room. Choose another shared model location.');
        await this.update(job.id,{totalBytes:models.reduce((n,m)=>n+m.sizeBytes,0)});
        for(const model of models){
          signal.throwIfAborted();const path=contained(ctx.modelsRoot,model.relativePath);
          if(await stat(path).catch(()=>null)){await this.update(job.id,{message:'Checking existing '+model.name});await this.verify(ctx,model,job,signal);continue;}
          await mkdir(dirname(path),{recursive:true});const parent=await realpath(dirname(path)),root=await realpath(ctx.modelsRoot);contained(root,relative(root,parent)||'.model-placeholder');
          const temp=join(dirname(path),'.akatz-'+job.id+'-'+model.id+'.part');let file;
          try{
            file=await open(temp,'wx',0o600);const response=await this.fetch(model.url,{signal});if(!response.ok||!response.body)throw new Error('Model download returned HTTP '+response.status);
            const hash=createHash('sha256');let bytes=0,last=0;const base=job.completedBytes;
            for await(const chunk of response.body){signal.throwIfAborted();bytes+=chunk.length;if(bytes>model.sizeBytes)throw new Error('Model download exceeds its pinned size');hash.update(chunk);await file.writeFile(chunk);if(Date.now()-last>500){last=Date.now();await this.update(job.id,{completedBytes:base+bytes,progress:(base+bytes)/job.totalBytes,message:'Downloading '+model.name});}}
            if(bytes!==model.sizeBytes||hash.digest('hex')!==model.sha256)throw new Error('Downloaded model failed its size or SHA-256 check');
            await file.sync();await file.close();file=null;
            // link is atomic and refuses to overwrite a file created by another app.
            await link(temp,path);await unlink(temp);
            await this.receipt(path,{sha256:model.sha256,identity:fileIdentity(await stat(path)),verifiedAt:now()});
            await this.update(job.id,{completedBytes:base+bytes,message:'Indexing '+model.name});
          }finally{await file?.close().catch(()=>{});await unlink(temp).catch(()=>{});}
        }
        await this.bridge(ctx.python,{action:'scan',workspace:ctx.workspace},{signal});
        await this.executor.verifyModels(appId);
        const after=await this.inventory(appId);if(models.some(model=>after.models.find(item=>item.id===model.id)?.state!=='installed'))throw new Error('Model bytes are retained, but ComfyGit indexing needs attention. Run Scan to retry.');
      });
  }
  async removalDetails(appId,resourceId){
    const ctx=await this.context(appId),model=ctx.catalog.models.find(item=>item.id===resourceId);
    if(!model)throw failure('Unknown model',404);
    if(!ctx.index||ctx.mismatch)throw failure('Repair shared model indexing before uninstalling');
    const path=contained(ctx.modelsRoot,model.relativePath),info=await stat(path);
    if(!info.isFile())throw failure('The selected model is not a regular file');
    const root=await realpath(ctx.modelsRoot),actual=await realpath(path);
    contained(root,relative(root,actual));
    const plan=await this.bridge(ctx.python,{action:'uninstall-plan',workspace:ctx.workspace,path});
    if(plan.target_locations?.length!==1||resolve(plan.target_locations[0].base_directory,plan.target_locations[0].relative_path)!==path)throw failure('Uninstall must resolve exactly the selected model location');
    const inventory=await this.inventory(appId),current=inventory.models.find(item=>item.id===resourceId);
    const catalogRecovery=Boolean(current?.verified&&model.url&&model.revision&&/^[a-f0-9]{40}$/.test(model.revision)&&new URL(model.url).pathname.includes('/resolve/'+model.revision+'/'));
    const blockers=(plan.blockers||[]).filter(reason=>reason!=='referenced_by_environments'&&!(reason==='final_copy_lacks_recovery_proof'&&catalogRecovery));
    const usedByApps=[...this.catalogs.values()].filter(c=>c.models.some(m=>m.sha256===model.sha256)).map(c=>c.title||c.appId).sort();
    return {ctx,model,path,identity:fileIdentity(info),plan,catalogRecovery,blockers,usedByApps};
  }
  async uninstallPlan(appId,resourceId){
    await this.ready;await this.assertUninstallIdle();
    const detail=await this.removalDetails(appId,resourceId),id=randomUUID();
    const snapshot={appId,resourceId,path:detail.path,identity:detail.identity,plan:detail.plan,catalogRecovery:detail.catalogRecovery,usedByApps:detail.usedByApps};
    const digest=sha(JSON.stringify(snapshot)),expiresAt=new Date(Date.now()+10*60*1000).toISOString();
    for(const [key,value] of this.removalPlans)if(value.expiresAt<now())this.removalPlans.delete(key);
    this.removalPlans.set(id,{...snapshot,digest,expiresAt});
    return {id,digest,expiresAt,resourceId,name:detail.model.name,path:detail.path,sizeBytes:detail.model.sizeBytes,reclaimBytes:detail.plan.potential_reclaim_bytes,usedByApps:detail.usedByApps,stages:detail.model.stages||[],environments:detail.plan.model?.referencing_environments||[],blockers:detail.blockers,canUninstall:detail.blockers.length===0};
  }
  async assertUninstallIdle(exceptJobId){
    if([...this.jobs.values()].some(job=>job.id!==exceptJobId&&ACTIVE.has(job.status)))throw failure('Wait for current resource jobs before uninstalling models');
    await this.assertIdle();
    const urls=new Set([...this.catalogs.values()].flatMap(c=>Object.entries(c.settings||{}).filter(([key])=>key==='comfyUrl'||key.endsWith('.comfyUrl')).map(([,url])=>url)));
    for(const url of urls){
      let response;try{response=await this.fetch(url+'/queue',{signal:AbortSignal.timeout(3000)});}catch(error){
        const parsed=new URL(url),managed=this.executor.managedRuntimeUrls?.().has(url);
        const sessions=this.executor.sessions?.records?.()||[];
        const installs=this.executor.installations().filter(i=>i.runtime?.comfyUrls?.includes(url));
        const settled=sessions.filter(s=>installs.some(i=>i.id===s.installationId)).every(s=>s.status?.phase==='stopped');
        if(managed&&settled&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)&&error.cause?.code==='ECONNREFUSED')continue;
        throw failure('Cannot verify that a shared generation runtime is idle. Restore its connection before uninstalling.');
      }
      if(!response.ok)throw failure('Cannot verify a shared generation queue');const queue=await response.json();
      if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending)||queue.queue_running.length||queue.queue_pending.length)throw failure('Wait for shared generation queues to finish before uninstalling models');
    }
  }
  async uninstall(appId,{planId,digest,confirm}){
    await this.ready;const reviewed=this.removalPlans.get(planId);
    if(!reviewed||reviewed.appId!==appId||reviewed.digest!==digest||reviewed.resourceId!==confirm||reviewed.expiresAt<now())throw failure('Review the selected model uninstall again before confirming');
    await this.assertUninstallIdle();
    return this.enqueue(appId,'uninstall',[reviewed.resourceId],async(job,signal)=>{
      await this.assertUninstallIdle(job.id);const ctx=await this.context(appId);
      await this.withStore(ctx,async()=>{
        const current=await this.removalDetails(appId,reviewed.resourceId);
        const snapshot={appId,resourceId:reviewed.resourceId,path:current.path,identity:current.identity,plan:current.plan,catalogRecovery:current.catalogRecovery,usedByApps:current.usedByApps};
        if(sha(JSON.stringify(snapshot))!==reviewed.digest||current.blockers.length)throw failure('Model file or usage changed. Review uninstall again.');
        signal.throwIfAborted();await this.assertUninstallIdle(job.id);
        await this.update(job.id,{message:'Uninstalling '+current.model.name});
        // Once deletion starts, finish the location/index operation even if Cancel is clicked.
        await this.bridge(ctx.python,{action:'uninstall',workspace:ctx.workspace,path:current.path,expected_plan:current.plan,catalog_recovery_verified:current.catalogRecovery});
        await this.receipt(current.path,{removedAt:now()});this.inventoryTasks.clear();
        await this.executor.verifyModels(appId);
        await this.update(job.id,{completedBytes:current.plan.potential_reclaim_bytes,totalBytes:current.plan.potential_reclaim_bytes});
        this.removalPlans.delete(planId);
      });
    });
  }
  async assertIdle({requiredRuntimes=null}={}){
    if(this.executor.jobs().some(job=>!['completed','failed','cancelled'].includes(job.phase)))throw failure('Wait for active generation or setup jobs before changing runtime resources');
    const urls=new Set(this.executor.installations().flatMap(item=>item.runtime?.comfyUrls || []));
    for(const url of urls){let response;try{response=await this.fetch(url+'/queue',{signal:AbortSignal.timeout(3000)});}catch{continue;}
      // Historical installations can retain a URL now occupied by a non-ComfyGit helper.
      // A 404 is safe to ignore only when this setup does not require that runtime.
      if(response.status===404&&requiredRuntimes!==null&&!requiredRuntimes.includes(url))continue;
      if(!response.ok)throw failure('Cannot verify runtime ownership');
      const queue=await response.json();if(queue.queue_running?.length||queue.queue_pending?.length)throw failure('Wait for the generation queue to finish before changing storage or runtime');}
  }
  async setup(appId,{planId,digest,resourceIds=[]}){
    await this.ready;const catalog=this.catalog(appId),installation=this.executor.reviewedInstallation(planId,digest);
    if(installation.appId!==appId)throw failure('Setup plan belongs to another app',400);
    const models=resourceIds.map(id=>{const model=catalog.models.find(item=>item.id===id);if(!model)throw failure('Unknown model',404);return model;});
    if(models.some(model=>model.acquisition==='manual'))throw failure('Import the selected manual models before setup. No installation or download was started.');
    return this.enqueue(appId,'setup',resourceIds,async(job,signal)=>{
      await this.assertIdle({requiredRuntimes:installation.runtime?.comfyUrls??null});await this.update(job.id,{message:'Installing runtime',progress:0.02});
      const result=await this.executor.install(planId,digest);
      if(!result.job&&result.readiness&&!result.readiness.ready)throw failure('The existing runtime is offline or needs repair. Review a start-runtime plan.');
      if(result.job){
        await this.update(job.id,{installationJobId:result.job.id});
        while(true){
          signal.throwIfAborted();const execution=this.executor.getJob(result.job.id);
          if(execution.phase==='completed')break;
          if(['failed','cancelled','uncertain'].includes(execution.phase))throw failure(execution.error || 'Runtime setup '+execution.phase);
          await this.update(job.id,{message:execution.activity || 'Installing runtime dependencies'});
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
      }
      for(const key of ['workspace','modelsRoot','environment','comfyUrl','serveUrl','pythonExecutable','cgExecutable'])if(installation.configuration[key])catalog.settings[key]=installation.configuration[key];
      await this.save('catalogs');
      if(models.length)await this.acquire(appId,models,job,signal);
      await this.executor.verifyModels(appId);
    });
  }
  async setStorage(appId,path){
    if(typeof path!=='string'||!isAbsolute(path)||['/','/home','/data','/tmp','/usr','/var','/opt'].includes(resolve(path)))throw failure('Choose a dedicated absolute model directory',400);
    await this.ready;
    if([...this.jobs.values()].some(job=>job.kind==='storage'&&ACTIVE.has(job.status)&&job.appId!==appId))throw failure('Another app is updating shared model storage. Wait for indexing to finish.');
    const storagePath=resolve(path);
    return this.enqueue(appId,'storage',[],async(job,signal)=>{
      await this.update(job.id,{stage:'preparing',message:'Checking shared model storage'});
      await this.assertIdle();const ctx=await this.context(appId);
      if(!ctx.index){
        if(await stat(ctx.workspace).catch(()=>null))throw failure('Repair ComfyGit inspection before changing an existing workspace’s model location');
        ctx.catalog.settings.modelsRoot=storagePath;await this.save('catalogs');return;
      }
      // Cache a complete snapshot before the serialized bridge starts its long scan.
      await this.inventory(appId);signal.throwIfAborted();
      this.indexingApps.add(appId);
      let progressWrites=Promise.resolve();
      const onProgress=value=>{
        const patch={stage:value.stage==='refreshing'?'refreshing':'indexing',message:String(value.message||'Indexing shared model storage')};
        if(Number.isSafeInteger(value.totalFiles)&&value.totalFiles>=0)patch.totalFiles=value.totalFiles;
        if(Number.isSafeInteger(value.completedFiles)&&value.completedFiles>=0)patch.completedFiles=value.completedFiles;
        if(typeof value.currentFile==='string')patch.currentFile=value.currentFile;
        if(patch.totalFiles>0)patch.progress=Math.min(1,(patch.completedFiles||0)/patch.totalFiles);
        progressWrites=progressWrites.then(()=>this.update(job.id,patch));
        progressWrites.catch(()=>{});
      };
      try{
        await this.update(job.id,{stage:'indexing',message:'Discovering model files'});
        await this.bridge(ctx.python,{action:'storage',workspace:ctx.workspace,path:storagePath},{signal,onProgress});
        await progressWrites;
        ctx.catalog.settings.modelsRoot=storagePath;await this.save('catalogs');
        await this.update(job.id,{stage:'refreshing',message:'Refreshing model availability'});
      }finally{try{await progressWrites;}finally{this.indexingApps.delete(appId);}}
      // Complete only after the new path, disk space and model rows can be read.
      await this.inventory(appId);
      await this.update(job.id,{stage:'complete',message:'Shared model storage indexed'});
    },{storagePath,stage:'queued',completedFiles:0,totalFiles:null});
  }
  async close(){for(const controller of this.controllers.values())controller.abort();await Promise.allSettled(this.queues.values());await this.saves;}
}
