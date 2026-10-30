import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {assetService,localMediaStore} from '../server/assets.mjs';
import {apiV1} from '../server/api-v1.mjs';
import {sharedExecutor} from '../server/shared-executor.mjs';
import {generationRequest,job} from '../shared/api-contract.ts';

async function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cast-v1-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const makeAssets=()=>assetService({directory,store:localMediaStore({directory:directory+'/media',base:'/api/v1'})});
 let assets=makeAssets(),submitted=0;const jobs=[];
 const executor={capabilities:async()=>({operations:{character:{available:true},'character-swap':{available:true},'motion-transfer':{available:false}}}),
  submit:async(input,owner)=>{submitted++;const j={id:crypto.randomUUID(),owner,kind:input.kind,name:'Fixture',createdAt:new Date().toISOString(),status:'queued',details:{},outputs:{}};jobs.push(j);return[j]},
  get:async(id,owner)=>{const j=jobs.find(j=>j.id===id&&j.owner===owner);if(!j)throw Object.assign(new Error('Not found'),{status:404});return j},list:async owner=>jobs.filter(j=>j.owner===owner),
 };
 const makeApi=()=>apiV1({directory,assets,executor,principal:req=>req.headers['x-test-owner']||'alice',allowedOrigins:['http://allowed.test']});
 let handler=makeApi();const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');if(!await handler(req,res,url.pathname,url)){res.writeHead(404);res.end()}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>server.close(done)));
 const origin=`http://127.0.0.1:${server.address().port}`;
 async function call(route,body,owner='alice',headers={}){const response=await fetch(origin+'/api/v1/'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-test-owner':owner,...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,value:await response.json()}}
 return {directory,call,origin,get assets(){return assets},get submitted(){return submitted},restart(){assets=makeAssets();handler=makeApi()}};
}

test('uploads, signed access contract, media validation, owner isolation and restart-safe admission',async t=>{
 const f=await fixture(t),bytes=await sharp({create:{width:16,height:24,channels:3,background:'#36ff00'}}).png().toBuffer();
 const input={idempotencyKey:crypto.randomUUID(),kind:'image',name:'face.png',contentType:'image/png',bytes:bytes.length};
 const first=await f.call('assets/uploads',input);assert.equal(first.status,201);const id=first.value.asset.id;
 assert.equal((await f.call('assets/uploads',input)).value.asset.id,id);
 assert.equal((await f.call('assets/uploads',{...input,name:'different.png'})).status,409);
 assert.equal((await f.call(`assets/${id}/complete`,{})).status,409);
 assert.equal((await f.call(`assets/${id}/access`)).status,409);
 assert.equal((await f.call(`assets/${id}/complete`,{},'bob')).status,404);
 const upload=await fetch(f.origin+first.value.upload.url,{method:'PUT',headers:first.value.upload.headers,body:bytes});assert.equal(upload.status,200);
 f.restart();assert.equal((await f.call(`assets/${id}/complete`,{})).value.status,'ready');
 assert.equal((await f.call(`assets/${id}/complete`,{})).value.status,'ready');
 const access=await f.call(`assets/${id}/access`);assert.equal(access.value.expiresAt,null);
 const download=await fetch(f.origin+access.value.downloadUrl);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
 assert(!JSON.stringify(first.value).includes(f.directory));assert.equal((await f.call(`assets/${id}/access`,undefined,'bob')).status,404);
 const request={idempotencyKey:crypto.randomUUID(),kind:'character',parameters:{traits:{},seed:42}};
 const accepted=await f.call('jobs',request);assert.equal(accepted.status,202);job.parse(accepted.value.jobs[0]);
 f.restart();assert.equal((await f.call('jobs',request)).value.jobs[0].id,accepted.value.jobs[0].id);assert.equal(f.submitted,1);
 assert.equal((await f.call('jobs',{...request,parameters:{traits:{},seed:43}})).status,409);
 assert.equal((await f.call('jobs',request,'alice',{Origin:'https://evil.test'})).status,403);
 const swap={idempotencyKey:crypto.randomUUID(),kind:'character-swap',inputs:{video:id,character:id},parameters:{quality:'480p',keepAudio:true}};
 assert.equal((await f.call('jobs',swap)).status,400);
 assert.equal((await f.call('jobs',{...swap,kind:'motion-transfer'})).status,409);
 assert.equal((await f.call('jobs',{...swap,inputs:{video:'https://example.test/video',character:id}})).status,400);
 assert.equal((await f.call('schemas')).status,200);
});

test('untrusted bytes and undeclared fields never reach the executor',async t=>{
 const f=await fixture(t),bad=Buffer.from('not an image');
 const upload=await f.call('assets/uploads',{idempotencyKey:crypto.randomUUID(),kind:'image',name:'fake.png',contentType:'image/png',bytes:bad.length});
 await fetch(f.origin+upload.value.upload.url,{method:'PUT',headers:upload.value.upload.headers,body:bad});
 assert.equal((await f.call(`assets/${upload.value.asset.id}/complete`,{})).status,422);
 const invalid=await f.call('jobs',{idempotencyKey:crypto.randomUUID(),kind:'character',parameters:{traits:{},seed:1},executorId:'redirect-worker'});assert.equal(invalid.status,400);assert.equal(f.submitted,0);
});

test('shared SDK transport reconciles lost acceptance, pins identity, retains output and survives restart',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cast-shared-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const bytes=await sharp({create:{width:4,height:4,channels:3,background:'green'}}).png().toBuffer(),hash=crypto.createHash('sha256').update(bytes).digest('hex');
 let remote,admissions=0,accepted=0;const requests=[];
 const server=http.createServer(async(req,res)=>{
  let chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
  const send=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value))};
  if(req.url.startsWith('/v1/inputs/')){send({hash:req.url.split('/').at(-1),size:body.length});return}
  if(req.url==='/v1/jobs'){
   admissions++;const request=JSON.parse(body);requests.push(request);
   if(!remote){accepted++;remote={...request,id:crypto.randomUUID(),phase:'completed',createdAt:new Date().toISOString(),result:{files:[{name:'sheet.png',hash,size:bytes.length}]}};req.socket.destroy();return}
   assert.deepEqual(request,requests[0]);send(remote);return;
  }
  if(req.url.endsWith('/files/sheet.png')){res.writeHead(200);res.end(bytes);return}
  if(remote&&req.url===`/v1/jobs/${remote.id}`){send(remote);return}
  res.writeHead(404);res.end();
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>server.close(done)));
 const assets=assetService({directory,store:localMediaStore({directory:directory+'/media',base:'/api/v1'})});
 const configuration={appId:'cast-studio',instanceId:'test-instance',executorId:'executor-test',target:{kind:'local',port:server.address().port}};
 let prepared=0;
 const recipes={character:{installationId:'pinned-installation',feature:'character',revision:'recipe-test',outputs:{image:{name:'sheet.png',contentType:'image/png'}},async prepare({request,directory}){prepared++;fs.writeFileSync(directory+'/graph.json','{}');return {inputs:{seed:request.parameters.seed},files:{'graph.json':directory+'/graph.json'},details:{seed:request.parameters.seed}}}}};
 let driver=sharedExecutor({directory,assets,configuration,recipes});
 const request=generationRequest.parse({kind:'character',idempotencyKey:crypto.randomUUID(),parameters:{traits:{},seed:17}});
 const [first]=await driver.submit(request,'alice');assert.equal(first.status,'queued');
 await driver.tick();assert.equal((await driver.get(first.id,'alice')).status,'submitting');
 driver=sharedExecutor({directory,assets,configuration,recipes});await driver.tick();
 const done=await driver.get(first.id,'alice');assert.equal(done.status,'complete');assert.equal(prepared,1);assert.equal(accepted,1);assert.equal(admissions,2);
 assert.equal(requests[0].sourceJobId,first.id);assert.equal(requests[0].installationId,'pinned-installation');
 assert.equal((await driver.submit(request,'alice'))[0].id,first.id);
 assert.deepEqual(fs.readFileSync(assets.get(done.outputs.image.assetId,'alice').storage.path),bytes);
 assert.equal((await driver.importAsset({kind:'generated',id:first.id},'alice')).id,done.outputs.image.assetId);
 await assert.rejects(()=>driver.get(first.id,'bob'),/not found/i);
 assert(!JSON.stringify(done).includes(directory));job.parse(done);
});

test('worker outage keeps character identity, numbering and settings until recovery',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'opencast-recovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const configuration={characterNumberFloor:66,executorId:'test',instanceId:'local'};
 const recipe={installationId:'krea',feature:'character',revision:'test',outputs:{},prepare:async()=>({inputs:{kind:'character'},files:{},details:{}})};
 const recipes={character:recipe};let submits=0;
 const client={submit:async a=>{submits++;return {...a,id:'remote',phase:'rendering',activity:'character'}}};
 const driver=sharedExecutor({directory,assets:{},configuration,recipes,client});
 const request=generationRequest.parse({kind:'character',idempotencyKey:crypto.randomUUID(),parameters:{traits:{},seed:42,batchSize:2}});
 const jobs=await driver.submit(request,'local');assert.deepEqual(jobs.map(j=>j.name),['Character 67','Character 68']);
 delete recipes.character;await driver.tick();
 const waiting=await driver.get(jobs[0].id,'local');assert.equal(waiting.status,'queued-worker');assert.match(waiting.error,/worker connection/);assert.equal(submits,0);
 recipes.character=recipe;await driver.tick();
 const running=await driver.get(jobs[0].id,'local');assert.equal(running.status,'running');assert.equal(running.error,undefined);assert.equal(running.details.seed,42);assert.equal(submits,2);
 assert.deepEqual((await driver.submit(request,'local')).map(j=>j.id),jobs.map(j=>j.id));
});
