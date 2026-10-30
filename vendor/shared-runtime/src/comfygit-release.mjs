/** Exact release verification; never replaces a requested version with "latest". */
import {readFile,writeFile,rename,lstat} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const packages=['comfygit','comfygit-core','comfygit-studio'];
function validateManifest(manifest){
  if(manifest.schemaVersion!==1||manifest.wheels?.length!==3)throw new Error('Invalid ComfyGit release toolchain manifest');
}
function validateRequirements(text){
  for(const line of text.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'))){
    if(!/^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+(?:\s*;.+)?$/.test(line))throw new Error('Release requirements must contain exact registry version pins');
  }
}
async function published(manifest,fetcher){
  if(!/^\d+\.\d+\.\d+$/.test(manifest.version))throw new Error('Release tooling requires an exact stable ComfyGit version');
  const files=[];
  for(const name of packages){
    const response=await fetcher(`https://pypi.org/pypi/${name}/${manifest.version}/json`,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`${name}==${manifest.version} is not available on PyPI (${response.status}); publish ComfyGit first`);
    const data=await response.json(),filename=`${name.replaceAll('-','_')}-${manifest.version}-py3-none-any.whl`;
    const file=data.urls?.find(item=>item.filename===filename&&!item.yanked&&item.packagetype==='bdist_wheel');
    if(!file||!/^https:\/\/files\.pythonhosted\.org\//.test(file.url)||!/^[a-f0-9]{64}$/.test(file.digests?.sha256))throw new Error('Missing verified published wheel: '+filename);
    files.push(file);
  }
  return files;
}
export async function assertPinnedSharedPackage(root){
  if((await lstat(join(root,'node_modules','@akatz','app-config'))).isSymbolicLink())throw new Error('Release blocked: shared layer is development-linked. Run npm ci before release packaging.');
}
export async function verifyReleasedComfyGit(directory,{fetch:fetcher=globalThis.fetch}={}){
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  validateManifest(manifest);
  validateRequirements(await readFile(join(directory,'requirements.txt'),'utf8'));
  if(hash(await readFile(join(directory,'requirements.txt')))!==manifest.requirements_sha256)throw new Error('ComfyGit requirements checksum differs');
  const files=await published(manifest,fetcher);
  for(const file of files){
    const pin=manifest.wheels.find(item=>item.filename===file.filename);
    if(!pin||pin.sha256!==file.digests.sha256||hash(await readFile(join(directory,file.filename)))!==pin.sha256)throw new Error('Bundled ComfyGit wheel is not the published artifact: '+file.filename);
  }
  return {version:manifest.version,source:'pypi',verified:files.map(file=>file.filename)};
}
export async function refreshReleasedComfyGit(directory,{fetch:fetcher=globalThis.fetch}={}){
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  validateManifest(manifest);
  validateRequirements(await readFile(join(directory,'requirements.txt'),'utf8'));
  const files=await published(manifest,fetcher),downloads=[];
  for(const file of files){
    const response=await fetcher(file.url,{signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error('Published wheel download failed');
    const bytes=Buffer.from(await response.arrayBuffer());
    if(hash(bytes)!==file.digests.sha256||basename(file.filename)!==file.filename)throw new Error('Published wheel failed integrity verification');
    downloads.push({file,bytes});
  }
  // Download and validate everything before changing the app's pinned assets.
  for(const {file,bytes} of downloads){const path=join(directory,file.filename);await writeFile(path+'.tmp',bytes);await rename(path+'.tmp',path);}
  manifest.wheels=files.map(file=>({filename:file.filename,sha256:file.digests.sha256}));
  manifest.requirements_sha256=hash(await readFile(join(directory,'requirements.txt')));
  const path=join(directory,'manifest.json');await writeFile(path+'.tmp',JSON.stringify(manifest,null,2)+'\n');await rename(path+'.tmp',path);
  return verifyReleasedComfyGit(directory,{fetch:fetcher});
}
