import {isMain} from './entrypoint.mjs';
// A detached child owns a whole operation, independently of app/service windows.
import { readFile, writeFile, rename, mkdir, unlink,lstat,realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashFile } from './storage.mjs';
import { existsSync,readFileSync,writeFileSync,renameSync,mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { captureProcessIdentity,processAlive } from '../dist/process-identity.js';

export async function renameWithRetry(from, to, { platform = process.platform, move = rename, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // Windows readers and antivirus scanners can briefly deny replacement. Keep
  // the previous file intact; never unlink it to work around a sharing lock.
  for (let attempt = 0; ; attempt++) {
    try { return await move(from, to); }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 8) throw error;
      await pause(Math.min(25 * 2 ** attempt, 250));
    }
  }
}
const pendingWrites = new Map();
export function atomicJson(file, value) {
  const document = JSON.stringify(value) + '\n';
  const pending = (pendingWrites.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, document, { mode: 0o600, flag: 'wx' });
      await renameWithRetry(temporary, file);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  });
  pendingWrites.set(file, pending);
  return pending.finally(() => { if (pendingWrites.get(file) === pending) pendingWrites.delete(file); });
}
export function contained(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('Invalid relative file');
  const destination = resolve(root, name), rel = relative(root, destination);
  if (isAbsolute(name) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('File escapes operation directory');
  return destination;
}

async function retainFiles(directory,declared) {
  const root=await realpath(join(directory,'outputs')),files=[];
  const seen=new Set();
  for(const file of declared || []) {
    if(seen.has(file.name))throw new Error('Duplicate retained artifact name');seen.add(file.name);
    const location=contained(root,file.name),actual=await realpath(location);
    if((await lstat(location)).isSymbolicLink()||relative(root,actual).startsWith('..'))throw new Error('Retained artifact leaves the operation root');
    files.push({...file,...await hashFile(location)});
  }
  return files;
}

function claimRunner(directory,request,reattach) {
  const identity=captureProcessIdentity(process.pid);
  if(!identity)return; // Legacy non-Linux adapters retain their old behavior.
  const file=join(directory,'runner-owner.json');
  const requestDigest=createHash('sha256').update(readFileSync(join(directory,'request.json'))).digest('hex');
  const value={version:1,jobId:request.job.id,requestDigest,identity};
  try{writeFileSync(file,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    const original=readFileSync(file,'utf8'),prior=JSON.parse(original);
    if(prior.jobId!==value.jobId||prior.requestDigest!==requestDigest)throw new Error('Runner ownership belongs to another request');
    if(processAlive(prior.identity))throw new Error('The same accepted operation already has a live observer');
    if(!reattach)throw new Error('An earlier runner ended. Inspect its accepted attempt before another execution');
    if(readFileSync(file,'utf8')!==original)throw new Error('Runner ownership changed');
    mkdirSync(join(directory,'observation-history'),{recursive:true,mode:0o700});
    renameSync(file,join(directory,'observation-history','runner-owner-'+randomUUID()+'.json'));
    writeFileSync(file,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
  }
}

async function main(directory,reattach=false) {
  const request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
  // Claim before any checkpoint or adapter mutation. A duplicate observer must
  // never overwrite the real runner's receipt merely because it cannot claim.
  claimRunner(directory,request,reattach);
  for (const [key, value] of Object.entries(request.installation.environment || {})) process.env[key] = String(value);
  process.env.AKATZ_EXECUTOR_JOB_ROOT = directory;
  const checkpoint = async (phase, details = {}) => {
    if (!['preparing', 'rendering', 'finalizing', 'uncertain'].includes(phase)) throw new Error('Invalid execution phase');
    await atomicJson(join(directory, 'checkpoint.json'), { phase, ...details, updatedAt: new Date().toISOString() });
  };
  await checkpoint('preparing');
  try {
    const adapter = await import(request.job.kind==='installation' ? './executor-install.mjs' : pathToFileURL(request.installation.adapter).href);
    if(reattach&&typeof adapter.resumeAccepted!=='function')throw new Error('Adapter cannot observe an accepted attempt');
    const execute=reattach?adapter.resumeAccepted:adapter.run;
    const result = await execute({ job: request.job, installation: request.installation,
      directory, checkpoint, isCancellationRequested: () => existsSync(join(directory,'cancel-requested')),
      runtimeSession: request.job.runtimeSession || null,
      inputFile: name => contained(join(directory, 'inputs'), name),
      outputFile: name => contained(join(directory, 'outputs'), name) });
    await checkpoint('finalizing');
    const files = await retainFiles(directory,result.files);
    await atomicJson(join(directory, 'receipt.json'), { phase: 'completed', result: { ...result, files }, completedAt: new Date().toISOString() });
  } catch (error) {
    // The adapter must explicitly prove failure terminal; an arbitrary exception
    // may have followed a successful GPU submission whose response was lost.
    let diagnostics;
    try{diagnostics={files:await retainFiles(directory,error.files),evidence:error.evidence || null};}
    catch{error.terminal=false;}
    await atomicJson(join(directory, 'receipt.json'), { phase: error.terminal ? (error.cancelled ? 'cancelled' : 'failed') : 'uncertain',
      error: String(error.message || error).slice(0, 4000),...(diagnostics?{diagnostics}:{}), completedAt: new Date().toISOString() });
  }
}
if (isMain(import.meta.url)) {
  await mkdir(join(process.argv[2], 'outputs'), { recursive: true, mode: 0o700 });
  await main(resolve(process.argv[2]),process.argv[3]==='--reattach');
}
