import fs from 'node:fs';
import {fail} from './api-state.mjs';

const characterFields=['number','batchId','batchIndex','batchSize','traits','prompt','seed','steps','cfg','width','height','templateVersion','framing','direction','manualPrompt','compiled','model','fullBodyPrompt','bodySeed','passes','placement','executionSeconds'];
const swapFields=['prompt','target','seed','quality','keepAudio','sourceName','referenceName','duration','width','height','executionSeconds'];
// Compatibility is entirely server-side: existing ledgers and generated originals
// keep their identities, while the browser receives the same DTO as any new driver.
export function legacyExecutor({assets,characters,motion,resolveReference,characterDirectory,swapDirectory,atomic}){
 const own=owner=>{if(owner!=='local')throw fail(403,'The legacy worker is available only in local mode.')};
 async function present(j,kind,owner){
  const fields=kind==='character'?characterFields:swapFields;
  const result={id:j.id,kind,name:j.name,status:j.status,createdAt:j.created,requestKey:j.requestKey,details:Object.fromEntries(fields.filter(k=>j[k]!==undefined).map(k=>[k,j[k]])),outputs:{},...(j.error?{error:j.error}: {})};
  const entries=kind==='character'?{
   manifest:{path:characterDirectory(j.id)+'/manifest.json',contentType:'application/json'},
   ...(j.status==='complete'?Object.fromEntries([...new Set(['image',...Object.keys(j.artifacts||{})])].map(role=>[role,{path:characterDirectory(j.id)+'/'+role+'.png',contentType:'image/png'}])):{}),
  }:motion.artifacts(j.id);
  for(const [role,input] of Object.entries(entries)){
   if(!fs.existsSync(input.path))continue;
   result.outputs[role]=await assets.output(owner,`${kind}:${j.id}:${role}`,{kind:input.contentType.startsWith('video/')?'video':input.contentType.startsWith('image/')?'image':'document',name:`${j.name} ${role}`,contentType:input.contentType,storage:{path:input.path},bytes:fs.statSync(input.path).size});
  }
  return result;
 }
 function locate(id){const c=characters.list().find(j=>j.id===id);if(c)return {j:c,kind:'character'};const j=motion.list().find(j=>j.id===id);if(j)return {j,kind:'character-swap'};throw fail(404,'Job not found.')}
 return {
  async capabilities(){return {operations:{character:{available:true},'character-swap':{available:!!motion.enabled},'motion-transfer':{available:false,reason:'Pika H3 Flex workflow is being refined.'}},authentication:'local',billing:false}},
  async list(owner,kind){own(owner);const rows=[...(kind&&kind!=='character'?[]:characters.list().map(j=>({j,kind:'character'}))),...(kind&&kind!=='character-swap'?[]:motion.list().map(j=>({j,kind:'character-swap'})))];rows.sort((a,b)=>b.j.created.localeCompare(a.j.created));return Promise.all(rows.map(r=>present(r.j,r.kind,owner)))},
  async get(id,owner){own(owner);const {j,kind}=locate(id);return present(j,kind,owner)},
  async importAsset(ref,owner){own(owner);const source=resolveReference(ref);const r=assets.register(owner,`reference:${ref.kind}:${ref.id}:${ref.role||'sheet'}`,{kind:ref.role==='manifest'?'document':'image',name:source.name,contentType:ref.role==='manifest'?'application/json':'image/png',bytes:fs.statSync(source.path).size,storage:{path:source.path}});return {id:r.id,status:r.status}},
  async submit(input,owner){
   own(owner);
   if(input.kind==='character')return Promise.all((await characters.create({...input.parameters,idempotencyKey:input.idempotencyKey})).map(j=>present(j,'character',owner)));
   if(input.kind!=='character-swap')throw fail(409,'This workflow is not configured.');
   const video=assets.get(input.inputs.video,owner),reference=assets.get(input.inputs.character,owner);
   for(const media of [video,reference])atomic(`${swapDirectory}/upload-${media.id}.json`,{id:media.id,kind:media.kind,path:media.storage.path,bytes:media.bytes,contentType:media.contentType,sha256:media.sha256,metadata:media.metadata});
   const j=await motion.create({idempotencyKey:input.idempotencyKey,videoId:video.id,reference:{kind:'upload',id:reference.id},quality:input.parameters.quality,keepAudio:input.parameters.keepAudio,target:input.parameters.prompt,sourceName:video.name,referenceName:reference.name});
   return [await present(j,'character-swap',owner)];
  },
  async cancel(id,owner){own(owner);const {kind}=locate(id);return present(await (kind==='character'?characters:motion).cancel(id),kind,owner)},
  async rename(id,name,owner){own(owner);const {kind}=locate(id);if(kind!=='character')throw fail(409,'Only characters can currently be renamed.');return present(await characters.rename(id,name),kind,owner)},
 };
}
