import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { inspectInstallation } from './executor-readiness.mjs';

function command(step, log, detached=false) {
  if(typeof step.command!=='string' || !Array.isArray(step.args) || step.args.some(arg=>typeof arg!=='string'))throw new Error('Invalid reviewed installation command');
  return spawn(step.command,step.args,{windowsHide:true,cwd:step.cwd,env:{...process.env,...step.environment},detached,stdio:['ignore',log,log],shell:false});
}
export async function run(context) {
  const setup=context.installation.setup || {},owned=[],log=openSync(join(context.directory,'installation.log'),'a',0o600);
  try {
    for(const step of setup.commands || []) {
      await context.checkpoint('preparing',{activity:step.label || 'Installing app resources'});
      await new Promise((resolve,reject)=>{const child=command(step,log);child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error((step.label || 'Installation')+' exited with code '+code)));});
    }
    for(const step of setup.services || []) {
      let healthy=false;
      try{const response=await fetch(step.healthUrl,{signal:AbortSignal.timeout(3000)});healthy=response.ok;}catch{}
      if(healthy)throw new Error('A service already occupies '+step.healthUrl+'. Review a reuse plan instead of starting another runtime.');
      await context.checkpoint('preparing',{activity:step.label || 'Starting app runtime'});
      const child=command(step,log,true);child.unref();owned.push(child);
      let failure;child.once('error',error=>{failure=error;});child.once('exit',code=>{failure ||= new Error('Runtime exited with code '+code);});
      const deadline=Date.now()+120000;
      while(Date.now()<deadline) {
        if(failure)throw failure;
        try{const response=await fetch(step.healthUrl,{signal:AbortSignal.timeout(3000)});if(response.ok){healthy=true;break;}}catch{}
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      if(!healthy)throw new Error('Runtime did not become ready; inspect the installation log');
    }
    const readiness=await inspectInstallation(context.installation,{verifyModels:true});
    if(!readiness.ready)throw new Error(readiness.problems.join('; '));
    return {files:[],readiness,services:owned.map(child=>({pid:child.pid}))};
  }catch(error){for(const child of owned)child.kill('SIGTERM');error.terminal=true;throw error;}
  finally{closeSync(log);}
}
