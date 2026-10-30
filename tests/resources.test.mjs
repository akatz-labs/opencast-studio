import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resourceService,resourceAction} from '../server/resources.mjs';
const catalog=JSON.parse(fs.readFileSync(new URL('../resources/models.json',import.meta.url)));
function fixture(){
 const calls=[];
 const client={async json(path,body){calls.push({path,body});if(path==='/v1/health')return {executorId:'fixture'};if(path.startsWith('/v1/installations'))return [];if(path.endsWith('/jobs'))return {items:[{id:'scan',kind:'scan',status:'succeeded',progress:1}]};if(path==='/v1/resources/opencast'&&!body)return {models:[{id:'krea2-turbo',state:'installed',verified:true}],storage:{freeBytes:1000},runtimes:[{id:'comfyui',name:'ComfyUI',installed:false,detail:'Offline'}]};return {accepted:true}}};
 return {calls,client,service:resourceService({client,configuration:{target:{kind:'local',port:8841},executorId:'fixture'}})};
}
test('resource inspection is read-only and preserves real model and runtime state',async()=>{
 const {service,calls}=fixture();const result=await service.snapshot();assert.equal(result.connection,'connected');assert.equal(result.models.find(m=>m.id==='krea2-turbo').state,'installed');assert.equal(result.models.find(m=>m.id==='opencast-character').state,'unknown');assert.equal(result.runtimes[0].installed,false);assert.equal(result.jobs[0].status,'succeeded');assert.ok(calls.every(c=>!c.body));
});
test('resource registration and installs use the pinned catalog including gated dependencies',async()=>{
 const {service,calls}=fixture();await service.action({action:'initialize'});const sent=calls.find(c=>c.path==='/v1/resources').body;assert.equal(sent.models.length,14);assert.equal(sent.models.filter(m=>m.acquisition==='manual').length,3);assert.ok(sent.features.every(f=>f.models.every(id=>sent.models.some(m=>m.id===id))));
 await service.action({action:'download',resourceIds:['opencast-character','flux3-vae']});assert.deepEqual(calls.at(-1).body,{resourceIds:['opencast-character','flux3-vae']});
 await service.action({action:'download',resourceIds:['krea2-turbo']});assert.deepEqual(calls.at(-1).body,{resourceIds:['krea2-turbo']});
 for(const ids of [['flux3-edit'],['unknown'],['krea2-turbo','krea2-turbo']])await assert.rejects(()=>service.action({action:'download',resourceIds:ids}));
 assert.throws(()=>resourceAction.parse({action:'download',resourceIds:['krea2-turbo'],url:'https://elsewhere.test/model'}));
});
test('identity mismatch blocks changes and offline status never implies installed',async()=>{
 const {service,client,calls}=fixture();client.json=async path=>{calls.push({path});return {executorId:'different'}};await assert.rejects(()=>service.action({action:'scan'}),/identity changed/);assert.ok(calls.every(c=>c.path==='/v1/health'));assert.equal((await service.snapshot()).connection,'mismatch');
 const unconfigured=await resourceService({}).snapshot();assert.equal(unconfigured.connection,'unconfigured');assert.ok(unconfigured.models.every(m=>m.state==='unknown'));
});
test('model manifest pins complete identities and never invents unpublished sources',()=>{
 assert.equal(catalog.models.length,14);for(const m of catalog.models){assert.match(m.sha256,/^[a-f0-9]{64}$/);assert.match(m.shortHash,/^[a-f0-9]{16}$/);assert.ok(m.sizeBytes>0);assert.ok(!m.relativePath.startsWith('/')&&!m.relativePath.includes('..'));if(m.acquisition==='download'){assert.ok(m.url.includes('/resolve/'+m.revision+'/'));assert.equal(new URL(m.url).protocol,'https:')}else assert.ok(m.sourceNote&&m.url.includes('/resolve/'+m.revision+'/'))}
 const graph=fs.readFileSync(new URL('../workflows/krea-api.json',import.meta.url),'utf8');
 for(const m of catalog.models.filter(m=>m.group==='character'))assert.ok(graph.includes(m.relativePath.split('/').at(-1)),m.id);
});
test('slow inventory stays responsive, coalesces reads, and refresh bypasses the cache',async()=>{
 const {service,client,calls}=fixture(),original=client.json.bind(client);let release;
 const gate=new Promise(resolve=>{release=resolve});let inventoryReads=0;
 client.json=async(path,body)=>{if(path==='/v1/resources/opencast'&&!body){inventoryReads++;await gate}return original(path,body)};
 assert.equal((await service.snapshot()).connection,'checking');
 const next=service.snapshot();release();assert.equal((await next).connection,'connected');
 await service.snapshot();assert.equal(inventoryReads,1);assert.ok(calls.filter(c=>c.path.endsWith('/jobs')).length>=2);
 await service.snapshot({refresh:true});assert.equal(inventoryReads,2);
});

test('onboarding requires models and installed dependencies but not a running GPU process',async()=>{
 const models=catalog.models.map(m=>({...m,state:'installed',verified:true}));let ready=true;
 const client={async json(url){if(url==='/v1/health')return {executorId:'fixture'};if(url.endsWith('/jobs'))return {items:[]};if(url.startsWith('/v1/installations'))return ['krea','pika'].map(profile=>({ready,installation:{configuration:{profile}}}));return {models,storage:{path:'/models',freeBytes:100},runtimes:[{id:'comfyui',name:'ComfyUI',installed:false,detail:'Sleeping'}]}}};
 const service=resourceService({client,configuration:{target:{kind:'local'},executorId:'fixture'}});
 assert.equal((await service.snapshot()).onboarding.state,'ready');ready=false;
 assert.equal((await service.snapshot({refresh:true})).onboarding.state,'required');ready=true;models[0].state='missing';
 assert.equal((await service.snapshot({refresh:true})).onboarding.state,'required');
});
test('model folder is validated, saved before setup and never triggers a download',async()=>{
 let selected;const {client,calls}=fixture();const service=resourceService({client,configuration:{target:{kind:'local'},executorId:'fixture'},setup:{status:()=>null,configureModelsRoot:value=>{selected=value}}});
 for(const bad of ['relative','/','/tmp','/models\n/evil'])assert.throws(()=>resourceAction.parse({action:'model-folder',path:bad}));
 await service.action(resourceAction.parse({action:'model-folder',path:'/media/Models with spaces'}));
 assert.equal(selected,'/media/Models with spaces');assert.equal(calls.length,0);
 assert.equal((await service.snapshot()).modelDirectory.path,selected);
});
