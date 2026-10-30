import {isMain} from './entrypoint.mjs';
import { planRecovery, confirmRecovery } from './executor-recovery.mjs';
import { executorStatus } from './executor-status.mjs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Executor, EXECUTOR_PORT, EXECUTOR_API_VERSION, requireId, digest,executorCapabilities } from './executor.mjs';
import { ExecutorClient, closeExecutorConnections } from './executor-client.mjs';
import { contained } from './executor-runner.mjs';
import {executorSystem,stageRecipe,runtimePaths,recipeModels} from './executor-setup.mjs';
import {ModelResources} from './model-resources.mjs';

const LOCAL_HOSTS=new Set(['127.0.0.1','localhost','[::1]']);
async function jsonBody(req,maxBytes=8*1024**2) {
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Object.assign(new Error('Request is too large'),{status:413});chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export function createExecutorServer(options={}) {
  const executor=new Executor(options);
  const resources=new ModelResources(executor,options.resources);
  let resourcesReady=false;
  resources.ready.then(()=>{resourcesReady=true;},()=>{});
  executor.hasActiveResourceJobs=()=>!resourcesReady || [...resources.jobs.values()].some(job=>['queued','running'].includes(job.status));
  const server=createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try {
      const host=new URL('http://'+req.headers.host);
      if(!LOCAL_HOSTS.has(host.hostname) || req.headers.origin || req.headers['sec-fetch-site']==='cross-site')return send(403,{message:'Use the local app server to access the executor'});
      const url=new URL(req.url,host),parts=url.pathname.split('/').filter(Boolean),method=req.method;
      if(parts[0]!=='v1')return send(404,{message:'Unknown executor API'});
      if(parts[1]==='health' && method==='GET'){await resources.ready;return send(200,{bundleDigest:process.env.AKATZ_EXECUTOR_BUNDLE_DIGEST || null,activeResourceJobs:[...resources.jobs.values()].filter(job=>['queued','running'].includes(job.status)).length,apiVersion:EXECUTOR_API_VERSION,storageRoot:executor.root,capabilities:executorCapabilities(),executorId:executor.identity,phase:executor.jobs().find(row=>['preparing','rendering','finalizing','uncertain'].includes(row.phase))?.phase || 'idle'});}
      if(parts[1]==='sessions' && parts.length===2 && method==='GET')return send(200,{executorId:executor.identity,items:await executor.sessions.observations()});
      if(parts[1]==='memory')await resources.ready;
      if(parts[1]==='memory' && parts.length===2 && method==='GET')return send(200,executor.memory.status());
      if(parts[1]==='memory' && parts.length===2 && method==='POST')return send(200,executor.memory.configure(await jsonBody(req)));
      if(parts[1]==='memory' && parts[2]==='release' && parts.length===3 && method==='POST')return send(200,await executor.releaseMemory((await jsonBody(req)).executorId));
      if(parts[1]==='resources') {
        await resources.ready;
        const appId=parts[2];
        if(parts.length===2&&method==='POST')return send(200,await resources.register(await jsonBody(req)));
        if(parts.length===3&&method==='GET')return send(200,await resources.inventory(appId));
        if(parts[3]==='settings'&&method==='POST')return send(200,await resources.configure(appId,await jsonBody(req)));
        if(parts[3]==='jobs'&&parts.length===4&&method==='GET')return send(200,{items:resources.listJobs(appId)});
        if(parts[3]==='jobs'&&parts[5]==='cancel'&&method==='POST')return send(200,await resources.cancel(appId,parts[4]));
        if(parts[3]==='scan'&&method==='POST')return send(202,await resources.scan(appId));
        if(parts[3]==='download'&&method==='POST'){const body=await jsonBody(req);return send(202,await resources.download(appId,body.resourceIds || []));}
        if(parts[3]==='uninstall-plan'&&method==='POST')return send(200,await resources.uninstallPlan(appId,(await jsonBody(req)).resourceId));
        if(parts[3]==='uninstall'&&method==='POST')return send(202,await resources.uninstall(appId,await jsonBody(req)));
        if(parts[3]==='setup'&&method==='POST')return send(202,await resources.setup(appId,await jsonBody(req)));
        if(parts[3]==='storage'&&method==='POST')return send(202,await resources.setStorage(appId,(await jsonBody(req)).path));
      }
      if(parts[1]==='status' && method==='GET')return send(200,await executorStatus(executor));
      if(parts[1]==='system' && method==='GET')return send(200,await executorSystem(executor,{cgExecutable:url.searchParams.get('cg')}));
      if(parts[1]==='runtime-paths' && method==='POST')return send(200,await runtimePaths((await jsonBody(req)).url));
      if(parts[1]==='recipes' && method==='POST')return send(201,await stageRecipe(executor,await jsonBody(req,24*1024**2)));
      if(parts[1]==='recipe-models' && method==='POST')return send(200,await recipeModels(executor,await jsonBody(req)));
      if(parts[1]==='executors' && parts.length===2) {
        if(method==='POST')return send(200,executor.register(await jsonBody(req)));
        if(method==='GET') {
          const appId=url.searchParams.get('appId') || 'launcher';requireId(appId);
          const items=await Promise.all(executor.listExecutors().map(async target=>{
            try{const client=new ExecutorClient(target),health=target.kind==='local'?{executorId:executor.identity}:await client.health();
              const installations=target.kind==='local'?await executor.readiness(appId==='launcher'?undefined:appId):await client.readiness(appId==='launcher'?'':appId);
              return {...target,online:true,executorId:health.executorId,installations};
            }catch(error){return {...target,online:false,installations:[],error:error.message};}
          }));
          return send(200,{...executor.selection(appId),items});
        }
      }
      if(parts[1]==='preferences' && method==='GET')return send(200,executor.selection(url.searchParams.get('appId') || 'launcher'));
      if(parts[1]==='preferences' && method==='POST') {
        const input=await jsonBody(req);if(input.appId)requireId(input.appId);
        return send(200,{executorId:executor.preference(input.appId?'app:'+input.appId:'default',input.executorId)});
      }
      if(parts[1]==='installations' && method==='GET')return send(200,await executor.readiness(url.searchParams.get('appId')));
      if(parts[1]==='adapters' && parts.length===3 && method==='PUT') {
        const hash=parts[2];if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid adapter digest');
        const record=await executor.storage.putObject('adapter:'+hash,req,{expectedHash:hash,mime:'text/javascript',maxBytes:16*1024**2});
        const path=await executor.storage.materializeObject(record.key,'adapters/'+hash+'.mjs');
        return send(200,{path,hash,size:record.size});
      }
      if(parts[1]==='management-plans') {
        if(method==='POST'&&parts.length===2){const record=await jsonBody(req);requireId(record.appId);if(!['connect','install','desktop'].includes(record.kind))throw new Error('Invalid management plan');const id=randomUUID();executor.db.prepare('INSERT INTO plans VALUES (?,?,?)').run(id,digest(record),JSON.stringify(record));return send(201,{id});}
        if(method==='GET'&&parts.length===3){const row=executor.db.prepare('SELECT document FROM plans WHERE id=?').get(parts[2]);if(!row)return send(404,{message:'Review a new setup plan'});return send(200,JSON.parse(row.document));}
      }
      if(parts[1]==='plans' && method==='POST')return send(201,executor.plan(await jsonBody(req)));
      if(parts[1]==='install' && method==='POST'){const body=await jsonBody(req);return send(200,await executor.install(body.planId,body.digest));}
      if(parts[1]==='inputs' && parts.length===3 && method==='PUT') {
        const hash=parts[2];if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid input hash');
        const record=await executor.storage.putObject('input:'+hash,req,{expectedHash:hash});
        return send(200,{hash:record.hash,size:record.size});
      }
      if(parts[1]==='jobs') {
        if(parts.length===3 && parts[2]==='cancel-admission' && method==='POST')return send(200,await executor.cancelAdmission(await jsonBody(req)));
        if(parts.length===2 && method==='POST')return send(202,await executor.submit(await jsonBody(req)));
        if(parts.length===2 && method==='GET')return send(200,{items:executor.jobs()});
        const job=executor.getJob(parts[2]);if(!job)return send(404,{message:'Job not found'});
        if(parts.length===3 && method==='GET')return send(200,job);
        if(parts.length===4 && parts[3]==='recovery-plan' && method==='POST')return send(200,await planRecovery(executor,job.id,await jsonBody(req)));
        if(parts.length===4 && parts[3]==='recover' && method==='POST')return send(200,await confirmRecovery(executor,job.id,await jsonBody(req)));
        if(parts.length===4 && parts[3]==='reconcile' && method==='POST')return send(200,await executor.reconcileJob(job.id,(await jsonBody(req)).executorId));
        if(parts[3]==='cancel' && method==='POST')return send(200,executor.cancel(job.id));
        if(parts[3]==='files' && parts.length===5 && method==='GET') {
          const name=decodeURIComponent(parts[4]),file=(job.result?.files || job.diagnostics?.files)?.find(item=>item.name===name);
          if(!['completed','failed','cancelled'].includes(job.phase) || !file)return send(404,{message:'Output is not retained'});
          res.writeHead(200,{'content-type':file.mime || 'application/octet-stream','content-length':file.size,'cache-control':'no-store'});
          createReadStream(contained(join(executor.root,'jobs',job.id,'outputs'),name)).on('error',()=>res.destroy()).pipe(res);return;
        }
      }
      send(404,{message:'Unknown executor operation'});
    }catch(error){if(!res.headersSent)send(error.status || 400,{message:error.message});else res.destroy();}
  });
  server.once('listening',()=>executor.register({...executor.listExecutors().find(item=>item.id==='local'),port:server.address().port}));
  return {server,executor,resources,async close(){await new Promise(resolve=>server.close(resolve));await resources.close();await closeExecutorConnections();await executor.close();}};
}
if(isMain(import.meta.url)) {
  const service=createExecutorServer({root:process.env.AKATZ_EXECUTOR_ROOT});
  service.server.listen(Number(process.env.AKATZ_EXECUTOR_PORT || EXECUTOR_PORT),'127.0.0.1',()=>console.log('Akatz executor listening on loopback'));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void service.close().then(()=>process.exit(0));});
}
