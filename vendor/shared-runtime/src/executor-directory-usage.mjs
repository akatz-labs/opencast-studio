import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
const execute = promisify(execFile);

// du counts allocated blocks, includes hidden files, counts hard links once
// within this directory, and does not follow links inside it. Resolve only the
// requested root, so a model-root alias measures its selected directory.
export async function measureDirectory(path, signal) {
  const measuredAt = () => new Date().toISOString();
  let resolvedPath;
  try {
    resolvedPath = await realpath(path);
    if (!(await stat(resolvedPath)).isDirectory()) return {state:'unavailable', reason:'Not a directory', measuredAt:measuredAt()};
    const {stdout} = await execute('du', ['-sk', resolvedPath], {signal, timeout:30000, maxBuffer:65536, env:{...process.env, LC_ALL:'C'}});
    const match = stdout.match(/^(\d+)\s/);
    const usedBytes = match ? Number(match[1]) * 1024 : NaN;
    if (!Number.isSafeInteger(usedBytes)) throw new Error('Invalid directory measurement');
    return {state:'ready', usedBytes, measuredAt:measuredAt(), resolvedPath};
  } catch (error) {
    return {state:'unavailable', measuredAt:measuredAt(), resolvedPath,
      reason:error.code === 'ENOENT' ? (resolvedPath ? 'Directory measurement is unavailable on this system' : 'Directory not found')
        : error.killed || error.name === 'AbortError' ? 'Directory scan timed out or was stopped'
        : 'Directory could not be fully measured'};
  }
}

// One bounded scan at a time per executor, cached for five minutes. A status
// request never waits for a large directory walk and overlapping polls share it.
export class DirectoryUsage {
  constructor({measure=measureDirectory, clock=Date.now, ttlMs=300000}={}) {
    this.measure=measure;this.clock=clock;this.ttlMs=ttlMs;
    this.entries=new Map();this.running=null;this.closed=false;
    this.controller=new AbortController();
  }
  snapshot(paths) {
    for(const [path] of this.entries) if(!paths.includes(path)) this.entries.delete(path);
    for(const path of paths) {
      let entry=this.entries.get(path);
      if(!entry){entry={value:{state:'measuring'},expires:0,pending:true};this.entries.set(path,entry);}
      else if(this.clock()>=entry.expires) entry.pending=true;
    }
    if(!this.running && !this.closed) {
      this.running=this.scan().finally(()=>{this.running=null;});
    }
    return paths.map(path=>({...this.entries.get(path).value, refreshing:this.entries.get(path).pending}));
  }
  async scan() {
    for(const [path,entry] of this.entries) {
      if(this.closed)break;
      if(!entry.pending)continue;
      try {entry.value=await this.measure(path,this.controller.signal);}
      catch {entry.value={state:'unavailable',reason:'Directory could not be measured',measuredAt:new Date(this.clock()).toISOString()};}
      entry.expires=this.clock()+this.ttlMs;entry.pending=false;
    }
  }
  close(){this.closed=true;this.controller.abort();}
}
