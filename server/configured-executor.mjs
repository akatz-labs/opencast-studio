import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {dataDirectory} from './deployment.mjs';
import {executorConfiguration} from './executor-config.mjs';
import {ExecutorClient} from './executor-client.mjs';
import {sharedExecutor} from './shared-executor.mjs';
import {prepareMotion,motionOutputs} from './motion-recipe.mjs';
import {prepareCharacter,characterOutputs} from './character-recipe.mjs';
import {galleryAsset} from './gallery-assets.mjs';

// The browser always uses the same API. Installation discovery belongs here,
// beside the executor boundary, and refreshes after first-run setup completes.
export async function configuredExecutor({directory,assets,storage,characterNumberFloor=0}){
 const configuration={characterNumberFloor,appId:'opencast',instanceId:'opencast-local',target:{kind:'local',port:8841}},recipes={};
 const explicit=process.env.OPENCAST_EXECUTOR_CONFIG;
 if(explicit){
  Object.assign(configuration,executorConfiguration.parse(JSON.parse(fs.readFileSync(explicit))));
  for(const [kind,recipe]of Object.entries(configuration.recipes)){
   const module=await import(pathToFileURL(path.resolve(path.dirname(explicit),recipe.module)).href);
   recipes[kind]={...recipe,prepare:module.prepare};
  }
 }
 const executor=sharedExecutor({directory,assets,configuration,recipes,storage});
 let last=0,pending;
 async function refresh(){
  if(explicit||Date.now()-last<10000)return;
  if(pending)return pending;
  pending=(async()=>{
   const location=process.env.OPENCAST_RESOURCE_CONFIG||path.join(dataDirectory,'resources.json');
   for(const kind of ['character','character-swap','motion-transfer'])delete recipes[kind];
   if(!fs.existsSync(location))return;
   const resources=JSON.parse(fs.readFileSync(location)),client=new ExecutorClient(resources.target);
   const health=await client.health();
   if(!resources.executorId||health.executorId!==resources.executorId)return;
   const rows=await client.readiness('opencast');
   const chosen=rows.find(row=>row.features.includes('character-swap')&&row.features.includes('motion-transfer'));
   const character=rows.find(row=>row.features.includes('character'));
   if(character)recipes.character={installationId:character.installation.id,feature:'character',revision:character.installation.revision,outputs:characterOutputs,prepare:prepareCharacter};
   Object.assign(configuration,{target:resources.target,executorId:health.executorId});
   if(chosen)for(const kind of ['character-swap','motion-transfer'])recipes[kind]={installationId:chosen.installation.id,feature:kind,revision:chosen.installation.revision,outputs:motionOutputs,prepare:prepareMotion};
  })().catch(error=>{console.error('Workflow discovery:',error.message)}).finally(()=>{last=Date.now();pending=null});
  return pending;
 }
 return {...executor,async importAsset(ref,owner){return ref.kind==='gallery'?galleryAsset(ref,{directory,assets,owner}):executor.importAsset(ref,owner)},async capabilities(){await refresh();return executor.capabilities()},async submit(...args){await refresh();return executor.submit(...args)},async tick(){await refresh();return executor.tick()}};
}
