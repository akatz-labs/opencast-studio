import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createExecutorServer} from '../vendor/shared-runtime/src/executor-server.mjs';
import {ExecutorClient} from '../server/executor-client.mjs';
import {installationPlan,runtimeProfiles} from '../server/setup-plan.mjs';
import {resourceService} from '../server/resources.mjs';

test('fresh setup stages both immutable environments through the real shared executor protocol',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'opencast-setup-test-'));
 const server=createExecutorServer({root,dispatch:false});await new Promise(r=>server.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await server.close();fs.rmSync(root,{recursive:true,force:true})});
 const client=new ExecutorClient({kind:'local',port:server.server.address().port}),original=client.json.bind(client);
 client.json=async(route,...args)=>route.startsWith('/v1/system')?{platform:'linux',arch:'x64',dataRoot:root,defaultWorkspace:root+'/workspace',defaultModelsRoot:root+'/models',tools:{python3:'/usr/bin/python3',git:'/usr/bin/git','g++':'/usr/bin/g++',ffmpeg:'/usr/bin/ffmpeg',ffprobe:'/usr/bin/ffprobe'},scripts:{comfygitBootstrap:'/shared/bootstrap.py',comfygitMaterialize:'/shared/materialize.py'}}:original(route,...args);
 const environments=[];
 for(const profile of runtimeProfiles){
  const {installation,plan,recipe}=await installationPlan(client,profile);
  assert.equal(installation.appId,'opencast');assert.equal(installation.setup.services.length,0,'Setup must not start GPU sessions');assert.deepEqual(installation.features,profile.id==='pika'?['runtime-installed','character-swap','motion-transfer']:['runtime-installed','character']);
  assert.equal(installation.configuration.modelsRoot,root+'/models');assert.ok(installation.configuration.environment.startsWith('opencast-'+profile.id));environments.push(installation.configuration.environment);
  assert.equal(installation.setup.commands.find(s=>s.label==='Materialize app runtime').args.at(-1),profile.torchBackend);
  assert.ok(fs.existsSync(recipe.directory+'/bundled/toolchain/manifest.json'));
  if(profile.id==='krea')assert.ok(fs.existsSync(recipe.directory+'/bundled/nodes/cast-character-sheet/__init__.py'));
  if(profile.id==='pika'){assert.ok(installation.setup.commands.some(c=>c.label==='Apply pinned INT8 kernel offset fix'));assert.ok(installation.probes.some(p=>p.name==='INT8 kernel supports long clips'));}
  const installed=await client.json('/v1/install',{planId:plan.id,digest:plan.digest});
  const replay=await client.json('/v1/install',{planId:plan.id,digest:plan.digest});assert.equal(replay.job.id,installed.job.id);
 }
 assert.notEqual(environments[0],environments[1]);
});

test('one click is available before local worker setup and delegates only the fixed setup action',async()=>{
 let starts=0;const setup={status:()=>null,start:()=>({id:'setup',status:'queued',starts:++starts})};
 const service=resourceService({configuration:{target:{kind:'local'},name:'This machine'},client:{json:async()=>{throw new TypeError('fetch failed')}},setup});
 const snapshot=await service.snapshot();assert.equal(snapshot.executorName,'This machine');assert.equal(snapshot.setupAvailable,true);assert.equal(snapshot.connection,'offline');
 assert.equal((await service.action({action:'setup'})).status,'queued');assert.equal(starts,1);
});

test('bundled toolchain and shared runtime have complete content identities',()=>{
 const root=new URL('../',import.meta.url),pins=JSON.parse(fs.readFileSync(new URL('resources/toolchain/manifest.json',root)));
 const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(new URL(file,root))).digest('hex');
 assert.equal(hash('resources/toolchain/requirements.txt'),pins.requirements_sha256);
 for(const wheel of pins.wheels)assert.equal(hash('resources/toolchain/'+wheel.filename),wheel.sha256);
 const provenance=JSON.parse(fs.readFileSync(new URL('vendor/shared-runtime/provenance.json',root)));
 for(const [file,sha]of Object.entries(provenance.files))assert.equal(hash('vendor/shared-runtime/'+file),provenance.localPatches?.find(p=>p.file===file)?.sha256||sha,file);
});

test('CPU-only setup does not inspect, release or replace unrelated GPU runtimes',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'opencast-cpu-install-'));
 const server=createExecutorServer({root,dispatch:false});t.after(async()=>{await server.close();fs.rmSync(root,{recursive:true,force:true})});
 const executor=server.executor;
 let touched=0;executor.prepareGpu=async()=>{touched++;throw new Error('GPU must remain untouched')};executor.sessions.prepare=async()=>{touched++;throw new Error('Sessions must remain untouched')};
 const adapter=path.join(root,'adapter.mjs');fs.writeFileSync(adapter,'export async function run(){return {files:[]}}');
 const doneFile=path.join(root,'installed.txt');
 const definition={id:'fixture-cpu-setup',appId:'opencast',revision:crypto.createHash('sha256').update(fs.readFileSync(adapter)).digest('hex'),adapter,features:['runtime-installed'],probes:[{kind:'file',path:doneFile}],setup:{requiresGpu:false,services:[],commands:[{command:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(doneFile)},'ready')`]}]}};
 const plan=executor.plan(definition),admitted=await executor.install(plan.id,plan.digest);
 for(let attempt=0;attempt<60;attempt++){await executor.tick();if(executor.getJob(admitted.job.id).phase==='completed')break;await new Promise(r=>setTimeout(r,100))}
 assert.equal(executor.getJob(admitted.job.id).phase,'completed');assert.equal(touched,0);assert.equal(fs.readFileSync(doneFile,'utf8'),'ready');
});

test('one button completes the setup orchestration and resumes without duplicate downloads',async t=>{
 const {createServer}=await import('node:http');const {setupService}=await import('../server/setup.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'opencast-button-')),calls=[],jobs=[],plans=new Map();let modelsRoot=root+'/models';
 const http=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
  const body=req.headers['content-type']==='application/json'?JSON.parse(bytes):null;
  calls.push({path:req.url,method:req.method,body});let value={accepted:true};
  if(req.url==='/v1/health')value={executorId:'fixture-button',capabilities:['cpu-only-install-v1','comfy-torch-backend-v1']};
  else if(req.url==='/v1/system')value={platform:'linux',arch:'x64',dataRoot:root,defaultWorkspace:root+'/workspace',defaultModelsRoot:root+'/models',tools:{python3:'/usr/bin/python3',git:'/usr/bin/git','g++':'/usr/bin/g++',ffmpeg:'/usr/bin/ffmpeg',ffprobe:'/usr/bin/ffprobe'},scripts:{comfygitBootstrap:'/shared/bootstrap.py',comfygitMaterialize:'/shared/materialize.py'}};
  else if(req.url==='/v1/recipes')value={directory:root+'/recipes/'+body.digest,digest:body.digest,sha256:body.digest,files:body.files.map(f=>({name:f.name}))};
  else if(req.url.startsWith('/v1/adapters/'))value={path:root+'/adapter.mjs'};
  else if(req.url==='/v1/plans'){const id=crypto.randomUUID();plans.set(id,body);value={id,digest:id,installation:body}}
  else if(req.url==='/v1/install'){assert.ok(plans.has(body.planId));value={job:{id:body.planId,phase:'completed'}}}
  else if(req.url.startsWith('/v1/jobs/'))value={id:req.url.split('/').at(-1),phase:'completed'};
  else if(req.url==='/v1/resources/opencast'&&req.method==='GET')value={models:['flux3-edit','flux3-text','flux3-upsampler'].map(id=>({id,state:'installed'})),storage:{path:modelsRoot}};
  else if(req.url==='/v1/resources/opencast/storage'){modelsRoot=body.path;value={id:crypto.randomUUID(),kind:'storage',status:'succeeded'};jobs.push(value)}
  else if(req.url==='/v1/resources/opencast/jobs')value={items:jobs};
  else if(req.url==='/v1/resources/opencast/download'){value={id:crypto.randomUUID(),kind:'download',status:'succeeded',resourceIds:body.resourceIds};jobs.push(value)}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
 });
 await new Promise(r=>http.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>http.close(r));fs.rmSync(root,{recursive:true,force:true})});
 const configuration={target:{kind:'local',port:http.address().port},executorId:'fixture-button',name:'This machine',settings:{modelsRoot:root+'/existing models'}};
 const service=setupService({directory:root,configuration,configurationFile:root+'/resources.json'});
 const first=service.start(),duplicate=service.start();assert.equal(first.id,duplicate.id);
 async function finished(){for(let i=0;i<120;i++){const s=service.status();if(['blocked','failed','succeeded','interrupted'].includes(s?.status))return s;await new Promise(r=>setTimeout(r,50))}throw new Error('Setup fixture timed out')}
 const result=await finished();assert.equal(result.status,'succeeded',result.error);assert.deepEqual(result.pending,[]);
 assert.equal(calls.filter(c=>c.path==='/v1/install').length,2);assert.equal(jobs.filter(j=>j.kind==='download').length,1);assert.equal(jobs.find(j=>j.kind==='download').resourceIds.length,11);
 assert.ok(calls.findIndex(c=>c.path.endsWith('/storage'))<calls.findIndex(c=>c.path==='/v1/install'));
 assert.ok([...plans.values()].every(p=>p.configuration.modelsRoot===root+'/existing models'));
 assert.ok([...plans.values()].every(p=>p.setup.requiresGpu===false&&p.setup.services.length===0));
 assert.equal(JSON.parse(fs.readFileSync(root+'/resources.json')).executorId,'fixture-button');
 service.start();assert.equal((await finished()).status,'succeeded');assert.equal(jobs.filter(j=>j.kind==='download').length,1);assert.equal(jobs.filter(j=>j.kind==='storage').length,1);
});

test('folder choice survives restart and cannot change during setup',async t=>{
 const {setupService}=await import('../server/setup.mjs');const root=fs.mkdtempSync(path.join(os.tmpdir(),'opencast-folder-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const configuration={target:{kind:'local'},settings:{}};const file=root+'/config.json';
 const setup=setupService({directory:root,configuration,configurationFile:file});setup.configureModelsRoot('/media/existing models');
 assert.equal(JSON.parse(fs.readFileSync(file)).settings.modelsRoot,'/media/existing models');assert.equal(configuration.settings.modelsRoot,'/media/existing models');
 fs.mkdirSync(root+'/setup');fs.writeFileSync(root+'/setup/status.json',JSON.stringify({status:'running',pid:process.pid}));
 assert.throws(()=>setup.configureModelsRoot('/new/models'),/Wait for setup/);
});
