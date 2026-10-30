import {configuredResources} from './resources.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {compileCharacterSheet} from '../shared/prompt.mjs';
import {referencePlacement} from '../shared/placement.mjs';
import {file,immutableAsset} from './files.mjs';
import {swaps} from './swaps.mjs';
import {apiV1} from './api-v1.mjs';
import {assetService,localMediaStore} from './assets.mjs';
import {legacyExecutor} from './legacy-executor.mjs';
import {configuredExecutor} from './configured-executor.mjs';
import {combinedExecutor} from './combined-executor.mjs';
import {fail} from './api-state.mjs';
import {dataDirectory,basePath,deployment,origins,storage} from './deployment.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA=dataDirectory;
const COMFY=process.env.OPENCAST_COMFY||'http://127.0.0.1:8188';
const PREFIX=basePath,PORT=Number(process.env.PORT||8389);
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const graphTemplate=read(ROOT+'/workflows/krea-api.json'),contract=read(ROOT+'/workflows/contract.json');
const workflowTemplate=read(ROOT+'/workflows/character-sheet.json');
const environment=read(ROOT+'/workflows/environment.json'),models=read(ROOT+'/workflows/models.json');
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const galleryManifest=fs.existsSync(ROOT+'/docs/gallery-sheets.json')?read(ROOT+'/docs/gallery-sheets.json'):null;
const compilerSha256=hash(fs.readFileSync(ROOT+'/shared/prompt.mjs','utf8'));
await deployment.checkStorage?.();
fs.mkdirSync(DATA+'/jobs',{recursive:true});
function atomic(file,value){const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w');try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file)}
let ledger=fs.existsSync(DATA+'/jobs.json')?read(DATA+'/jobs.json'):{batches:[],jobs:[]};
const characterNames=fs.existsSync(DATA+'/character-names.json')?read(DATA+'/character-names.json'):{};
const save=()=>atomic(DATA+'/jobs.json',ledger);
const directory=j=>(ledger.batches.find(b=>b.id===j.batchId)?.storage?.path||DATA)+'/jobs/'+j.id;

let submissions=Promise.resolve();
async function retainCompleted(){
 for(const batch of ledger.batches.filter(b=>b.storage&&!b.storageVersion)){
  const jobs=ledger.jobs.filter(j=>j.batchId===batch.id);if(jobs.some(active))continue;
  for(const j of jobs)atomic(directory(j)+'/result.json',j);
  const receipt=await storage('commit-write',batch.storage.id,'--source-key','cast-studio-batch-'+batch.id,'--key','cast-studio-batch-'+batch.id,'--kind','experiment');
  batch.storageVersion=receipt.version_id;for(const j of jobs)j.storageVersion=receipt.version_id;save();
 }
}
const active=j=>j.executionDriver!=='shared'&&['queued','submitting','running','uncertain'].includes(j.status);
const publicJob=j=>({...j,number:ledger.jobs.indexOf(j)+1,name:characterNames[j.id]||`Character ${ledger.jobs.indexOf(j)+1}`,artifacts:j.status==='complete'?Object.fromEntries(Object.keys(j.outputs||{}).map(name=>[name,`${PREFIX}/api/jobs/${j.id}/${name}`])):{},image:j.status==='complete'?`${PREFIX}/api/jobs/${j.id}/image`:null,manifest:`${PREFIX}/api/jobs/${j.id}/manifest`});
let workerBusy=false,workerError=null;
async function request(route,body){const res=await fetch(COMFY+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(body?620000:20000)});if(!res.ok)throw new Error(`ComfyUI ${res.status}: ${(await res.text()).slice(0,600)}`);return res.json()}
async function finish(j,item){
 const dir=directory(j);atomic(dir+'/history.json',item);
 if(item.status?.status_str==='error'){j.status='failed';j.error=(item.status.messages||[]).filter(x=>x[0]==='execution_error').map(x=>x[1].exception_message).join('\n')||'ComfyUI execution failed.';save();return}
 if(!item.status?.completed)return;
 const outputs=read(dir+'/manifest.json').contract.contracts.character.outputs;
 const downloaded={};
 for(const output of outputs){
  const entry=item.outputs?.[output.node_id]?.[output.selector]?.[0];
  if(!entry){j.status='failed';j.error=`Execution completed without the contracted ${output.name} output.`;save();return}
  const res=await fetch(COMFY+'/view?'+new URLSearchParams(entry),{signal:AbortSignal.timeout(30000)});
  if(!res.ok)throw new Error(`Output download failed: ${res.status}`);
  const buffer=Buffer.from(await res.arrayBuffer());if(buffer.length<100||buffer.subarray(1,4).toString()!=='PNG')throw new Error('Worker output is not a valid PNG response.');
  fs.writeFileSync(dir+'/'+output.name+'.png.tmp',buffer);fs.renameSync(dir+'/'+output.name+'.png.tmp',dir+'/'+output.name+'.png');
  downloaded[output.name]={...entry,sha256:hash(buffer),bytes:buffer.length};
 }
 j.status='complete';j.completed=new Date().toISOString();j.outputs=downloaded;j.output=downloaded.image;delete j.error;
 const messages=Object.fromEntries(item.status.messages||[]);if(messages.execution_success&&messages.execution_start)j.executionSeconds=(messages.execution_success.timestamp-messages.execution_start.timestamp)/1000;
 atomic(dir+'/result.json',j);save();
}
async function reconcile(j){
 if(j.promptId){const h=await request('/history/'+encodeURIComponent(j.promptId));if(h[j.promptId])await finish(j,h[j.promptId]);else {const q=await request('/queue');const rows=[...q.queue_running,...q.queue_pending];if(rows.some(r=>r[1]===j.promptId)){j.status=q.queue_running.some(r=>r[1]===j.promptId)?'running':'submitting';delete j.error;save()}else{j.status='uncertain';j.error='Prompt is absent from queue and history. No automatic resubmission.';save()}}return}
 // Submission may have reached ComfyUI before a network or process failure.
 const q=await request('/queue'),h=await request('/history?max_items=500');
 const rows=[...q.queue_running,...q.queue_pending,...Object.values(h).map(x=>x.prompt)];
 const found=rows.find(r=>r?.[3]?.cast_job_id===j.id);
 if(found){j.promptId=found[1];j.status='running';save();if(h[j.promptId])await finish(j,h[j.promptId])}
 else{j.status='uncertain';j.error='Submission outcome is unknown. Retained for reconciliation; not retried.';save()}
}
async function submit(j){
 const q=await request('/queue');if(q.queue_running.length||q.queue_pending.length){workerError='Waiting for the existing generation queue.';return}
 const dir=directory(j),manifest=read(dir+'/manifest.json');
 // Persist the intent before sending; an ambiguous write is never blindly retried.
 j.status='submitting';j.submitted=new Date().toISOString();save();
 try{const receipt=await request('/prompt',{prompt:manifest.graph,client_id:j.id,extra_data:{cast_job_id:j.id,cast_batch_id:j.batchId,extra_pnginfo:{...(manifest.workflow?{workflow:manifest.workflow}:{}),cast:{traits:j.traits,prompt:j.prompt,templateVersion:j.templateVersion,seed:j.seed}}}});atomic(dir+'/submit.json',receipt);
  if(!receipt.prompt_id){j.status='failed';j.error=JSON.stringify(receipt);save();return}
  j.promptId=receipt.prompt_id;j.status='running';save();
 }catch(e){j.status='uncertain';j.error=String(e);save()}
}
async function tick(){if(workerBusy)return;workerBusy=true;try{workerError=null;await retainCompleted();const sent=ledger.jobs.find(j=>j.executionDriver!=='shared'&&['submitting','running','uncertain'].includes(j.status));if(sent)await reconcile(sent);else{const next=ledger.jobs.find(j=>j.executionDriver!=='shared'&&j.status==='queued');if(next)await submit(next)}}catch(e){workerError=String(e);console.error(workerError)}finally{workerBusy=false}}
async function createBatch(body){
 const {traits,direction='',framing='character-sheet',promptOverride='',fullBodyPromptOverride='',steps=8,batchSize=1,seed,bodySeed,referenceTop=48,idempotencyKey}=body;
 if(typeof idempotencyKey!=='string'||!/^[\w-]{8,80}$/.test(idempotencyKey))throw new Error('A valid idempotency key is required.');
 const fingerprint=hash(body),existing=ledger.batches.find(b=>b.key===idempotencyKey);
 if(existing){if(existing.fingerprint!==fingerprint)throw new Error('This request key was already used for different settings.');return ledger.jobs.filter(j=>j.batchId===existing.id).map(publicJob)}
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>4)throw new Error('Batch size must be 1–4.');
 if(steps!==8)throw new Error('This Krea recipe requires 8 steps. Reload the studio to update old settings.');
 if(!Number.isInteger(seed)||seed<0||seed>2147483647)throw new Error('Seed must be 0–2147483647.');
 if(bodySeed!==undefined&&(!Number.isInteger(bodySeed)||bodySeed<0||bodySeed>2147483647))throw new Error('Body seed must be 0–2147483647.');
 if(!Number.isInteger(referenceTop)||referenceTop<0||referenceTop>512)throw new Error('Reference top must be 0–512.');
 if(!['character-sheet','portrait','full-body'].includes(framing))throw new Error('Unknown framing.');
 if(ledger.jobs.filter(active).length+batchSize>12)throw new Error('The queue is full. Wait for existing jobs to finish.');
 const {compiled,bodyCompiled,prompt,fullBodyPrompt}=compileCharacterSheet(traits,{direction,promptOverride,fullBodyPromptOverride});
 const placement={...referencePlacement(compiled.traits),top:referenceTop};
 const batchId=crypto.randomUUID(),created=new Date().toISOString(),jobs=[];
 const allocation=await storage('begin-write','--expected-bytes',String(batchSize*64*1024*1024),'--key','cast-studio-batch-'+batchId);
 const batch={id:batchId,key:idempotencyKey,fingerprint,storage:allocation};
 for(let i=0;i<batchSize;i++){
  const id=crypto.randomUUID(),jobSeed=(seed+i)%2147483648;
  const j={id,batchId,requestKey:idempotencyKey,batchIndex:i+1,batchSize,created,type:'Character',model:'Krea 2 · LoRA 4000',recipe:contract.recipe,placement,status:'queued',traits:compiled.traits,templateVersion:compiled.version,compiled,manualPrompt:!!promptOverride.trim(),prompt,fullBodyPrompt,bodyCompiled,manualBodyPrompt:!!fullBodyPromptOverride.trim(),bodySeed:((bodySeed??((seed+1000003)%2147483648))+i)%2147483648,seed:jobSeed,steps,passes:2,cfg:1,width:2048,height:1536,framing:'character-sheet',direction};
  const graph=structuredClone(graphTemplate),values={prompt,reference_top:placement.top,reference_height:placement.height,reference_proportions:placement.proportions,seed:jobSeed,steps,cfg:1,width:1024,height:1536,full_body_prompt:fullBodyPrompt,body_seed:j.bodySeed,output_prefix:'cast-studio/'+id+'/sheet',portrait_prefix:'cast-studio/'+id+'/portrait',full_body_prefix:'cast-studio/'+id+'/full-body',raw_body_prefix:'cast-studio/'+id+'/raw-body'};
  for(const input of contract.contracts.character.inputs){if(!graph[input.api_node_id]?.inputs)throw new Error('Contract/API graph mismatch.');graph[input.api_node_id].inputs[input.api_field_key]=values[input.name]}
  const workflow=structuredClone(workflowTemplate);
  for(const input of contract.contracts.character.inputs){const node=workflow.nodes.find(n=>String(n.id)===input.api_node_id);const index=workflow.extra.cast_widget_map[input.api_node_id][input.api_field_key];node.widgets_values[index]=values[input.name]}
  const dir=allocation.path+'/jobs/'+id;fs.mkdirSync(dir,{recursive:true});
  atomic(dir+'/manifest.json',{schemaVersion:3,job:j,graph,workflow,contract,environment,models,graphSha256:hash(graph),contractSha256:hash(contract),promptSha256:hash(prompt),fullBodyPromptSha256:hash(fullBodyPrompt),compilerSha256});
  jobs.push(j);
 }
 ledger.batches.push(batch);ledger.jobs.push(...jobs);save();void tick();return jobs.map(publicJob);
}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>100000)throw new Error('Request too large.')}return JSON.parse(raw)}
function resolveReference(ref){
 if(ref.kind==='gallery'){
  const entry=galleryManifest?.characters.find(c=>c.characterId===ref.id);if(!entry)throw new Error('Character sheet not found.');
  const gallery=read(ROOT+'/src/gallery.json');
  return {path:path.join(process.env.OPENCAST_GALLERY_ROOT||path.join(ROOT,'public','originals'),(ref.role==='manifest'?entry.manifest:entry.outputs[ref.role||'sheet'])),name:gallery.find(c=>c.id===ref.id)?.name||ref.id};
 }
 const job=ledger.jobs.find(j=>j.id===ref.id);if(!job||job.status!=='complete')throw new Error('Choose a completed character.');
 return {path:directory(job)+'/'+({portrait:'portrait.png',body:'full-body.png',manifest:'manifest.json'}[ref.role]||'image.png'),name:publicJob(job).name};
}
const swapApi=swaps({root:ROOT,data:DATA,storage,atomic,read,send,resolveReference,prefix:PREFIX,worker:deployment.swapWorker});
const v1Directory=DATA+'/api-v1';
const mediaStore=localMediaStore({directory:v1Directory+'/media',base:PREFIX+'/api/v1',managedStorage:storage});
const assets=assetService({directory:v1Directory,store:mediaStore});
const legacy=legacyExecutor({assets,motion:swapApi,resolveReference,swapDirectory:DATA+'/swaps',atomic,
 characterDirectory(id){const j=ledger.jobs.find(j=>j.id===id);if(!j)throw fail(404,'Character not found.');return directory(j)},
 characters:{
  list:()=>[...ledger.jobs].reverse().map(publicJob),
  create(input){const pending=submissions.then(()=>createBatch(input));submissions=pending.catch(()=>{});return pending},
  cancel(id){const j=ledger.jobs.find(j=>j.id===id);if(!j)throw fail(404,'Character not found.');if(j.status!=='queued')throw fail(409,'Only waiting jobs can be cancelled.');j.status='cancelled';save();return publicJob(j)},
  rename(id,name){const j=ledger.jobs.find(j=>j.id===id);if(!j)throw fail(404,'Character not found.');const next={...characterNames,[id]:name};atomic(DATA+'/character-names.json',next);Object.assign(characterNames,next);return publicJob(j)}
 }
});
const shared=await configuredExecutor({directory:v1Directory,assets,storage,characterNumberFloor:ledger.jobs.length});
const executor=combinedExecutor(legacy,shared);
setInterval(()=>void shared.tick(),2000);
const v1=apiV1({directory:v1Directory,assets,executor,resources:configuredResources(),allowedOrigins:origins(PORT)});
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost'),route=(url.pathname===PREFIX||url.pathname.startsWith(PREFIX+'/'))?url.pathname.slice(PREFIX.length)||'/':url.pathname;
 if(await v1(req,res,route,url))return;
 if(req.method==='POST'){
  const origin=req.headers.origin;if(origin&&!origins(PORT).includes(origin)){send(res,403,{error:'Origin not allowed'});return}
  if(route.startsWith('/api/swap-uploads/')){if(await swapApi.handle(req,res,route,url))return}
  if(!req.headers['content-type']?.startsWith('application/json')){send(res,415,{error:'JSON required'});return}
  if(await swapApi.handle(req,res,route,url))return;
  if(route==='/api/jobs'){send(res,409,{error:'Reload OpenCast Studio to use the managed generation API.'});return}
  const rename=route.match(/^\/api\/jobs\/([\w-]+)\/name$/);
  if(rename){
   const j=ledger.jobs.find(j=>j.id===rename[1]);if(!j){send(res,404,{error:'Character not found'});return}
   const input=await body(req);
   if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>80||/[\u0000-\u001f\u007f]/.test(input.name)){send(res,400,{error:'Use a character name between 1 and 80 characters, without control characters.'});return}
   const next={...characterNames,[j.id]:input.name.trim()};atomic(DATA+'/character-names.json',next);Object.assign(characterNames,next);send(res,200,publicJob(j));return;
  }
  const cancel=route.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);if(cancel){const j=ledger.jobs.find(j=>j.id===cancel[1]);if(!j){send(res,404,{error:'Job not found'});return}if(j.status!=='queued'){send(res,409,{error:'Only waiting jobs can be cancelled. An image already rendering will finish.'});return}j.status='cancelled';save();send(res,200,publicJob(j));return}
  send(res,404,{error:'Not found'});return;
 }
 if(req.method!=='GET'&&req.method!=='HEAD'){send(res,405,{error:'Method not allowed'});return}
 if(await swapApi.handle(req,res,route,url))return;
 if(route==='/api/health'){let queue=null,error=null;try{queue=await request('/queue')}catch(e){error=String(e)}send(res,200,{model:'Krea 2 Turbo · LoRA 4000',connected:!!queue,queue:queue?{running:queue.queue_running.length,pending:queue.queue_pending.length}:null,workerError:workerError||error,capabilities:{textToImage:true,identityReference:false,motion:swapApi.enabled,swapModel:'H3 Omni · Character Swap V1.5',characterSheet:true,passes:2,width:2048,height:1536},active:ledger.jobs.filter(active).length});return}
 if(route==='/api/jobs'){send(res,200,{jobs:[...ledger.jobs].reverse().map(publicJob)});return}
 const galleryMatch=route.match(/^\/api\/gallery\/([\w-]+)\/(sheet|portrait|body|manifest)$/);
 if(galleryMatch){const entry=galleryManifest?.characters.find(c=>c.characterId===galleryMatch[1]);if(!entry){send(res,404,{error:'Character sheet not found'});return}const kind=galleryMatch[2],relative=kind==='manifest'?entry.manifest:entry.outputs[kind];file(req,res,path.join(process.env.OPENCAST_GALLERY_ROOT||path.join(ROOT,'public','originals'),relative),url.searchParams.has('download')||kind==='manifest'?`${entry.characterId}-${kind}.${kind==='manifest'?'json':'png'}`:null,{immutable:false});return}
 if(route==='/api/workflow'){file(req,res,ROOT+'/workflows/character-sheet.json','cast-character-sheet.json');return}
 if(route==='/api/contract'){send(res,200,{contract,environment,graphSha256:hash(graphTemplate)});return}
 const match=route.match(/^\/api\/jobs\/([\w-]+)(?:\/(image|portrait|full-body|raw-body|manifest))?$/);
 if(match){const j=ledger.jobs.find(j=>j.id===match[1]);if(!j){send(res,404,{error:'Job not found'});return}if(['image','portrait','full-body','raw-body'].includes(match[2])){if(j.status!=='complete'){send(res,409,{error:'Generation is not complete'});return}file(req,res,directory(j)+'/'+match[2]+'.png',url.searchParams.has('download')?`cast-${j.seed}-${match[2]}.png`:null,{immutable:j.status==='complete'});return}if(match[2]==='manifest'){file(req,res,directory(j)+'/manifest.json',`cast-${j.id}.json`);return}send(res,200,publicJob(j));return}
 if(route.startsWith('/api/')){send(res,404,{error:'Not found'});return}
 const safe=decodeURIComponent(route==='/'?'/index.html':route);if(safe.split('/').includes('..')||safe.includes('\0')){send(res,400,{error:'Invalid path'});return}
 if(safe==='/opencast-source.zip'){file(req,res,path.join(process.env.OPENCAST_DIST||path.join(ROOT,'dist'),'opencast-source.zip'),'opencast-source.zip');return}const target=path.join(process.env.OPENCAST_DIST||path.join(ROOT,'dist'),safe);file(req,res,target,null,{immutable:immutableAsset(safe)});
}catch(e){if(!res.headersSent)send(res,400,{error:String(e.message||e)});else res.end()}});
server.listen(PORT,'127.0.0.1',()=>{console.log(`OpenCast Studio listening on ${PORT}; state ${DATA}`);if(process.env.OPENCAST_WORKERS_DISABLED!=='1'){setInterval(()=>void tick(),2000);setInterval(()=>void swapApi.tick(),5000);void tick();void swapApi.tick()}});
