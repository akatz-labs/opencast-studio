import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {file} from './files.mjs';
import {fail} from './api-state.mjs';

const exec=promisify(execFile),idPattern=/^[a-f0-9-]{36}$/;
export const swapPrompt=target=>`Person to replace in <Video 1>: ${target.trim()||'the main person in the scene'}.\nReplace only that person with the single character shown in <Picture 1>. The close-up and full-body views in the reference depict the same character. Keep that character's face, hair, body proportions, clothing and accessories throughout. Follow the source person's pose, gaze, facial expressions, mouth movements and actions. Preserve the camera motion, scene, lighting, timing and other people. Follow <Audio 1> for the original speech and performance timing. Do not add people, cuts or new actions.`;

export function swaps({root,data,storage,atomic,read,send,resolveReference,prefix='',worker}){
 const base=data+'/swaps';fs.mkdirSync(base,{recursive:true});
 const ledgerPath=base+'/jobs.json',jobs=fs.existsSync(ledgerPath)?read(ledgerPath):[];
 const save=()=>atomic(ledgerPath,jobs);
 const template=read(root+'/workflows/h3-omni-no-mask.api.json');
 const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 const publicJob=j=>({id:j.id,name:j.name,status:j.status,created:j.created,error:j.error,prompt:j.prompt,target:j.target,seed:j.seed,
  quality:j.quality,keepAudio:j.keepAudio,sourceName:j.sourceName,referenceName:j.referenceName,executionSeconds:j.executionSeconds,
  duration:j.duration,width:j.width,height:j.height,storageVersion:j.storageVersion,
  video:j.status==='complete'?`${prefix}/api/swaps/${j.id}/video`:null,
  poster:j.status==='complete'?`${prefix}/api/swaps/${j.id}/poster`:null,
  manifest:`${prefix}/api/swaps/${j.id}/manifest`,source:`${prefix}/api/swaps/${j.id}/source`,reference:`${prefix}/api/swaps/${j.id}/reference`});

 let busy=false,submissions=Promise.resolve();
 async function tick(){
  if(busy||!worker||process.env.OPENCAST_SWAP_DISABLED==='1')return;busy=true;
  try{
   const current=jobs.find(j=>['dispatching','queued-worker','starting','submitting','running','retaining','uncertain'].includes(j.status));
   if(current){
    const stdout=await worker.inspect(current);
    if(stdout.startsWith('{')){
     const state=JSON.parse(stdout);
     Object.assign(current,{status:state.status,error:state.error,executionSeconds:state.executionSeconds,duration:state.duration,width:state.width,height:state.height,storageVersion:state.storageVersion});
     atomic(base+'/'+current.id+'/worker.json',state);
     if(state.status==='complete'&&!current.outputPath){
      current.status='retaining';save();
      const lease=await storage('materialize',state.storageVersion,'--job','cast-swap-delivery-'+current.id);
      const allocation=await storage('begin-write','--expected-bytes','536870912','--key','cast-swap-delivery-'+current.id);
      for(const name of ['output.mp4','poster.jpg','probe.json','result.json','history.json'])fs.copyFileSync(path.join(lease.path,name),path.join(allocation.path,name));
      await storage('release',state.storageVersion,'--lease',lease.lease);
      const retained=await storage('commit-write',allocation.id,'--source-key','cast-swap-delivery-'+current.id,'--key','cast-swap-delivery-'+current.id,'--kind','experiment');
      current.outputPath=allocation.path;current.deliveryVersion=retained.version_id;current.status='complete';
     }
     save();
    }else if(/ActiveState=(failed|inactive)/.test(stdout)||/LoadState=not-found/.test(stdout)){
     current.status='uncertain';current.error='Worker stopped without a result. This attempt will not be resubmitted automatically.';save();
    }else if(current.status==='dispatching'){current.status='queued-worker';save()}
    return;
   }
   const next=jobs.find(j=>j.status==='queued');if(!next)return;
   next.status='dispatching';save();
   // Persist dispatch intent first; one durable systemd unit and coordinator key per attempt.
   await worker.dispatch(next);
   next.status='queued-worker';save();
  }catch(error){console.error('CAST swap worker:',error.message)}finally{busy=false}
 }
 async function upload(req,res,kind){
  const limit=(kind==='video'?200:10)*1024*1024;
  const type=req.headers['content-type']||'';
  if(!type.startsWith(kind==='video'?'video/':'image/'))throw new Error(`Expected ${kind==='video'?'a video':'an image'} file.`);
  if(Number(req.headers['content-length']||0)>limit)throw new Error('Upload is too large.');
  const id=crypto.randomUUID(),allocation=await storage('begin-write','--expected-bytes',String(limit+1024*1024),'--key','cast-upload-'+id);
  const dest=path.join(allocation.path,'upload');let bytes=0,metadata,rejected;
  try{
  await pipeline(req,new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>limit?new Error('Upload is too large.'):null,chunk)}}),fs.createWriteStream(dest,{flags:'wx'}));
  if(kind==='video'){
   const {stdout}=await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',dest],{timeout:30000,maxBuffer:1024*1024});
   const probe=JSON.parse(stdout),video=probe.streams.find(s=>s.codec_type==='video');
   const duration=Number(video?.duration||probe.format?.duration);
   if(!video||!Number.isFinite(duration)||duration<4||duration>30.1||video.width*video.height>3840*2160)throw new Error('Use a 4–30 second video, no larger than 4K.');
   metadata={duration,width:video.width,height:video.height,hasAudio:probe.streams.some(s=>s.codec_type==='audio')};
  }else{
   metadata=await sharp(dest,{limitInputPixels:40000000}).metadata();
   if(!['png','jpeg','webp'].includes(metadata.format))throw new Error('Use a PNG, JPEG or WebP character image.');
  }
  }catch(error){rejected=error;atomic(allocation.path+'/rejected.json',{error:error.message,bytes,kind})}
  // Finalize even a rejected partial upload so it does not hold a scratch reservation forever.
  const retained=await storage('commit-write',allocation.id,'--source-key','cast-upload-'+id,'--key','cast-upload-'+id,'--kind','media');
  if(rejected)throw rejected;
  const record={id,kind,path:dest,allocation,bytes,contentType:type.split(';')[0],sha256:sha(fs.readFileSync(dest)),metadata,storageVersion:retained.version_id};
  atomic(base+'/upload-'+id+'.json',record);send(res,201,{id,kind,metadata});
 }
 async function create(input){
  if(!input||!idPattern.test(input.idempotencyKey)||!idPattern.test(input.videoId)||!['480p','720p'].includes(input.quality)||typeof input.keepAudio!=='boolean'||typeof input.target!=='string'||input.target.length>2000)throw new Error('Invalid swap settings.');
  const ref=input.reference;
  if(!ref||!['gallery','generated','upload'].includes(ref.kind)||typeof ref.id!=='string'||!/^[\w-]+$/.test(ref.id))throw new Error('Choose one character reference.');
  const fingerprint=sha(JSON.stringify({videoId:input.videoId,reference:ref,quality:input.quality,keepAudio:input.keepAudio,target:input.target}));
  const prior=jobs.find(j=>j.id===input.idempotencyKey);
  if(prior){if(prior.fingerprint!==fingerprint)throw new Error('This request key already belongs to different settings.');return publicJob(prior)}
  const source=read(base+'/upload-'+input.videoId+'.json');if(source.kind!=='video')throw new Error('Reference video required.');
  let reference;
  if(ref.kind==='upload'){const uploaded=read(base+'/upload-'+ref.id+'.json');if(uploaded.kind!=='image')throw new Error('Character image required.');reference={path:uploaded.path,name:typeof input.referenceName==='string'?input.referenceName.slice(0,160):'Uploaded character'}}
  else reference=resolveReference(ref);
  const id=input.idempotencyKey,allocation=await storage('begin-write','--expected-bytes','402653184','--key','cast-swap-input-'+id);
  const dir=allocation.path;let j;
  if(fs.existsSync(dir+'/manifest.json')){
   j=read(dir+'/manifest.json').job;if(j.fingerprint!==fingerprint)throw new Error('Retained input belongs to different settings.');
  }else{
  fs.copyFileSync(source.path,dir+'/source.mp4');
  await sharp(reference.path,{limitInputPixels:40000000}).rotate().png().toFile(dir+'/reference.png');
  const seed=crypto.randomInt(2147483648),prompt=swapPrompt(input.target),graph=structuredClone(template);
  graph.reference_conditioning.inputs.prompt=prompt;graph.plan.inputs.seed=seed;
  graph.prepare.inputs.resolution=input.quality==='480p'?'480':'768';
  graph.finish.inputs.audio_mode=input.keepAudio?'source':'none';
  j={id,name:`Swap ${jobs.length+1}`,fingerprint,status:'queued',created:new Date().toISOString(),target:input.target,prompt,seed,
   quality:input.quality,keepAudio:input.keepAudio,sourceName:typeof input.sourceName==='string'?input.sourceName.slice(0,160):'Reference video',
   referenceName:reference.name,reference:ref,inputPath:dir,duration:source.metadata.duration,sourceType:source.contentType||'video/mp4'};
  atomic(dir+'/api.json',graph);
  atomic(dir+'/manifest.json',{schemaVersion:1,job:j,recipe:'h3-omni-v15-no-mask-v1',modelVersion:'asv_4500e35a424a4cc0b07f8ef1109e9a5c',loraSha256:'8f2c3c3eba161df8d0c6099598b4730f641f5ce01e04cd16d2427cff8a35218f',useMask:false,useAnchor:false,qwenPromptWriter:false,audioGuide:true,bodyComposited:false,source:source.metadata,sourceSha256:source.sha256,referenceSha256:sha(fs.readFileSync(dir+'/reference.png')),graphSha256:sha(JSON.stringify(graph)),graph});
  }
  const retained=await storage('commit-write',allocation.id,'--source-key','cast-swap-input-'+id,'--key','cast-swap-input-'+id,'--kind','experiment');
  j.inputVersion=retained.version_id;fs.mkdirSync(base+'/'+id,{recursive:true});jobs.push(j);save();void tick();return publicJob(j);
 }
 async function handle(req,res,route,url){
  if(route==='/api/swap-workflow'&&['GET','HEAD'].includes(req.method)){file(req,res,root+'/workflows/h3-omni-no-mask.api.json','cast-h3-omni-no-mask.api.json');return true}
  const uploadRoute=route.match(/^\/api\/swap-uploads\/(video|image)$/);
  if(req.method==='POST'&&uploadRoute){await upload(req,res,uploadRoute[1]);return true}
  if(route==='/api/swaps'){
   if(req.method==='GET'){send(res,200,{jobs:[...jobs].reverse().map(publicJob)});return true}
   if(req.method==='POST'){
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>10000)throw new Error('Request too large.')}
    const input=JSON.parse(raw),pending=submissions.then(()=>create(input));submissions=pending.catch(()=>{});
    send(res,202,{job:await pending});return true;
   }
  }
  const match=route.match(/^\/api\/swaps\/([a-f0-9-]{36})(?:\/(video|poster|manifest|source|reference|cancel))?$/);
  if(!match)return false;
  const job=jobs.find(j=>j.id===match[1]);if(!job){send(res,404,{error:'Swap not found'});return true}
  const kind=match[2];
  if(req.method==='POST'&&kind==='cancel'){
   if(job.status!=='queued'){send(res,409,{error:'Only swaps waiting in the CAST queue can be cancelled. A dispatched render will finish.'});return true}
   job.status='cancelled';save();send(res,200,publicJob(job));return true;
  }
  if(!['GET','HEAD'].includes(req.method))return false;
  if(!kind){send(res,200,publicJob(job));return true}
  if(['video','poster'].includes(kind)&&job.status!=='complete'){send(res,409,{error:'Swap is not complete'});return true}
  const names={video:'output.mp4',poster:'poster.jpg',manifest:'manifest.json',source:'source.mp4',reference:'reference.png'};
  if(!names[kind])return false;
  const target=path.join(['video','poster'].includes(kind)?job.outputPath:job.inputPath,names[kind]);
  const downloadName=kind==='source'&&job.sourceType==='video/webm'?'source.webm':kind==='source'&&job.sourceType==='video/quicktime'?'source.mov':names[kind];
  file(req,res,target,url.searchParams.has('download')||kind==='manifest'?`cast-${job.id}-${downloadName}`:null,{immutable:true,...(kind==='source'?{contentType:job.sourceType||'video/mp4'}:{})});return true;
 }
 return {handle,tick,enabled:!!worker&&process.env.OPENCAST_SWAP_DISABLED!=='1',list:()=>[...jobs].reverse().map(publicJob),
  create(input){const pending=submissions.then(()=>create(input));submissions=pending.catch(()=>{});return pending},
  cancel(id){const job=jobs.find(j=>j.id===id);if(!job)throw fail(404,'Job not found.');if(job.status!=='queued')throw fail(409,'A dispatched render cannot be cancelled by this worker.');job.status='cancelled';save();return publicJob(job)},
  artifacts(id){const j=jobs.find(j=>j.id===id);if(!j)throw fail(404,'Job not found.');return {
   manifest:{path:j.inputPath+'/manifest.json',contentType:'application/json'},source:{path:j.inputPath+'/source.mp4',contentType:j.sourceType||'video/mp4'},reference:{path:j.inputPath+'/reference.png',contentType:'image/png'},
   ...(j.status==='complete'?{video:{path:j.outputPath+'/output.mp4',contentType:'video/mp4'},poster:{path:j.outputPath+'/poster.jpg',contentType:'image/jpeg'}}:{})
  }}
 };
}
