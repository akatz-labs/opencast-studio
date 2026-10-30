import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { hashFile } from './storage.mjs';
import { EXECUTOR_PORT } from './executor.mjs';

const tunnels = new Map(), ownedTunnels = new Set();
process.once('exit',()=>{for(const child of ownedTunnels)child.kill();});
async function freePort() {
  const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
export async function executorOrigin(target) {
  return forwardedOrigin(target,'/v1/health');
}
/** Read-only observers use only a runtime declared by the accepted installation. */
export async function runtimeOrigin(target,runtimeUrl) {
  const url=new URL(runtimeUrl);
  if(url.protocol!=='http:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.username || url.password || url.pathname!=='/' || url.search || url.hash)
    throw new Error('Runtime observation requires a loopback HTTP origin');
  return forwardedOrigin({...target,port:Number(url.port || 80)},'/system_stats');
}
async function forwardedOrigin(target,healthPath) {
  if(target.kind==='local')return 'http://127.0.0.1:'+(target.port || EXECUTOR_PORT);
  if(target.kind!=='ssh' || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(target.host || ''))throw new Error('Invalid SSH executor');
  const key=JSON.stringify([target.host,target.sshPort || 22,target.port || EXECUTOR_PORT]);
  if(!tunnels.has(key)) {
    const promise=(async()=>{
      const port=await freePort();
      const child=spawn('ssh',['-N','-T','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',
        '-p',String(target.sshPort || 22),'-L',`127.0.0.1:${port}:127.0.0.1:${target.port || EXECUTOR_PORT}`,'--',target.host],{windowsHide:true,stdio:['ignore','ignore','pipe']});
      ownedTunnels.add(child);child.once('exit',()=>ownedTunnels.delete(child));
      let failure;child.stderr.on('data',()=>{});child.on('error',error=>{failure=error;});child.on('exit',()=>{failure ||= new Error('SSH executor connection closed');tunnels.delete(key);});
      child.unref();child.stderr.unref();
      const origin='http://127.0.0.1:'+port;
      for(let i=0;i<50;i++) {
        if(failure)throw failure;
        try {const response=await fetch(origin+healthPath,{signal:AbortSignal.timeout(1000)});if(response.ok)return {origin,child};}catch{}
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      child.kill();throw new Error('Executor is offline. Connect or set up this machine in Resources.');
    })();
    tunnels.set(key,promise);promise.catch(()=>tunnels.delete(key));
  }
  return (await tunnels.get(key)).origin;
}
export async function closeExecutorConnections() {
  for(const promise of tunnels.values()){try{(await promise).child.kill();}catch{}}tunnels.clear();
}
export class ExecutorClient {
  constructor(target={kind:'local',port:EXECUTOR_PORT}) {this.target=target;}
  async request(path,init={}) {
    if(!path.startsWith('/v1/') || path.startsWith('//') || path.includes('://'))throw new Error('Invalid executor API path');
    const origin=await executorOrigin(this.target);
    const response=await fetch(origin+path,{...init,signal:init.signal || AbortSignal.timeout(120000)});
    if(!response.ok){let value;try{value=await response.json();}catch{}throw Object.assign(new Error(value?.message || 'Executor request failed ('+response.status+')'),{status:response.status});}
    return response;
  }
  async json(path,body,method=body===undefined?'GET':'POST') {return (await this.request(path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})})).json();}
  health(){return this.json('/v1/health');}
  memory(){return this.json('/v1/memory');}
  configureMemory(input){return this.json('/v1/memory',input);}
  releaseMemory(executorId){return this.json('/v1/memory/release',{executorId});}
  registry(appId){return this.json('/v1/executors?appId='+encodeURIComponent(appId));}
  readiness(appId){return this.json('/v1/installations?appId='+encodeURIComponent(appId));}
  submit(input){return this.json('/v1/jobs',input);}
  cancelAdmission(input){return this.json('/v1/jobs/cancel-admission',input);}
  cancel(id){return this.json('/v1/jobs/'+encodeURIComponent(id)+'/cancel',{});}
  reconcile(id,executorId){return this.json('/v1/jobs/'+encodeURIComponent(id)+'/reconcile',{executorId});}
  job(id){return this.json('/v1/jobs/'+encodeURIComponent(id));}
  recoveryPlan(id,input){return this.json('/v1/jobs/'+encodeURIComponent(id)+'/recovery-plan',input);}
  recover(id,input){return this.json('/v1/jobs/'+encodeURIComponent(id)+'/recover',input);}
  async upload(source,name,{signal}={}) {
    const identity=await hashFile(source);
    await this.request('/v1/inputs/'+identity.hash,{method:'PUT',body:createReadStream(source),duplex:'half',signal:signal || AbortSignal.timeout(30*60*1000)});
    return {name,...identity};
  }
  async download(jobId,file,destination,{signal}={}) {
    const response=await this.request('/v1/jobs/'+encodeURIComponent(jobId)+'/files/'+encodeURIComponent(file.name),{signal:signal || AbortSignal.timeout(30*60*1000)});
    await pipeline(Readable.fromWeb(response.body),createWriteStream(destination,{mode:0o600}));
    const actual=await hashFile(destination);if(actual.hash!==file.hash || actual.size!==file.size)throw new Error('Executor output integrity verification failed');
    return destination;
  }
  async wait(id,{onPhase,signal,interval=1000}={}) {
    let previous;
    while(!signal?.aborted) {
      const job=await this.job(id);if(job.phase!==previous){previous=job.phase;await onPhase?.(job);}
      if(['completed','failed','cancelled','uncertain'].includes(job.phase))return job;
      await new Promise(resolve=>setTimeout(resolve,interval));
    }
    throw new Error('Stopped watching executor job; accepted work continues');
  }
}
