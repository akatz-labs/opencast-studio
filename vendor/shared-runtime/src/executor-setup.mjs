import {access,readFile,readlink,mkdir,writeFile,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,delimiter,dirname,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {digest} from './executor.mjs';
import {contained} from './executor-runner.mjs';
import {modelStorageRoot} from './index.mjs';
import {developmentComfyGit} from './comfygit-development.mjs';
const execute=promisify(execFile);
async function binary(name) {
  const supplied = name==='uv'?process.env.UV_BIN:name==='ffmpeg'?process.env.FFMPEG_BIN:name==='ffprobe'&&process.env.FFMPEG_BIN?join(dirname(process.env.FFMPEG_BIN),'ffprobe'+(process.platform==='win32'?'.exe':'')):null;
  if(supplied)try{await access(supplied,constants.X_OK);return supplied;}catch{}
  for(const directory of [join(homedir(),'.local','bin'),join(homedir(),'.nix-profile','bin'),...(process.env.PATH || '').split(delimiter)]) {
    for(const filename of process.platform==='win32'?[name+'.exe',...(name==='python3'?['python.exe']:[]),name]:[name]) {
      const path=join(directory,filename);if(process.platform==='win32'&&/\\WindowsApps\\/i.test(path))continue;
      try{await access(path,constants.X_OK);return path;}catch{}
    }
  }
  return null;
}
export async function executorSystem(executor,{cgExecutable}={}) {
  const tools=Object.fromEntries(await Promise.all(['cg','uv','python3','ffmpeg','ffprobe','git','g++'].map(async name=>[name,await binary(name)])));
  if(cgExecutable){await access(cgExecutable,constants.X_OK);tools.cg=cgExecutable;}
  let comfygitPython=null;
  if(tools.cg)try{const first=(await readFile(tools.cg,'utf8')).split('\n')[0];if(first.startsWith('#!/'))comfygitPython=first.slice(2).trim();}catch{}
  const comfygitDevelopment=await developmentComfyGit();
  if(comfygitDevelopment){tools.cg=comfygitDevelopment.cg;comfygitPython=comfygitDevelopment.python;}
  return {comfygitDevelopment,platform:process.platform,arch:process.arch,node:process.versions.node,home:homedir(),dataRoot:executor.storage.paths.dataRoot,
    defaultWorkspace:join(executor.storage.paths.dataRoot,'comfygit'),defaultModelsRoot:modelStorageRoot({fallback:join(executor.storage.paths.dataRoot,'models')}),
    tools,comfygitPython,scripts:{comfygitMaterialize:fileURLToPath(new URL('./comfygit-materialize.py',import.meta.url)),comfygitBootstrap:fileURLToPath(new URL('./comfygit-bootstrap.py',import.meta.url))}};
}
export async function stageRecipe(executor,input) {
  if(!Array.isArray(input.files)||!input.files.length||input.files.length>1000)throw new Error('Invalid recipe package');
  const hash=digest(input.files);if(hash!==input.digest)throw new Error('Recipe package digest mismatch');
  const directory=join(executor.root,'recipes',hash);await mkdir(directory,{recursive:true,mode:0o700});
  let bytes=0;
  for(const file of input.files) {
    if(!/\.(toml|json|lock|txt|py|cpp|h|hpp|whl)$/.test(file.name))throw new Error('Unsupported recipe file');
    const destination=contained(directory,file.name),body=Buffer.from(file.body,'base64');bytes+=body.length;if(bytes>16*1024**2)throw new Error('Recipe package is too large');
    await mkdir(dirname(destination),{recursive:true});
    try{await writeFile(destination,body,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;if(digest(await readFile(destination))!==digest(body))throw new Error('Existing recipe package differs');}
  }
  const manifest=await readFile(join(directory,'pyproject.toml'),'utf8');
  return {directory,sha256:digest(manifest),digest:hash,files:input.files.map(file=>({name:file.name,sha256:digest(Buffer.from(file.body,'base64'))}))};
}
export async function runtimePaths(url) {
  const origin=new URL(url);if(!['localhost','127.0.0.1','[::1]'].includes(origin.hostname))throw new Error('Choose a runtime on this executor');
  const response=await fetch(origin.origin+'/system_stats',{signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('Runtime is unavailable');
  const data=await response.json(),args=data.system?.argv || [];
  const argument=key=>args.includes(key)?args[args.indexOf(key)+1]:null;
  if(process.platform==='win32') {
    // Windows has no /proc cwd. Require an explicit runtime root instead of
    // guessing from a shared Python installation or trusting a forwarded URL.
    const base=argument('--base-directory') || (typeof args[0]==='string'&&isAbsolute(args[0])?dirname(args[0]):null);
    if(!base || !isAbsolute(base))throw new Error('Restart this Windows ComfyUI runtime with an explicit --base-directory before adopting it. The existing runtime was preserved.');
    await access(join(base,'main.py'));
    const port=Number(origin.port || '80');
    const script=`$ErrorActionPreference='Stop'; $owners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess -Unique); if($owners.Count -ne 1){throw 'Cannot identify one local runtime process'}; $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owners[0]); if($process.Name -notmatch '^python(?:w|[0-9.]*)?\\.exe$'){throw 'This URL is not a resident Python runtime'}; [pscustomobject]@{pid=$process.ProcessId; executable=$process.ExecutablePath; commandLine=$process.CommandLine} | ConvertTo-Json -Compress`;
    const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:65536});
    const processInfo=JSON.parse(stdout),command=processInfo.commandLine?.match(/^"([^"]+)"|^(\S+)/),python=command?.[1] || command?.[2] || processInfo.executable;
    const user=argument('--user-directory') || join(base,'user');
    return {processId:processInfo.pid,baseDirectory:base,userDirectory:user,outputDirectory:argument('--output-directory') || join(base,'output'),modelsRoot:argument('--models-directory') || join(base,'models'),cacheRoot:join(user,'__h3_relay_cache'),pythonExecutable:python&&isAbsolute(python)?python:null,pythonVersion:data.system?.python_version,pytorchVersion:data.system?.pytorch_version};
  }
  if(process.platform!=='linux')throw new Error('App runtime ownership inspection currently requires Linux');
  const {stdout}=await execute('ss',['-ltnpH','sport = :'+(origin.port || '80')],{windowsHide:true,timeout:5000,maxBuffer:65536});
  const pid=stdout.match(/pid=(\d+)/)?.[1];if(!pid)throw new Error('Cannot identify the local runtime process');
  const comm=(await readFile('/proc/'+pid+'/comm','utf8')).trim();if(!/^python/.test(comm))throw new Error('This URL is not a resident ComfyUI process. Connect the machine that actually owns its GPU.');
  const cwd=await readlink('/proc/'+pid+'/cwd'),command=(await readFile('/proc/'+pid+'/cmdline','utf8')).split('\0')[0];
  const base=argument('--base-directory') || cwd,user=argument('--user-directory') || join(base,'user');
  return {processId:Number(pid),baseDirectory:base,userDirectory:user,outputDirectory:argument('--output-directory') || join(base,'output'),modelsRoot:argument('--models-directory') || join(cwd,'models'),cacheRoot:join(user,'__h3_relay_cache'),
    pythonExecutable:command.startsWith('/')?command:null,pythonVersion:data.system?.python_version,pytorchVersion:data.system?.pytorch_version};
}
export async function recipeModels(executor,{directory,modelsRoot,pythonExecutable}) {
  const recipeRoot=join(executor.root,'recipes');contained(recipeRoot,relative(recipeRoot,directory));
  const python=pythonExecutable || await binary('python3');if(!python)throw new Error('Python 3.11 or newer is required to inspect the manifest');
  const script="import json,pathlib,sys,tomllib; p=tomllib.loads(pathlib.Path(sys.argv[1]).read_text()); m=p.get('tool',{}).get('comfygit',{}); print(json.dumps({'models':m.get('models',{}),'nodes':m.get('nodes',{}),'workflows':m.get('workflows',{})}))";
  const {stdout}=await execute(python,['-c',script,join(directory,'pyproject.toml')],{windowsHide:true,timeout:15000,maxBuffer:4*1024**2});
  const data=JSON.parse(stdout),models=[];
  for(const [hash,model] of Object.entries(data.models)) {
    const file=contained(modelsRoot,model.relative_path || model.filename),size=(await stat(file).catch(()=>null))?.size;
    models.push({hash,filename:model.filename,path:file,expectedSize:model.size || null,present:size!==undefined && (!model.size || size===model.size),sources:model.sources || [],
      workflows:Object.entries(data.workflows).filter(([,workflow])=>(workflow.models || []).some(model=>model.hash===hash)).map(([name])=>name)});
  }
  const unresolvedModels=Object.entries(data.workflows).flatMap(([workflow,definition])=>(definition.models || []).filter(model=>!model.hash || !data.models[model.hash]).map(model=>({workflow,filename:model.filename})));
  return {models,nodes:data.nodes,unresolvedModels};
}
