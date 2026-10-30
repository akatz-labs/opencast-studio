import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import {swaps,swapPrompt} from '../server/swaps.mjs';
import {file} from '../server/files.mjs';

test('Omni graph conditions on one character and original video/audio without masks, SAM, anchors or Turbo',()=>{
 const graph=JSON.parse(fs.readFileSync(new URL('../workflows/h3-omni-no-mask.api.json',import.meta.url)));
 assert.match(graph.model.inputs.unet_name,/fasth3_omniref/);
 assert.equal(graph.adapter.inputs.strength_model,1);
 assert.equal(graph.schedule.inputs.steps,8);
 assert.equal(graph.guider.inputs.cfg,1);
 assert.deepEqual(graph.adapter.inputs.model,['shift',0]);
 assert.deepEqual(graph.reference_conditioning.inputs['ref_images.ref_image_0'],['reference',0]);
 assert.deepEqual(graph.reference_conditioning.inputs['ref_videos.ref_video_0'],['window',5]);
 assert(!JSON.stringify(graph).match(/SAM3|ApplyEditMask|LoadMask|turbo|anchor.png/));
 assert.equal(graph.history.inputs.first_frame_guide,false);
 assert.equal(graph.history.inputs.target_audio_guide,true);
 const prompt=swapPrompt('the woman on the left');assert(prompt.startsWith('Person to replace in <Video 1>: the woman on the left.'));assert.match(swapPrompt(''),/main person/);
});

test('durable swap creation binds actual reference bytes, rejects invalid settings, and reuses request IDs across restart',async t=>{
 const root=path.resolve('.'),data=fs.mkdtempSync(path.join(os.tmpdir(),'cast-swaps-'));
 t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const old=process.env.OPENCAST_SWAP_DISABLED;process.env.OPENCAST_SWAP_DISABLED='1';t.after(()=>{if(old===undefined)delete process.env.OPENCAST_SWAP_DISABLED;else process.env.OPENCAST_SWAP_DISABLED=old});
 const atomic=(p,v)=>fs.writeFileSync(p,JSON.stringify(v)),read=p=>JSON.parse(fs.readFileSync(p));
 const reference=data+'/sheet.png';await sharp({create:{width:32,height:32,channels:3,background:'#37ff05'}}).png().toFile(reference);
 const source=data+'/source.mp4';fs.writeFileSync(source,'retained fixture bytes');
 let allocations=0,failCommit=false;const workspaces=new Map();
 const storage=async(cmd,...args)=>{if(cmd==='begin-write'){const key=args.at(-1);if(workspaces.has(key))return workspaces.get(key);const p=data+'/allocation-'+(++allocations);fs.mkdirSync(p);const record={id:'ws_'+allocations,path:p};workspaces.set(key,record);return record}if(cmd==='commit-write'){if(failCommit)throw new Error('Storage connection interrupted');return{version_id:'asv_fixture'}}throw new Error(cmd)};
 const options={root,data,storage,atomic,read,send:(res,status,value)=>{res.status=status;res.value=value},resolveReference:ref=>{assert.equal(ref.id,'gallery-fixture');return{path:reference,name:'Test character'}}};
 let api=swaps(options);const videoId=crypto.randomUUID();atomic(data+'/swaps/upload-'+videoId+'.json',{kind:'video',path:source,metadata:{duration:5,hasAudio:true},sha256:'source-hash'});
 const input={idempotencyKey:crypto.randomUUID(),videoId,reference:{id:'gallery-fixture',kind:'gallery'},quality:'720p',keepAudio:true,target:'the actor in blue',sourceName:'Test clip'};
 async function create(value){const req={method:'POST',async *[Symbol.asyncIterator](){yield JSON.stringify(value)}};const res={};await api.handle(req,res,'/api/swaps',new URL('http://test/api/swaps'));return res}
 const first=await create(input);assert.equal(first.status,202);assert.equal(first.value.job.status,'queued');
 const manifest=read(data+'/allocation-1/manifest.json');assert.equal(manifest.job.seed,first.value.job.seed);assert.equal(manifest.useMask,false);assert.equal(manifest.useAnchor,false);assert.equal(manifest.graph.prepare.inputs.resolution,'768');
 assert.equal(fs.readFileSync(data+'/allocation-1/source.mp4','utf8'),'retained fixture bytes');
 const duplicate=await create(input);assert.equal(duplicate.value.job.id,first.value.job.id);assert.equal(allocations,1);
 api=swaps(options);assert.equal((await create(input)).value.job.seed,first.value.job.seed);assert.equal(allocations,1);
 await assert.rejects(()=>create({...input,target:'someone else'}),/different settings/);
 for(const patch of [{videoId:'../../etc/passwd'},{quality:'1080p'},{keepAudio:'yes'},{target:'x'.repeat(2001)},{reference:{kind:'url',id:'http://remote'}}])await assert.rejects(()=>create({...input,...patch}));
 const interrupted={...input,idempotencyKey:crypto.randomUUID()};failCommit=true;
 await assert.rejects(()=>create(interrupted),/Storage connection interrupted/);
 const frozen=fs.readFileSync(data+'/allocation-2/manifest.json','utf8');
 failCommit=false;api=swaps(options);const recovered=await create(interrupted);
 assert.equal(recovered.value.job.seed,JSON.parse(frozen).job.seed);assert.equal(fs.readFileSync(data+'/allocation-2/manifest.json','utf8'),frozen);assert.equal(allocations,2);
 const invalidImage=Readable.from(['not an image']);invalidImage.method='POST';invalidImage.headers={'content-type':'image/png'};
 await assert.rejects(()=>api.handle(invalidImage,{},'/api/swap-uploads/image',new URL('http://test')));
 assert.match(read(data+'/allocation-3/rejected.json').error,/unsupported image format/);
});

test('video HTTP supports playback ranges, suffix reads, HEAD and invalid-range responses',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cast-video-'));fs.writeFileSync(dir+'/video.mp4','0123456789');
 const server=http.createServer((req,res)=>file(req,res,dir+'/video.mp4',null));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true})});const url=`http://127.0.0.1:${server.address().port}/video`;
 const range=await fetch(url,{headers:{Range:'bytes=2-5'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 2-5/10');assert.equal(range.headers.get('content-type'),'video/mp4');assert.equal(await range.text(),'2345');
 const suffix=await fetch(url,{headers:{Range:'bytes=-3'}});assert.equal(await suffix.text(),'789');
 const head=await fetch(url,{method:'HEAD',headers:{Range:'bytes=0-1'}});assert.equal(head.status,206);assert.equal(head.headers.get('content-length'),'2');assert.equal(await head.text(),'');
 for(const value of ['bytes=10-','bytes=5-2','bytes=-','bytes=0-1,3-4'])assert.equal((await fetch(url,{headers:{Range:value}})).status,416);
});
