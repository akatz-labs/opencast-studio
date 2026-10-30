/** Keep local source links separate from portable, content-addressed packages. */
import {mkdtemp,readFile,writeFile,mkdir,rename,rm,symlink,lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);
export async function sharedPackage(mode,app,source){
  if(!['link','pin'].includes(mode))throw new Error('Use link or pin');
  app=resolve(app);source=await realpath(source);
  const pkg=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
  if(!['@akatz/app-config','@akatz/app-kit'].includes(pkg.name))throw new Error('Expected an Akatz shared package');
  const path=join(app,'package.json'),manifest=JSON.parse(await readFile(path,'utf8'));
  if(!manifest.dependencies?.[pkg.name])throw new Error('App must already declare the shared dependency');
  if(mode==='link'){
    const target=join(app,'node_modules',pkg.name);
    const prior=await lstat(target).catch(e=>{if(e.code!=='ENOENT')throw e;});
    if(prior){if(prior.isSymbolicLink()&&await realpath(target)===source)return {name:pkg.name,mode};
      const backup=join(app,'node_modules','.akatz-package-backups',Date.now()+'-'+basename(source));
      await mkdir(resolve(backup,'..'),{recursive:true});await rename(target,backup);}
    await mkdir(resolve(target,'..'),{recursive:true});await symlink(source,target,'dir');
    return {name:pkg.name,mode};
  }
  // Pack without lifecycle scripts. Build generated packages before invoking.
  const temp=await mkdtemp(join(tmpdir(),'akatz-shared-pack-'));
  try{
    const {stdout}=await exec('npm',['pack','--ignore-scripts','--json','--pack-destination',temp],{cwd:source,maxBuffer:8*1024*1024});
    const [packed]=JSON.parse(stdout),bytes=await readFile(join(temp,packed.filename));
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const directory=join(app,'vendor/packages');await mkdir(directory,{recursive:true});
    const target=join(directory,packed.filename.replace(/\.tgz$/,'-'+sha256.slice(0,16)+'.tgz'));
    await writeFile(target,bytes);
    manifest.dependencies[pkg.name]='file:'+relative(app,target).replaceAll('\\','/');
    await writeFile(path,JSON.stringify(manifest,null,2)+'\n');
    // package-lock-only leaves the active development link and runtime alone.
    await exec('npm',['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],{cwd:app,maxBuffer:4*1024*1024});
    return {name:pkg.name,mode,sha256,archive:manifest.dependencies[pkg.name]};
  }finally{await rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [mode,app,...sources]=process.argv.slice(2);
  if(!app||!sources.length)throw new Error('Usage: node shared-package.mjs link|pin APP_ROOT SHARED_SOURCE...');
  for(const source of sources)console.log(await sharedPackage(mode,app,source));
}
