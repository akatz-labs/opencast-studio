/** Render an explicit gallery plan into an already allocated evidence directory. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const [planFile,root]=process.argv.slice(2);
if(!planFile||!root)throw new Error('Usage: node scripts/render-gallery-sheets.mjs PLAN_JSON ALLOCATED_OUTPUT');
const plan=JSON.parse(await fs.readFile(planFile,'utf8'));
if(!Array.isArray(plan)||new Set(plan.map(r=>r.id)).size!==plan.length||plan.some(r=>!/^[\w-]+$/.test(r.id)||!r.graph||!r.sourcePath))throw new Error('Invalid render plan');
const base=process.env.OPENCAST_COMFY||'http://127.0.0.1:8188';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=async(p,v)=>{await fs.writeFile(p+'.tmp',JSON.stringify(v,null,2)+'\n');await fs.rename(p+'.tmp',p)};
const api=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error(`Comfy ${r.status}: ${await r.text()}`);return r.json()};
for(const row of plan){
 const dir=path.join(root,'renders',row.id);await fs.mkdir(dir,{recursive:true});
 const receiptPath=path.join(dir,'receipt.json');
 let rec=await fs.readFile(receiptPath,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e});
 if(rec?.state==='complete'){console.log('RETAINED',row.id);continue}
 if(rec?.state==='submitting'&&!rec.promptId)throw new Error(`Uncertain submission ${row.id}; inspect queue/history before another attempt`);
 if(!rec){
  const source=await fs.readFile(row.sourcePath);if(hash(source)!==row.sourceSha256)throw new Error('Source hash mismatch '+row.id);
  const graph=structuredClone(row.graph);
  if(row.mode==='existing-portrait'){
   const form=new FormData();form.append('image',new Blob([source],{type:'image/png'}),row.characterId+'-'+row.sourceSha256.slice(0,12)+'.png');
   const response=await fetch(base+'/upload/image',{method:'POST',body:form,signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Reference upload failed');const upload=await response.json();
   graph['8'].inputs.image=(upload.subfolder?upload.subfolder+'/':'')+upload.name;
  }
  rec={...row,graph,graphSha256:hash(JSON.stringify(graph)),state:'prepared',startedAt:new Date().toISOString()};await write(receiptPath,rec);
 }
 if(!rec.promptId){
  const q=await api('/queue');if(q.queue_running.length||q.queue_pending.length)throw new Error('Worker has another prompt; inspect ownership before resuming');
  rec.state='submitting';await write(receiptPath,rec);
  const submission=await api('/prompt',{prompt:rec.graph,client_id:'cast-explore-'+row.id,extra_data:{cast_explore_id:row.id,extra_pnginfo:{cast:{characterId:row.characterId,sourceJob:row.sourceJob,mode:row.mode,placement:row.placement}}}});
  rec.submission=submission;if(!submission.prompt_id){rec.state='failed';await write(receiptPath,rec);throw new Error(JSON.stringify(submission))}
  rec.promptId=submission.prompt_id;rec.state='running';await write(receiptPath,rec);
 }
 let history;const deadline=Date.now()+600000;
 while(Date.now()<deadline){const h=await api('/history/'+rec.promptId);if(h[rec.promptId]){history=h[rec.promptId];break}await new Promise(r=>setTimeout(r,1000))}
 if(!history)throw new Error('Timed out; retained prompt ID for reconciliation');
 await write(path.join(dir,'history.json'),history);
 if(!history.status.completed||history.status.status_str!=='success'){rec.state='failed';rec.error=history.status;await write(receiptPath,rec);throw new Error(JSON.stringify(history.status))}
 rec.outputs={};
 for(const [name,id]of [['sheet','9'],['portrait','21'],['body','22'],['raw-body','23']]){
  const entry=history.outputs[id]?.images?.[0];if(!entry)throw new Error('Missing '+name);
  const response=await fetch(base+'/view?'+new URLSearchParams(entry),{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Output download failed');const bytes=Buffer.from(await response.arrayBuffer());if(bytes.subarray(1,4).toString()!=='PNG')throw new Error('Not a PNG');
  await fs.writeFile(path.join(dir,name+'.png'),bytes);rec.outputs[name]={file:name+'.png',sha256:hash(bytes),bytes:bytes.length,worker:entry};
 }
 const messages=Object.fromEntries(history.status.messages);rec.executionSeconds=(messages.execution_success.timestamp-messages.execution_start.timestamp)/1000;
 rec.state='complete';rec.completedAt=new Date().toISOString();await write(receiptPath,rec);console.log('COMPLETE',row.id,rec.executionSeconds);
}
