import {stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hashFile} from './storage.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const execute=promisify(execFile);
export async function inspectInstallation(installation,{verifyModels=false,httpSnapshots=new Map()}={}) {
  const problems=[],issues=[],failedFeatures=new Set();
  // One fresh snapshot per URL per inspection. Contract probes share an endpoint;
  // repeatedly reading it both races environment locks and mixes observations.
  const readHttp=async url=>{
    if(!httpSnapshots.has(url))httpSnapshots.set(url,(async()=>{
      for(let attempt=0;attempt<3;attempt++){
        const response=await fetch(url,{signal:AbortSignal.timeout(4000)});
        if(response.ok)return response.text();
        if(response.status===503 && response.headers.get('content-type')?.includes('application/json')) {
          const body=await response.json().catch(()=>null);
          if(body?.error==='environment_busy' && body.retryable===true) {
            const seconds=Number(response.headers.get('retry-after'));
            throw Object.assign(new Error('Environment is busy with another operation'),{readinessIssue:{
              code:'environment_busy',retryable:true,
              retryAfterMs:Number.isFinite(seconds)&&seconds>0?Math.min(30000,Math.max(1000,seconds*1000)):1000,
              requestId:typeof body.request_id==='string'?body.request_id.slice(0,128):undefined,
              owner:body.owner && typeof body.owner==='object'?{
                pid:Number.isInteger(body.owner.pid)?body.owner.pid:null,
                operation:typeof body.owner.operation==='string'?body.owner.operation.slice(0,160):null,
                acquiredAt:typeof body.owner.acquired_at==='string'?body.owner.acquired_at.slice(0,64):null,
              }:undefined,
            }});
          }
        }
        if(!response.bodyUsed)await response.body?.cancel();
        const transient=[500,502,503,504].includes(response.status);
        if(!transient||attempt===2)throw new Error('Runtime returned '+response.status+(attempt?' after 3 readiness checks':''));
        // Only this read-only GET is retried. No job, adapter or POST is replayed.
        await delay(150*2**attempt);
      }
    })());
    return httpSnapshots.get(url);
  };
  const observations={...installation.observations};
  const fail=(message,features=installation.features,details={})=>{
    problems.push(message);issues.push({code:'readiness_failed',retryable:false,...details,message,features});
    for(const feature of features)failedFeatures.add(feature);
  };
  try { if((await hashFile(installation.adapter)).hash!==installation.revision)fail('Adapter revision changed'); } catch { fail('App adapter is missing'); }
  for(const probe of installation.probes || []) {
    try {
      if(probe.kind==='file') {
        const value=await stat(probe.path);if(!value.isFile() || value.size<(probe.minimumBytes || 1))throw new Error('Required file is missing or empty');
        if(probe.expectedSize && value.size!==probe.expectedSize)throw new Error('Required model size differs');
        if(probe.sha256 && (await hashFile(probe.path)).hash!==probe.sha256)throw new Error('Required file identity changed');
        if(probe.modelHash) {
          const identity=JSON.stringify([value.dev,value.ino,value.size,value.mtimeMs,value.ctimeMs]);
          if(observations[probe.path]?.identity!==identity || observations[probe.path]?.hash!==probe.modelHash) {
            if(!verifyModels)throw new Error('Model needs integrity verification; run app setup');
            const script="from pathlib import Path\nimport sys\nfrom comfygit_core.repositories.model_repository import calculate_model_short_hash\nprint(calculate_model_short_hash(Path(sys.argv[1])))";
            const {stdout}=await execute(probe.pythonExecutable,['-c',script,probe.path],{windowsHide:true,timeout:20*60*1000,maxBuffer:1024*1024});
            if(stdout.trim()!==probe.modelHash)throw new Error('Model content does not match the manifest');
            const after=await stat(probe.path);if(JSON.stringify([after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs])!==identity)throw new Error('Model changed during verification');
            observations[probe.path]={identity,hash:probe.modelHash,algorithm:'comfygit-model-identity',verifiedAt:new Date().toISOString()};
          }
        }
      } else if(probe.kind==='directory') {
        if(!(await stat(probe.path)).isDirectory())throw new Error('Required runtime directory is missing');
      } else if(probe.kind==='http') {
        const url=new URL(probe.url);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Runtime probes must use worker loopback');
        const body=await readHttp(url.href);
        if(probe.contains && !body.includes(probe.contains))throw new Error('Required workflow is unavailable');
      } else if(probe.kind==='command') {
        const result=await execute(probe.command,probe.args || [],{windowsHide:true,timeout:15000,maxBuffer:1024*1024,env:{...process.env,...probe.environment}});
        if(probe.contains && !(result.stdout+result.stderr).includes(probe.contains))throw new Error('Runtime version does not match');
      } else throw new Error('Unsupported readiness probe');
    }catch(error){fail((probe.name || probe.path || probe.url || probe.command)+': '+error.message,probe.features || installation.features,error.readinessIssue);}
  }
  const features=installation.features.filter(feature=>!failedFeatures.has(feature));
  return {ready:features.length>0,features,problems,issues,observations,checkedAt:new Date().toISOString()};
}

/** Only explicit busy responses can defer a job. Unknown or mixed failures block. */
export function isEnvironmentBusy(readiness,feature) {
  const issues=readiness.issues || [], relevant=issues.filter(issue=>issue.features.includes(feature));
  return relevant.length>0 && relevant.every(issue=>issue.code==='environment_busy'&&issue.retryable===true)
    && (readiness.problems || []).every(message=>issues.some(issue=>issue.message===message));
}
