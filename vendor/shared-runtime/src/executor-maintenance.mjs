/** Explicit offline maintenance. It never starts a runner or retries generation. */
import {mkdir,open,unlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {connect} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {backup} from 'node:sqlite';
import {Executor,requireId} from './executor.mjs';
import {inspectAbsentComfyRuntime} from '../dist/absent-comfy-runtime.js';
const run=promisify(execFile),args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--root','--executor','--job','--action','--plan-id','--plan-digest','--out'].includes(args[i])||!args[i+1])throw Error('Expected explicit maintenance options');options[args[i].slice(2)]=args[i+1];}
if(process.platform!=='linux'||!options.root||!options.out||!['plan-cancel-preparation','cancel-preparation','plan-cancel-idle-fence','cancel-idle-fence'].includes(options.action))throw Error('Explicit Linux maintenance options are required');
requireId(options.executor);requireId(options.job);const root=resolve(options.root);
async function requireOffline(){
  const service=await run('systemctl',['--user','show','akatz-executor.service','--property=MainPID','--value']);
  if(service.stdout.trim()!=='0')throw Error('Stop only the verified idle/fenced SDK service before offline maintenance');
  await new Promise((done,fail)=>{const s=connect({host:'127.0.0.1',port:8841});s.setTimeout(2000);s.once('connect',()=>{s.destroy();fail(Error('A worker admission listener remains active'));});s.once('timeout',()=>{s.destroy();fail(Error('Listener state is uncertain'));});s.once('error',e=>{s.destroy();if(e.code==='ECONNREFUSED')done();else fail(e);});});
}
await requireOffline();const lockPath=join(root,'preparation-maintenance.lock'),lock=await open(lockPath,'wx',0o600);await lock.writeFile(String(process.pid));
let executor;
try{
  executor=new Executor({root,dispatch:false,maintenanceGuard:requireOffline,preparationInspector:async(session,owner)=>{await requireOffline();const proof=await inspectAbsentComfyRuntime(session,owner);await requireOffline();return proof;}});
  while(executor.recovering)await new Promise(done=>setTimeout(done,10));
  if(executor.identity!==options.executor)throw Error('Worker identity differs from the reviewed target');
  const folder=join(root,'maintenance-backups');await mkdir(folder,{recursive:true,mode:0o700});await backup(executor.db,join(folder,Date.now()+'-before-preparation-maintenance.sqlite'));
  const confirmation={executorId:options.executor,planId:options['plan-id'],planDigest:options['plan-digest']};
  let result;
  if(options.action==='plan-cancel-preparation')result=await executor.planPreparationCancellation(options.job,options.executor);
  else if(options.action==='cancel-preparation')result=await executor.cancelPreparation(options.job,confirmation);
  else if(options.action==='plan-cancel-idle-fence')result=await executor.planIdleFenceCancellation(options.job,options.executor);
  else result=await executor.cancelIdleFence(options.job,confirmation);
  await writeFile(resolve(options.out),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({jobId:options.job,action:options.action,phase:result.phase||'reviewable-plan',digest:result.digest||result.preparationCancellation?.planDigest||result.idleFenceCancellation?.planDigest,submission:'unknown',generationRetried:false}));
}finally{if(executor)await executor.close();await lock.close();await unlink(lockPath);}
