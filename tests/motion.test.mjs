import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareMotion} from '../server/motion-recipe.mjs';
import {generationRequest} from '../shared/api-contract.ts';
import {combinedExecutor} from '../server/combined-executor.mjs';
import {galleryAsset} from '../server/gallery-assets.mjs';

const read=name=>JSON.parse(fs.readFileSync(new URL('../resources/motion/'+name,import.meta.url)));
const graph=read('pipeline.flat.api.json');
test('portable Explore characters resolve to bundled sheet references without private storage',()=>{
 const characters=JSON.parse(fs.readFileSync(new URL('../src/gallery.json',import.meta.url)));
 for(const character of characters)for(const role of ['sheet','portrait','body']){
  let registered;
  const assets={register:(owner,key,input)=>{registered=input;return {id:key,status:'ready'}}};
  const result=galleryAsset({id:character.id,role},{directory:'/unused',assets,owner:'local'});
  assert.equal(result.status,'ready');assert.equal(registered.contentType,'image/webp');
  assert.ok(fs.statSync(registered.storage.path).size>0);
  if(role==='sheet'&&character.referenceSheet)assert.ok(registered.storage.path.includes(character.referenceSheet.image));
 }
});
test('the installer manifest covers every model loaded by the shipped motion graph',()=>{
 const models=JSON.parse(fs.readFileSync(new URL('../resources/models.json',import.meta.url))).models;
 const folders={unet_name:'diffusion_models',clip_name:'text_encoders',vae_name:'vae',lora_name:'loras'};
 const required=new Set();
 for(const node of Object.values(graph))for(const [key,folder]of Object.entries(folders))if(node.inputs[key])required.add(folder+'/'+node.inputs[key]);
 const motion=models.filter(model=>model.group==='motion');
 assert.deepEqual(new Set(motion.map(model=>model.relativePath)),required);
 for(const model of motion){assert.match(model.sha256,/^[a-f0-9]{64}$/);assert.ok(model.sizeBytes>0);assert.ok(model.url.includes(model.revision));}
});
function expand(g,id){const n=g[id];assert.ok(n,`Missing node ${id}`);return {class_type:n.class_type,inputs:Object.fromEntries(Object.entries(n.inputs).map(([k,v])=>[k,Array.isArray(v)?[expand(g,v[0]),v[1]]:v]))}}
test('native subgraphs reopen to the same executable anchor and Pika graph',()=>{
 const compiled=read('OpenCast-Motion.api.json'),canvas=read('OpenCast-Motion.json');
 assert.equal(canvas.definitions.subgraphs.length,3);
 for(const root of ['23','248'])assert.deepEqual(expand(compiled,root),expand(graph,root));
 assert.equal(graph['7107'].inputs.steps,16);assert.equal(graph['7107'].inputs.cfg,1);
 assert.equal(graph['7117'].inputs['resolution.megapixels'],1);
 assert.equal(graph['7147'].class_type,'TextGenerate');assert.equal(graph['7147'].inputs.max_length,3584);
 assert.equal(graph['7153'].inputs.switch[0],'503');
 assert.ok(!JSON.stringify(graph).match(/LoadDA3|SAM3|gpt-image/i));
 const guide=Object.values(graph).find(n=>n.class_type==='MiniMaxH3AddGuide');assert.deepEqual(guide.inputs.image,['7108',0]);assert.equal(guide.inputs.frame_idx,0);assert.ok(guide.inputs.audio);
});
test('both qualities and motion modes freeze seeds, settings and uploaded asset roles',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'opencast-motion-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 for(const kind of ['character-swap','motion-transfer'])for(const quality of ['480p','720p']){
  const request=generationRequest.parse({idempotencyKey:'00000000-0000-4000-8000-000000000001',kind,inputs:{video:'00000000-0000-4000-8000-000000000002',character:'00000000-0000-4000-8000-000000000003'},parameters:{quality,keepAudio:false,prompt:'The person on the right',seed:123,anchorSeed:456}});
  const result=await prepareMotion({request,directory,inputFiles:{video:'/video.mp4',character:'/sheet.png',...(kind==='motion-transfer'?{background:'/background.png'}:{})}});
  assert.equal(result.inputs.parameters.seed,123);assert.equal(result.inputs.parameters.anchorSeed,456);assert.equal(result.inputs.kind,kind);assert.equal(result.inputs.background,kind==='motion-transfer');assert.equal(result.details.megapixels,quality==='480p'?.5:1);assert.equal(result.files['source-upload'],'/video.mp4');
 }
});
test('legacy history stays readable while all new generation uses the installed driver',async()=>{
 const legacy={capabilities:async()=>({operations:{character:{available:true},'character-swap':{available:true}}}),list:async()=>[{id:'old',createdAt:'2026-01-01'}],get:async()=>({id:'old'}),submit:async()=>['legacy']};
 const current={capabilities:async()=>({operations:{'character-swap':{available:true},'motion-transfer':{available:true}}}),list:async()=>[{id:'new',createdAt:'2026-02-01'}],get:async()=>{throw Object.assign(new Error('Missing'),{status:404})},submit:async()=>['shared']};
 const e=combinedExecutor(legacy,current);assert.deepEqual((await e.list('local')).map(j=>j.id),['new','old']);assert.equal((await e.get('old','local')).id,'old');
 for(const kind of ['character-swap','motion-transfer'])assert.deepEqual(await e.submit({kind},'local'),['shared']);assert.deepEqual(await e.submit({kind:'character'},'local'),['shared']);
});
