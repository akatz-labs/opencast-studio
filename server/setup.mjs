import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const running=new Set(['queued','running']);
export function setupService({directory,configuration,configurationFile}){
 const root=path.join(directory,'setup'),statusFile=path.join(root,'status.json'),lock=path.join(root,'starting.lock');
 function status(){
  if(!fs.existsSync(statusFile))return null;
  const job=JSON.parse(fs.readFileSync(statusFile));
  if(job.status==='queued'&&!job.pid&&Date.now()-Date.parse(job.createdAt)>30000)return {...job,status:'interrupted',message:'Setup did not start. Select Install missing to retry.'};
  if(running.has(job.status)&&job.pid){try{process.kill(job.pid,0)}catch(error){if(error.code==='ESRCH')return {...job,status:'interrupted',message:'Setup stopped. Select Install missing to resume from its saved receipts.'};throw error}}
  return job;
 }
 return {status,configureModelsRoot(modelsRoot){
  const current=status();if(current&&running.has(current.status))throw Object.assign(new Error('Wait for setup to finish before changing the model folder.'),{status:409});
  // Read the persisted identity too: bootstrap may have pinned it after startup.
  const saved=fs.existsSync(configurationFile)?JSON.parse(fs.readFileSync(configurationFile)):configuration;
  saved.settings={...saved.settings,modelsRoot};
  fs.mkdirSync(path.dirname(configurationFile),{recursive:true});
  fs.writeFileSync(configurationFile+'.next',JSON.stringify(saved,null,2),{mode:0o600});fs.renameSync(configurationFile+'.next',configurationFile);
  Object.assign(configuration,saved);
 },start(){
  fs.mkdirSync(root,{recursive:true});
  const prior=status();if(prior&&running.has(prior.status))return prior;
  let fd;try{fd=fs.openSync(lock,'wx',0o600)}catch(error){if(error.code==='EEXIST')throw Object.assign(new Error('Setup admission is already in progress.'),{status:409});throw error}
  try{
   const id=crypto.randomUUID(),job={id,kind:'setup',status:'queued',progress:0,message:'Preparing this executor',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
   const inputFile=path.join(root,'request.json');
   fs.writeFileSync(inputFile,JSON.stringify({configuration,configurationFile,statusFile,journalFile:path.join(root,'receipts.json'),job}),{mode:0o600});
   fs.writeFileSync(statusFile,JSON.stringify(job),{mode:0o600});
   const log=fs.openSync(path.join(root,'setup.log'),'a',0o600);
   try{const child=spawn(process.execPath,[fileURLToPath(new URL('./setup-worker.mjs',import.meta.url)),inputFile],{detached:true,stdio:['ignore',log,log]});child.unref();child.on('error',error=>{fs.writeFileSync(statusFile,JSON.stringify({...job,status:'failed',message:error.message}),{mode:0o600})});}
   finally{fs.closeSync(log)}
   return job;
  }finally{fs.closeSync(fd);fs.unlinkSync(lock)}
 }};
}
