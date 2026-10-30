import {readFile,readdir} from 'node:fs/promises';
import {join,posix,win32} from 'node:path';
import {digest} from './executor.mjs';

export async function stageAppRecipe(client,directory,expectedSha256,{extraFiles=[]}={}) {
  const files=[];
  async function visit(folder,prefix='') {
    for(const entry of (await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(entry.name.startsWith('.'))continue;
      const name=prefix+entry.name;
      if(entry.isDirectory())await visit(join(folder,entry.name),name+'/');
      else if(/\.(toml|json|lock|txt)$/.test(name))files.push({name,body:(await readFile(join(folder,entry.name))).toString('base64')});
    }
  }
  await visit(directory);
  for(const file of extraFiles){if(files.some(existing=>existing.name===file.name))throw new Error('Duplicate app recipe file');files.push(file);}
  const manifest=files.find(file=>file.name==='pyproject.toml');if(!manifest || (expectedSha256&&digest(Buffer.from(manifest.body,'base64'))!==expectedSha256))throw new Error('App recipe differs from its declared revision');
  return client.json('/v1/recipes',{files,digest:digest(files)});
}
export async function modelProbes(client,recipe,modelsRoot,{features,pythonExecutable,profile}={}) {
  const system=await client.json('/v1/system');
  const python=system.comfygitDevelopment?.python || pythonExecutable || system.comfygitPython || system.tools.python3;
  const inventory=await client.json('/v1/recipe-models',{directory:recipe.directory,modelsRoot,pythonExecutable:python});
  const unresolved=(inventory.unresolvedModels || []).filter(model=>!profile || (profile==='fast'?model.workflow.includes('-fast-'):!model.workflow.includes('-fast-')));
  if(unresolved.length)throw new Error('App recipe has unpinned required models: '+[...new Set(unresolved.map(model=>model.filename))].join(', '));
  const selected=inventory.models.filter(model=>!profile || model.workflows.some(name=>profile==='fast'?name.includes('-fast-'):!name.includes('-fast-')));
  return {...inventory,probes:selected.map(model=>({kind:'file',path:model.path,name:model.filename,expectedSize:model.expectedSize,modelHash:model.hash,pythonExecutable:python,...(features?{features}:{})}))};
}

export async function comfySetup(client,{appId,recipe,settings,comfyPort,servePort,installation,extraCommands=[],models='all',environmentName,toolchain,bundledNodes={},supportedPlatforms=['linux'],torchBackend='auto'}) {
  if(torchBackend!=='auto' && !(await client.health()).capabilities?.includes('comfy-torch-backend-v1'))throw new Error('Update this worker before selecting a PyTorch backend.');
  const system=await client.json('/v1/system'+(settings.cgExecutable?'?cg='+encodeURIComponent(settings.cgExecutable):''));if(!supportedPlatforms.includes(system.platform)||!['linux','win32'].includes(system.platform))throw new Error('This app runtime does not support the selected executor platform.');
  if(system.comfygitDevelopment)toolchain=undefined;
  const targetJoin=(system.platform==='win32'?win32:posix).join;
  const workspace=settings.workspace || system.defaultWorkspace,modelsRoot=settings.modelsRoot || system.defaultModelsRoot;
  const cg=system.comfygitDevelopment?.cg || toolchain?.cg || settings.cgExecutable || system.tools.cg;if(!cg)throw new Error('Install ComfyGit or choose its executable in Runtime settings.');
  const environment=environmentName || appId+'-'+recipe.sha256.slice(0,10),env={COMFYGIT_HOME:workspace};
  const python=system.comfygitDevelopment?.python || toolchain?.python || settings.pythonExecutable || system.comfygitPython;if(!python)throw new Error("Choose the Python interpreter containing ComfyGit in Runtime settings.");
  const resources=models==='skip'&&toolchain?{models:[],probes:[],nodes:{}}:await modelProbes(client,recipe,modelsRoot,{pythonExecutable:settings.pythonExecutable||system.comfygitPython||system.tools.python3});
  for(const [id,path] of Object.entries(bundledNodes)){
    if(typeof path!=='string'||path.startsWith('/')||path.split('/').includes('..')||!recipe.files?.some(file=>file.name===path&&path.endsWith('.py')||file.name===path+'/__init__.py'))throw new Error('Bundled node '+id+' needs its actual staged Python entrypoint');
  }
  const unresolved=Object.entries(resources.nodes).filter(([id,node])=>node.source==='development' && !node.repository && !bundledNodes[id]);
  if(unresolved.length)throw new Error('This development recipe needs local node sources ('+unresolved.map(([id])=>id).join(', ')+'). Connect an existing app runtime or provide a distributable recipe before a fresh install.');
  const comfyUrl='http://127.0.0.1:'+comfyPort,serveUrl='http://127.0.0.1:'+servePort;
  const bootstrapArgs=toolchain?[system.scripts.comfygitBootstrap,toolchain.root,toolchain.manifest]:[];
  const bootstrapCommand=system.tools.python3 || system.tools.uv;
  if(toolchain&&!bootstrapCommand)throw new Error('Managed setup requires Python or the bundled uv executable.');
  if(toolchain&&!system.tools.python3)bootstrapArgs.unshift('run','--no-project','--python','3.11');
  return {...installation,configuration:{...installation.configuration,workspace,modelsRoot,environment,...((toolchain||system.comfygitDevelopment)?{cgExecutable:cg,pythonExecutable:python}: {})},probes:[...installation.probes,...(models==='all'?resources.probes:[])],setup:{
    description:'Create an isolated '+appId+' runtime with the pinned ComfyGit recipe, reuse matching model files, acquire missing models, and start its local services. Existing environments are preserved.',
    writes:[targetJoin(workspace,'environments',environment),modelsRoot,...(toolchain?[toolchain.root]:[])],
    downloads:[{name:'ComfyUI and pinned runtime packages (cached packages are reused)',bytes:null},...(toolchain?[{name:'Python setup tool',bytes:27127688},{name:'Python and ComfyGit packages (cached packages are reused)',bytes:null}]:[]),...(models==='all'?resources.models.filter(model=>!model.present).map(model=>({name:model.filename,bytes:model.expectedSize})):[])],
    commands:[...(toolchain?[{label:'Install managed Python and ComfyGit',command:bootstrapCommand,args:bootstrapArgs}]:[]),{label:'Verify workspace ownership',command:python,args:['-c',
      "from pathlib import Path\nimport sys\nfrom comfygit_core.core.workspace import Workspace\nfrom comfygit_core.models.exceptions import CDWorkspaceNotFoundError\np=Path(sys.argv[1]); m=Path(sys.argv[2])\ntry:\n w=Workspace.open(p)\n if w.get_models_directory().resolve()!=m.resolve(): raise RuntimeError('Existing workspace has a different model directory; choose a separate workspace')\nexcept CDWorkspaceNotFoundError:\n if p.exists() and any(p.iterdir()): raise RuntimeError('New workspace directory must be empty')",workspace,modelsRoot]},
      {label:'Materialize app runtime',command:python,args:[system.scripts.comfygitMaterialize,cg,recipe.directory,workspace,environment,modelsRoot,models,recipe.digest,JSON.stringify(bundledNodes),torchBackend],environment:env},...extraCommands],
    services:[{label:'Start ComfyUI',command:cg,args:['-e',environment,'run','--no-sync','--','--listen','127.0.0.1','--port',String(comfyPort),'--base-directory',targetJoin(workspace,'environments',environment,'ComfyUI'),'--disable-auto-launch','--highvram','--reserve-vram','0'],environment:env,healthUrl:comfyUrl+'/system_stats'},
      {label:'Start workflow service',command:cg,args:['-e',environment,'serve','--host','127.0.0.1','--port',String(servePort),'--comfy-url',comfyUrl,'--state','local'],environment:env,healthUrl:serveUrl+'/health'}],
  }};
}
