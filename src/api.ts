import {generationRequest,job,uploadResponse,access,type Job,type GenerationRequest} from '../shared/api-contract';

const base=(import.meta.env.VITE_OPENCAST_API_BASE||`${import.meta.env.BASE_URL}api/v1`).replace(/\/$/,'');
const address=(value:string)=>new URL(value,new URL(base+'/',window.location.href)).href;
export async function request(path:string,body?:unknown){
 const response=await fetch(`${base}/${path}`,{credentials:'include',...(body!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 const value=await response.json();
 if(!response.ok)throw new Error(value.error?.message||`Request failed: ${response.status}`);
 return value;
}
export async function uploadMedia(file:File,kind:'image'|'video'){
 const result=uploadResponse.parse(await request('assets/uploads',{idempotencyKey:crypto.randomUUID(),kind,name:file.name,contentType:file.type,bytes:file.size}));
 if(result.upload){
  const target=result.upload;
  let body:BodyInit=file;
  if(target.fields){const form=new FormData();for(const [key,value] of Object.entries(target.fields))form.append(key,value);form.append('file',file);body=form}
  const url=address(target.url);
  // Object storage gets only the signed upload instructions, never app cookies.
  const response=await fetch(url,{method:target.method,headers:target.headers,body,credentials:new URL(url).origin===new URL(base,window.location.href).origin?'include':'omit'});
  if(!response.ok)throw new Error(`Media upload failed (${response.status}).`);
 }
 return (await request(`assets/${result.asset.id}/complete`,{})).id as string;
}
export const submitGeneration=async(input:GenerationRequest)=>{
 const response=await request('jobs',generationRequest.parse(input));return response.jobs.map((value:unknown)=>job.parse(value)) as Job[];
};
export const resolveAsset=async(id:string)=>access.parse(await request(`assets/${id}/access`));

// Existing components use these presentation fields; execution/storage IDs and
// expiring access URLs remain separate in the wire contract.
function view(value:unknown):any {
 const j=job.parse(value),outputs=Object.fromEntries(Object.entries(j.outputs).map(([role,output])=>[role,address(output.access.url)]));
 const downloads=Object.fromEntries(Object.entries(j.outputs).map(([role,output])=>[role,address(output.access.downloadUrl)]));
 return {...j.details,id:j.id,name:j.name,status:j.status,created:j.createdAt,requestKey:j.requestKey,error:j.error,
  ...outputs,image:outputs.image||null,video:outputs.video||null,poster:outputs.poster||null,manifest:outputs.manifest||'',
  artifacts:outputs,downloads,outputAssets:Object.fromEntries(Object.entries(j.outputs).map(([role,output])=>[role,output.assetId])),
 };
}
export async function api(path:string,body?:any):Promise<any>{
 const [collection,id,action]=path.split('/');
 if(!['jobs','swaps'].includes(collection))throw new Error('Unsupported API operation.');
 const kind=collection==='jobs'?'character':'character-swap';
 if(id)return view(await request(`jobs/${id}${action?'/'+action:''}`,body));
 if(body===undefined)return {jobs:(await request(kind==='character'?'jobs?kind=character':'jobs')).jobs.filter((j:Job)=>kind==='character'?j.kind==='character':j.kind!=='character').map(view)};
 if(body.kind)return {job:view((await submitGeneration(body))[0])};
 if(kind==='character'){
  const {idempotencyKey,...parameters}=body;
  return {jobs:(await submitGeneration({kind,idempotencyKey,parameters})).map(view)};
 }
 const character=body.reference.kind==='upload'?body.reference.id:(await request('assets/import',body.reference)).id;
 const jobs=await submitGeneration({kind,idempotencyKey:body.idempotencyKey,inputs:{video:body.videoId,character},parameters:{prompt:body.target,quality:body.quality,keepAudio:body.keepAudio}});
 return {job:view(jobs[0])};
}

export async function downloadReference(kind:'gallery'|'generated',id:string,role:'sheet'|'manifest'){
 const asset=await request('assets/import',{kind,id,role});const location=await resolveAsset(asset.id);
 const link=document.createElement('a');link.href=address(location.downloadUrl);link.download='';link.click();
}
