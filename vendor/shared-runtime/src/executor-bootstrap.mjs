import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { digest, EXECUTOR_PORT } from './executor.mjs';
import { ExecutorClient } from './executor-client.mjs';

const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
// Passed as fixed program text, with all variable data on stdin. It installs only
// the reviewed package under the requesting user's own data directory.
const BOOTSTRAP = String.raw`
import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';import {homedir} from 'node:os';import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
let input='';for await(const chunk of process.stdin)input+=chunk;const plan=JSON.parse(input);
const hash=value=>createHash('sha256').update(value).digest('hex');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22 || (major===22&&minor<16))throw new Error('Install Node.js 22.16 or newer first');
if(hash(JSON.stringify(plan.files))!==plan.bundleDigest)throw new Error('Executor bundle digest mismatch');
const root=process.env.AKATZ_DATA_ROOT || (process.platform==='darwin'?join(homedir(),'Library','Application Support','Akatz'):process.platform==='win32'?join(process.env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'Akatz'):join(process.env.XDG_DATA_HOME || join(homedir(),'.local','share'),'akatz'));
const origin='http://127.0.0.1:'+plan.port;
mkdirSync(join(root,'executor'),{recursive:true,mode:0o700});
const lockPath=join(root,'executor','bootstrap.lock');let locked=false;
for(let attempt=0;attempt<100;attempt++){
  try{mkdirSync(lockPath,{mode:0o700});locked=true;break;}
  catch(error){if(error.code!=='EEXIST')throw error;await new Promise(resolve=>setTimeout(resolve,200));}
}
if(!locked)throw new Error('Another executor setup is in progress. If it has stopped, inspect and remove its bootstrap.lock directory before retrying.');
process.once('exit',()=>rmSync(lockPath,{recursive:true,force:true}));
let upgrade=false;
try{
 const response=await fetch(origin+'/v1/health',{signal:AbortSignal.timeout(1500)});
 if(response.ok){
  const health=await response.json();if(health.apiVersion!==1)throw new Error('Incompatible existing executor');
  if((!plan.update||health.bundleDigest===plan.bundleDigest)&&(plan.requiredCapabilities||[]).every(capability=>health.capabilities?.includes(capability))){console.log(JSON.stringify({reused:true,...health}));process.exit(0);}
  if(health.activeResourceJobs)throw new Error('Wait for active model resource jobs before updating resource support');
  const jobs=await fetch(origin+'/v1/jobs',{signal:AbortSignal.timeout(3000)});if(!jobs.ok)throw new Error('Cannot verify existing executor jobs');
  if((await jobs.json()).items.some(job=>!['completed','failed','cancelled'].includes(job.phase)))throw new Error('Wait for active executor jobs before updating resource support');
  upgrade=true;
 }
}catch(error){if(!['fetch failed','The operation was aborted due to timeout'].includes(error.message))throw error;}

const directory=join(root,'executor','releases',plan.bundleDigest);mkdirSync(directory,{recursive:true,mode:0o700});
for(const file of plan.files){if(!/^(?:(?:src|dist)\/)?[a-zA-Z0-9._-]+$/.test(file.name)||file.name.split('/').some(part=>part==='.'||part==='..'))throw new Error('Unsafe package filename');const destination=join(directory,file.name);mkdirSync(dirname(destination),{recursive:true,mode:0o700});const bytes=Buffer.from(file.body,'base64');if(existsSync(destination)){if(hash(readFileSync(destination))!==hash(bytes))throw new Error('Existing executor release differs');}else writeFileSync(destination,bytes,{mode:0o600});}
const entry=join(directory,'src','executor-server.mjs'),logPath=join(root,'executor','service.log');
let supervision='detached';
let userSystemd=false;
if(process.platform==='linux'&&process.env.AKATZ_EXECUTOR_NO_SERVICE!=='1')try{execFileSync('systemctl',['--user','show-environment'],{windowsHide:true,stdio:'ignore'});userSystemd=true;}catch{}
if(userSystemd){
    const unitDirectory=join(process.env.XDG_CONFIG_HOME || join(homedir(),'.config'),'systemd','user');mkdirSync(unitDirectory,{recursive:true});
    const unit=join(unitDirectory,'akatz-executor.service');
    if(existsSync(unit)){
      if(!upgrade)throw new Error('An executor service is configured but offline. Start or repair that existing service before installing another.');
      const previous=readFileSync(unit,'utf8');
      if(!previous.includes('Description=Akatz shared generation executor')||!previous.includes(join(root,'executor','releases')))throw new Error('Existing executor service is not owned by the shared installer');
      writeFileSync(unit+'.before-resources-upgrade',previous,{mode:0o600});
    }
    const quote=value=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';
    writeFileSync(unit,'[Unit]\nDescription=Akatz shared generation executor\nAfter=network.target\n\n[Service]\nType=simple\nExecStart='+quote(process.execPath)+' '+quote(entry)+'\nEnvironment=AKATZ_EXECUTOR_PORT='+plan.port+'\nEnvironment=AKATZ_EXECUTOR_BUNDLE_DIGEST='+plan.bundleDigest+'\nRestart=on-failure\nKillMode=process\n\n[Install]\nWantedBy=default.target\n',{mode:0o600});
    execFileSync('systemctl',['--user','daemon-reload'],{windowsHide:true,stdio:'ignore'});execFileSync('systemctl',['--user',...(upgrade?['restart']:['enable','--now']),'akatz-executor.service'],{stdio:'ignore'});supervision='systemd-user';
}
if(supervision==='detached'&&upgrade)throw new Error('Restart the existing detached executor with the updated shared package; its jobs are preserved.');
if(supervision==='detached'){const log=openSync(logPath,'a',0o600);const child=spawn(process.execPath,[entry],{windowsHide:true,detached:true,stdio:['ignore',log,log],env:{...process.env,AKATZ_EXECUTOR_PORT:String(plan.port)}});child.unref();closeSync(log);}
for(let i=0;i<50;i++){try{const response=await fetch(origin+'/v1/health',{signal:AbortSignal.timeout(1000)});if(response.ok){console.log(JSON.stringify({reused:false,supervision,...await response.json()}));process.exit(0);}}catch{}await new Promise(r=>setTimeout(r,200));}
throw new Error('Executor did not become ready. Inspect its service log.');
`;

export async function bootstrapPlan(target={id:'local',name:'This machine',kind:'local',port:EXECUTOR_PORT},{requiredCapabilities=[],update=false}={}) {
  const names=(await readdir(new URL('./',import.meta.url))).filter(name=>name.endsWith('.mjs')||name.endsWith('.py'));
  const files=[];
  for(const name of names.sort())files.push({name:'src/'+name,body:(await readFile(new URL(name,import.meta.url))).toString('base64')});
  for(const name of (await readdir(new URL('../dist/',import.meta.url))).filter(name=>name.endsWith('.js')).sort())files.push({name:'dist/'+name,body:(await readFile(new URL('../dist/'+name,import.meta.url))).toString('base64')});
  const packageBytes=await readFile(new URL('../package.json',import.meta.url));files.push({name:'package.json',body:packageBytes.toString('base64')});
  files.push({name:'LICENSE',body:(await readFile(new URL('../LICENSE',import.meta.url))).toString('base64')});
  const bundleDigest=digest(JSON.stringify(files));
  const plan={target,requiredCapabilities,update,port:target.port || EXECUTOR_PORT,bundleDigest,files,
    description:'Set up or reuse the shared executor in this user account. App runtimes and models are installed separately.',
    writes:['Akatz user data: executor package and queue','User service configuration when supported'],downloads:[],requires:['Node.js 22.16 or newer',...(target.kind==='ssh'?['Existing SSH access']:[])]};
  return {...plan,digest:digest(plan)};
}
export async function bootstrapExecutor(plan,confirmation) {
  const {digest:expected,...body}=plan;if(expected!==confirmation || digest(body)!==expected)throw new Error('Bootstrap confirmation does not match the plan');
  const target=plan.target;
  if(!['local','ssh'].includes(target.kind))throw new Error('Unsupported executor connection');
  if(target.kind==='ssh' && !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(target.host || ''))throw new Error('Invalid SSH host');
  const command=target.kind==='local'?process.execPath:'ssh';
  const args=target.kind==='local'?['--input-type=module','-e',BOOTSTRAP]:['-T','-o','BatchMode=yes','-o','ConnectTimeout=8','-p',String(target.sshPort || 22),'--',target.host,'node --input-type=module -e '+shellQuote(BOOTSTRAP)];
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',errors='';
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors=(errors+chunk).slice(-4000));
    child.on('error',reject);child.stdin.on('error',()=>{});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Executor setup timed out; check the machine before retrying'));},60000);
    child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error(errors || 'Executor setup failed'));try{resolve(JSON.parse(output));}catch{reject(new Error('Executor setup returned an invalid receipt'));}});
    child.stdin.end(JSON.stringify(plan));
  });
}
export async function ensureLocalExecutor(target={id:'local',name:'This machine',kind:'local',port:EXECUTOR_PORT},{requiredCapabilities=[]}={}) {
  const client=new ExecutorClient(target);try{const health=await client.health();if(requiredCapabilities.every(capability=>health.capabilities?.includes(capability)))return health;}catch{}
  const plan=await bootstrapPlan(target,{requiredCapabilities});return bootstrapExecutor(plan,plan.digest);
}
