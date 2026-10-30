// Installed by content hash on the shared worker. No repository-relative imports.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function run({job,installation,directory,checkpoint,isCancellationRequested,inputFile,outputFile}){
 if(isCancellationRequested())throw Object.assign(new Error('Cancelled before starting generation.'),{terminal:true,cancelled:true});
 const config=installation.configuration,task=job.feature==='character'?'character':'motion';
 const request={...job.inputs,jobId:job.id,environmentRoot:path.join(config.workspace,'environments',config.environment),cg:config.cgExecutable,workspace:config.workspace,graph:task==='character'?inputFile('graph.json'):config.motionGraph,inputs:path.dirname(inputFile(task+'.json')),outputs:path.dirname(outputFile(task==='character'?'image.png':'video.mp4')),directory};
 const requestFile=path.join(directory,task+'-request.json');
 if(fs.existsSync(requestFile))throw new Error('This generation attempt already started; inspect its retained receipts before retrying.');
 fs.writeFileSync(requestFile,JSON.stringify(request),{flag:'wx',mode:0o600});
 const command=[config.pythonExecutable,config.motionWorker,requestFile];
 // Optional trusted deployment launcher owns admission on a shared GPU fleet.
 // A personal installation executes on this machine through the same adapter.
 const prefix=(config.jobLauncher||[]).map(s=>s.replaceAll('{jobId}',job.id));
 const args=[...prefix,...command],log=fs.openSync(path.join(directory,task+'.log'),'a',0o600);
 let exit=null,launchError;
 const child=spawn(args[0],args.slice(1),{stdio:['ignore',log,log],env:{...process.env,COMFYGIT_HOME:config.workspace}});
 fs.closeSync(log);
 child.once('error',error=>{launchError=error});child.once('exit',(code,signal)=>{exit={code,signal}});
 let phase='preparing';
 while(!exit&&!launchError){
  if(isCancellationRequested())fs.writeFileSync(path.join(directory,task+'-cancel'),'cancel\n');
  const statusFile=path.join(directory,task+'-status.json');
  if(fs.existsSync(statusFile)){
   const status=JSON.parse(fs.readFileSync(statusFile));
   const next=status.phase==='rendering'?'rendering':status.phase==='finalizing'?'finalizing':'preparing';
   if(next!==phase||status.stage){phase=next;await checkpoint(phase,{activity:status.stage,backendId:status.promptId})}
  }
  await pause(1000);
 }
 if(launchError)throw Object.assign(launchError,{terminal:true});
 const receiptFile=path.join(directory,task+'-receipt.json');
 if(!fs.existsSync(receiptFile))throw new Error('Generation worker stopped without a receipt; inspect the accepted attempt before retrying.');
 const receipt=JSON.parse(fs.readFileSync(receiptFile));
 if(receipt.status!=='complete')throw Object.assign(new Error(receipt.error||'Generation stopped.'),{terminal:receipt.runtimeStopped===true,cancelled:receipt.status==='cancelled'});
 if(exit.code!==0||!receipt.runtimeStopped)throw new Error('Generation worker completion needs reconciliation.');
 return {files:receipt.files.map(name=>({name})),details:receipt.details};
}
