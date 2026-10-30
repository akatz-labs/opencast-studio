import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {schemas,generationRequest,uploadRequest,importRequest,renameRequest,assetId} from '../shared/api-contract.ts';
import {atomicJson,digest,fail,serial} from './api-state.mjs';
import {resourceAction} from './resource-contract.mjs';

async function json(req){
 if(!req.headers['content-type']?.startsWith('application/json'))throw fail(415,'JSON required.');
 let bytes=0,parts=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>100000)throw fail(413,'Request too large.');parts.push(chunk)}
 try{return JSON.parse(Buffer.concat(parts).toString())}catch{throw fail(400,'Invalid JSON.')}
}
export function apiV1({directory,assets,executor,resources,principal=()=> 'local',allowedOrigins=[],submitRequest,mediaLimits={}}){
 const location=path.join(directory,'requests.json'),requests=!submitRequest&&fs.existsSync(location)?JSON.parse(fs.readFileSync(location)):[];
 const archivePath=path.join(directory,'history-archive.json');
 const archived=fs.existsSync(archivePath)?JSON.parse(fs.readFileSync(archivePath)):[];
 const save=()=>atomicJson(location,requests),lock=serial();
 const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
 async function submit(input,owner){return lock(async()=>{
  let prior=requests.find(r=>r.owner===owner&&r.key===input.idempotencyKey);
  if(prior&&prior.fingerprint!==digest(input))throw fail(409,'Generation key belongs to different settings.');
  if(prior?.jobIds)return {jobs:await Promise.all(prior.jobIds.map(id=>executor.get(id,owner)))};
  if(!(await executor.capabilities()).operations[input.kind]?.available)throw fail(409,'This workflow is not configured.');
  if(input.inputs)for(const [role,id] of Object.entries(input.inputs)){
   const media=await assets.get(id,owner);if(media.kind!==(role==='video'?'video':'image'))throw fail(400,`Invalid ${role} asset.`);
  }
  if(!prior){prior={owner,key:input.idempotencyKey,fingerprint:digest(input),request:input};requests.push(prior);save()}
  // Executor admission must reconcile this identity after an ambiguous response.
  const jobs=await executor.submit(input,owner);
  prior.jobIds=jobs.map(j=>j.id);save();return {jobs};
 })}
 return async(req,res,route,url)=>{
  if(!route.startsWith('/api/v1/')&&route!=='/api/v1')return false;
  try{
   if(req.headers.origin){
    if(!allowedOrigins.includes(req.headers.origin))throw fail(403,'Origin not allowed.');
    res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Vary','Origin');
   }
   if(req.method==='OPTIONS'){
    if(!req.headers.origin)throw fail(400,'Preflight origin required.');
    res.writeHead(204,{'Access-Control-Allow-Methods':'GET, HEAD, POST, PUT, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'});res.end();return true;
   }
   const owner=await principal(req,res);if(!owner)throw fail(401,'Sign in required.');
   const endpoint=route.slice('/api/v1'.length),method=req.method;
   if(endpoint==='/resources'&&resources){
    if(owner!=='local'&&!(method==='GET'&&resources.readOnly))throw fail(403,'Local resource management is unavailable for this account.');
    if(method==='GET'){send(res,200,await resources.snapshot({refresh:url.searchParams.get('refresh')==='1'}));return true}
    if(method==='POST'){send(res,202,await resources.action(resourceAction.parse(await json(req))));return true}
   }
   if(endpoint==='/capabilities'&&method==='GET'){send(res,200,{apiVersion:1,...await executor.capabilities(),media:{images:['image/png','image/jpeg','image/webp'],videos:['video/mp4','video/webm','video/quicktime'],imageMaxBytes:10485760,videoMaxBytes:209715200,videoMinSeconds:4,videoMaxSeconds:30,...mediaLimits}});return true}
   if(endpoint==='/schemas'&&method==='GET'){send(res,200,{apiVersion:1,schemas:Object.fromEntries(Object.entries(schemas).map(([k,v])=>[k,z.toJSONSchema(v)]))});return true}
   if(endpoint==='/assets/uploads'&&method==='POST'){send(res,201,await assets.begin(uploadRequest.parse(await json(req)),owner));return true}
   if(endpoint==='/assets/import'&&method==='POST'){send(res,200,await executor.importAsset(importRequest.parse(await json(req)),owner));return true}
   const media=endpoint.match(/^\/assets\/([^/]+)\/(bytes|complete|access|content)$/);
   if(media){const id=assetId.parse(media[1]),action=media[2];
    if(action==='bytes'&&method==='PUT'){await assets.receive(id,owner,req);send(res,200,{id});return true}
    if(action==='complete'&&method==='POST'){await json(req);send(res,200,await assets.complete(id,owner));return true}
    if(action==='access'&&method==='GET'){send(res,200,await assets.access(id,owner));return true}
    if(action==='content'&&['GET','HEAD'].includes(method)){await assets.serve(id,owner,req,res,url);return true}
   }
   if(endpoint==='/jobs'&&method==='GET'){
    const kind=url.searchParams.get('kind');if(kind&&!['character','character-swap','motion-transfer'].includes(kind))throw fail(400,'Unknown job kind.');
    const jobs=await executor.list(owner,kind);
    send(res,200,{jobs:jobs.filter(job=>!(['failed','cancelled'].includes(job.status)&&archived.some(entry=>entry.owner===owner&&entry.id===job.id)))});return true;
   }
   if(endpoint==='/jobs'&&method==='POST'){send(res,202,await (submitRequest||submit)(generationRequest.parse(await json(req)),owner));return true}
   const item=endpoint.match(/^\/jobs\/([\w-]+)(?:\/(cancel|name))?$/);
   if(item){
    if(method==='GET'&&!item[2]){send(res,200,await executor.get(item[1],owner));return true}
    if(method==='POST'&&item[2]==='cancel'){await json(req);send(res,200,await executor.cancel(item[1],owner));return true}
    if(method==='POST'&&item[2]==='name'){send(res,200,await executor.rename(item[1],renameRequest.parse(await json(req)).name,owner));return true}
   }
   throw fail(404,'API route not found.');
  }catch(error){
   if(res.headersSent){res.end();return true}
   const status=error instanceof z.ZodError?400:error.status||500;
   if(status===500)console.error('CAST v1:',error);
   send(res,status,{error:{code:status===400?'invalid_request':status===409?'conflict':status===404?'not_found':status===500?'internal_error':'request_failed',message:status===500?'The request could not be completed. Retry with the same request key.':error instanceof z.ZodError?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '):error.message}});
  }
  return true;
 };
}
