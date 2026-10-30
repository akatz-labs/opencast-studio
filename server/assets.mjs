import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {atomicJson,digest,fail,serial} from './api-state.mjs';
import {file} from './files.mjs';

const exec=promisify(execFile);
const extensions={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov'};

// Only this storage implementation knows filesystem locations. A hosted store
// supplies issueUpload/receive/inspect/retain/access/serve with object keys instead.
export function localMediaStore({directory,base,managedStorage}){
 return {
  async issueUpload(record){
   const allocation=managedStorage?await managedStorage('begin-write','--expected-bytes',String(record.bytes+1024*1024),'--key','cast-v1-upload-'+record.id):{path:path.join(directory,record.id)};
   fs.mkdirSync(allocation.path,{recursive:true});
   return {allocation,path:path.join(allocation.path,'original'+extensions[record.contentType])};
  },
  upload(record){return {url:`${base}/assets/${record.id}/bytes`,method:'PUT',headers:{'Content-Type':record.contentType},expiresAt:record.expiresAt}},
  async receive(record,req){
   if(Date.now()>Date.parse(record.expiresAt))throw fail(410,'Upload expired; start a new upload.');
   if(req.headers['content-type']?.split(';')[0]!==record.contentType)throw fail(415,'Upload content type differs.');
   if(req.headers['content-length']&&Number(req.headers['content-length'])!==record.bytes)throw fail(400,'Upload size differs.');
   let bytes=0;const temporary=record.storage.path+'.partial';
   // A broken stream leaves a bounded partial that can be replaced by the same upload.
   await pipeline(req,new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>record.bytes?fail(413,'Upload exceeds declared size.'):null,chunk)}}),fs.createWriteStream(temporary,{mode:0o600}));
   if(bytes!==record.bytes)throw fail(400,'Upload size differs.');
   fs.renameSync(temporary,record.storage.path);
  },
  async inspect(record){
   const location=record.storage.path;
   if(!fs.existsSync(location))throw fail(409,'Upload bytes have not arrived.');
   if(fs.statSync(location).size!==record.bytes)throw fail(400,'Stored size differs.');
   let metadata;
   if(record.kind==='image'){
    const image=sharp(location,{limitInputPixels:40000000}),info=await image.metadata();
    if(!['png','jpeg','webp'].includes(info.format)||`image/${info.format}`!==record.contentType||info.pages>1)throw fail(400,'Use a single PNG, JPEG or WebP image matching its media type.');
    await image.stats(); // Decode the bytes, not just the header.
    metadata={width:info.width,height:info.height};
   }else{
    const {stdout}=await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',location],{timeout:30000,maxBuffer:1024*1024});
    const probe=JSON.parse(stdout),video=probe.streams.find(s=>s.codec_type==='video'),duration=Number(video?.duration||probe.format?.duration);
    const formats=probe.format?.format_name||'';
    if(!(record.contentType==='video/webm'?formats.includes('webm'):formats.includes('mov'))||!video||!Number.isFinite(duration)||duration<4||duration>30.1||video.width*video.height>3840*2160)throw fail(400,'Use a 4–30 second MP4, MOV or WebM video, no larger than 4K.');
    metadata={width:video.width,height:video.height,duration,hasAudio:probe.streams.some(s=>s.codec_type==='audio')};
   }
   const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(location))hash.update(chunk);
   return {metadata,sha256:hash.digest('hex')};
  },
  async retain(record){return managedStorage?(await managedStorage('commit-write',record.storage.allocation.id,'--source-key','cast-v1-upload-'+record.id,'--key','cast-v1-upload-'+record.id,'--kind','media')).version_id:null},
  access(record){return {url:`${base}/assets/${record.id}/content`,downloadUrl:`${base}/assets/${record.id}/content?download=1`,expiresAt:null}},
  serve(record,req,res,url){file(req,res,record.storage.path,url.searchParams.has('download')?`cast-${record.id}${extensions[record.contentType]||path.extname(record.storage.path)}`:null,{contentType:record.contentType})},
 };
}

export function assetService({directory,store}){
 const location=path.join(directory,'assets.json');
 const records=fs.existsSync(location)?JSON.parse(fs.readFileSync(location)):[];
 const save=()=>atomicJson(location,records),lock=serial();
 function get(id,owner,ready=true){
  const record=records.find(r=>r.id===id&&r.owner===owner);
  if(!record)throw fail(404,'Asset not found.');
  if(ready&&record.status!=='ready')throw fail(409,'Asset is not ready.');
  return record;
 }
 const publicAsset=r=>({id:r.id,kind:r.kind,name:r.name,contentType:r.contentType,bytes:r.bytes,status:r.status,metadata:r.metadata});
 return {
  store,get,
  async begin(input,owner){return lock(async()=>{
   let record=records.find(r=>r.owner===owner&&r.key===input.idempotencyKey);
   if(record){if(record.fingerprint!==digest(input))throw fail(409,'Upload key belongs to different content.');}
   else{
    record={...input,id:crypto.randomUUID(),owner,key:input.idempotencyKey,fingerprint:digest(input),status:'pending',expiresAt:new Date(Date.now()+3600000).toISOString()};
    record.storage=await store.issueUpload(record);records.push(record);save();
   }
   return {asset:publicAsset(record),upload:record.status==='pending'?await store.upload(record):null};
  })},
  async receive(id,owner,req){return lock(async()=>{const r=get(id,owner,false);if(r.status!=='pending'||r.inspected)throw fail(409,'Upload is already finalized.');await store.receive(r,req)})},
  async complete(id,owner){return lock(async()=>{
   const r=get(id,owner,false);if(r.status==='ready')return publicAsset(r);
   if(r.status==='rejected'){if(!r.retained){r.storageVersion=await store.retain(r);r.retained=true;save()}throw fail(422,'Upload was rejected. Start a new upload.');}
   if(!r.inspected){
    try{Object.assign(r,await store.inspect(r));r.inspected=true;save()}
    catch(error){if(error.status===409)throw error;r.status='rejected';save();r.storageVersion=await store.retain(r);r.retained=true;save();throw fail(422,'Media validation failed: '+error.message)}
   }
   // Persist validation before retention; a failed commit can be resumed safely.
   r.storageVersion=await store.retain(r);r.status='ready';save();return publicAsset(r);
  })},
  register(owner,key,input){
   let r=records.find(r=>r.owner===owner&&r.sourceKey===key);
   if(!r){r={...input,id:crypto.randomUUID(),owner,sourceKey:key,status:'ready'};records.push(r);save()}
   return r;
  },
  async output(owner,key,input){const r=this.register(owner,key,input);return {assetId:r.id,access:await store.access(r)}},
  access(id,owner){return store.access(get(id,owner))},
  serve(id,owner,req,res,url){return store.serve(get(id,owner),req,res,url)},
 };
}
