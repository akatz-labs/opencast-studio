import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {stageAppRecipe,comfySetup} from '../vendor/shared-runtime/src/executor-resources.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
export const runtimeProfiles=[
 {id:'krea',name:'Krea character sheets',torchBackend:'cu130',nodes:{'rebels-krea2-outpaint':'bundled/nodes/cast-character-sheet'}},
 {id:'pika',name:'Pika H3 Flex',torchBackend:'cu128',nodes:{}},
];
export async function installationPlan(client,profile,settings={}){
 if(!(await client.health()).capabilities?.includes('cpu-only-install-v1'))throw new Error('This executor needs the shared CPU-only installer update before runtime setup. Existing GPU sessions were preserved.');
 const system=await client.json('/v1/system');
 if(system.platform!=='linux'||system.arch!=='x64')throw new Error('Automatic GPU setup currently supports Linux x64. Use a configured remote Linux executor on other platforms.');
 for(const tool of ['git','g++','ffmpeg','ffprobe'])if(!system.tools[tool])throw new Error(`Install the operating-system ${tool} prerequisite, then select Install missing again.`);
 if(!system.tools.python3&&!system.tools.uv)throw new Error('Install Python 3 or uv first, then select Install missing again.');
 const extraFiles=[];
 for(const name of fs.readdirSync(root+'resources/toolchain').sort())extraFiles.push({name:'bundled/toolchain/'+name,body:fs.readFileSync(root+'resources/toolchain/'+name).toString('base64')});
 for(const name of ['worker.py',...(profile.id==='pika'?['pipeline.flat.api.json']:[])])extraFiles.push({name:'bundled/motion/'+name,body:fs.readFileSync(root+'resources/motion/'+name).toString('base64')});
 if(profile.id==='krea')for(const name of fs.readdirSync(root+'custom_nodes/cast-character-sheet').sort()){
  if(!/\.(py|json|toml)$/.test(name)&&!['LICENSE','NOTICE'].includes(name))continue;
  extraFiles.push({name:'bundled/nodes/cast-character-sheet/'+(name.includes('.')?name:name+'.txt'),body:fs.readFileSync(root+'custom_nodes/cast-character-sheet/'+name).toString('base64')});
 }
 if(profile.id==='pika')extraFiles.push({name:'bundled/fixes/kitchen_int8_offsets.py',body:fs.readFileSync(root+'resources/runtime-fixes/kitchen_int8_offsets.py').toString('base64')});
 const recipe=await stageAppRecipe(client,root+'resources/runtimes/'+profile.id,undefined,{extraFiles});
 const toolHash=crypto.createHash('sha256').update(fs.readFileSync(root+'resources/toolchain/manifest.json')).digest('hex').slice(0,16);
 const toolRoot=path.posix.join(system.dataRoot,'tools','opencast-comfygit-'+toolHash);
 const toolchain={root:toolRoot,python:toolRoot+'/venv/bin/python',cg:toolRoot+'/venv/bin/cg',manifest:recipe.directory+'/bundled/toolchain/manifest.json'};
 const environment='opencast-'+profile.id+'-'+recipe.digest.slice(0,12),workspace=settings.workspace||system.defaultWorkspace;
 const environmentRoot=path.posix.join(workspace,'environments',environment);
 // Each installation binds its immutable adapter and runtime recipe.
 const adapterBody=fs.readFileSync(root+'server/motion-adapter.mjs');
 const adapterHash=crypto.createHash('sha256').update(adapterBody).digest('hex');
 const adapter=await (await client.request('/v1/adapters/'+adapterHash,{method:'PUT',body:adapterBody})).json();
 const definition={id:environment,appId:'opencast',name:profile.name,revision:adapterHash,adapter:adapter.path,features:profile.id==='pika'?['runtime-installed','character-swap','motion-transfer']:['runtime-installed','character'],
  runtime:{comfyUrls:[]},capabilities:['cooperative-cancel-v1'],
  configuration:{recipeDigest:recipe.digest,profile:profile.id,...{motionWorker:recipe.directory+'/bundled/motion/worker.py',motionGraph:recipe.directory+'/bundled/motion/pipeline.flat.api.json',jobLauncher:settings.jobLauncher?JSON.parse(settings.jobLauncher):[]}},
  probes:[{kind:'file',name:'Pinned ComfyUI environment',path:environmentRoot+'/.cec/pyproject.toml'},
   {kind:'command',name:'ComfyUI dependencies',command:environmentRoot+'/.venv/bin/python',args:['-c','import torch, transformers, comfy_kitchen; print("runtime-dependencies-ready")'],contains:'runtime-dependencies-ready'}]};
 // A private development override must not silently replace the bundled toolchain.
 const pinnedClient={health:()=>client.health(),json:(url,...args)=>url.startsWith('/v1/system')?Promise.resolve({...system,comfygitDevelopment:null}):client.json(url,...args)};
 const installation=await comfySetup(pinnedClient,{appId:'opencast',recipe,settings:{...settings,workspace},comfyPort:8188,servePort:8790,environmentName:environment,installation:definition,models:'skip',toolchain,bundledNodes:profile.nodes,torchBackend:profile.torchBackend});
 installation.id+='-'+crypto.createHash('sha256').update(installation.configuration.modelsRoot).digest('hex').slice(0,10);
 installation.id+='-'+adapterHash.slice(0,8);
 if(settings.jobLauncher)installation.id+='-'+crypto.createHash('sha256').update(settings.jobLauncher).digest('hex').slice(0,8);
 if(profile.id==='pika'){
  const fix=recipe.directory+'/bundled/fixes/kitchen_int8_offsets.py',python=environmentRoot+'/.venv/bin/python';
  installation.setup.commands.push({label:'Apply pinned INT8 kernel offset fix',command:python,args:[fix]});
  installation.probes.push({kind:'command',name:'INT8 kernel supports long clips',command:python,args:[fix,'--check'],contains:'opencast-int8-offsets-ready',features:['character-swap','motion-transfer']});
 }
 installation.setup.requiresGpu=false;
 installation.setup.services=[]; // GPU sessions are started by the generation executor.
 for(const model of JSON.parse(fs.readFileSync(root+'resources/models.json')).models.filter(m=>m.group===(profile.id==='pika'?'motion':'character')))installation.probes.push({kind:'file',name:model.name,path:path.posix.join(installation.configuration.modelsRoot,model.relativePath),expectedSize:model.sizeBytes,features:profile.id==='pika'?['character-swap','motion-transfer']:['character']});
 installation.setup.description='Install the pinned '+profile.name+' environment and dependencies. Reuse the shared model store; preserve existing environments. Generation jobs start their own runtime when generated.';
 return {installation,recipe,plan:await client.json('/v1/plans',installation)};
}
