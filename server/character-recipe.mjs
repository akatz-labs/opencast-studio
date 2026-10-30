import fs from 'node:fs';
import {compileCharacterSheet} from '../shared/prompt.mjs';
import {referencePlacement} from '../shared/placement.mjs';

const graphTemplate=JSON.parse(fs.readFileSync(new URL('../workflows/krea-api.json',import.meta.url)));
const contract=JSON.parse(fs.readFileSync(new URL('../workflows/contract.json',import.meta.url)));
export const characterOutputs={...Object.fromEntries(contract.contracts.character.outputs.map(o=>[o.name,{name:o.name+'.png',contentType:'image/png'}])),manifest:{name:'manifest.json',contentType:'application/json'},workflow:{name:'workflow.json',contentType:'application/json'}};

export async function prepareCharacter({request,jobId,directory}){
 const p=request.parameters,{compiled,bodyCompiled,prompt,fullBodyPrompt}=compileCharacterSheet(p.traits,p);
 const placement={...referencePlacement(compiled.traits),top:p.referenceTop??48};
 const bodySeed=p.bodySeed??((p.seed+1000003)%2147483648);
 const values={prompt,full_body_prompt:fullBodyPrompt,seed:p.seed,body_seed:bodySeed,steps:8,cfg:1,width:1024,height:1536,
  reference_top:placement.top,reference_height:placement.height,reference_proportions:placement.proportions,
  output_prefix:'OpenCast/'+jobId+'/sheet',portrait_prefix:'OpenCast/'+jobId+'/portrait',full_body_prefix:'OpenCast/'+jobId+'/full-body',raw_body_prefix:'OpenCast/'+jobId+'/raw-body'};
 const graph=structuredClone(graphTemplate);
 for(const input of contract.contracts.character.inputs)graph[input.api_node_id].inputs[input.api_field_key]=values[input.name];
 const details={...p,compiled,bodyCompiled,prompt,fullBodyPrompt,bodySeed,placement,model:'Krea 2 · OpenCast LoRA',passes:2,cfg:1,width:2048,height:1536,framing:'character-sheet',templateVersion:compiled.version};
 const inputs={version:1,kind:'character'};
 fs.writeFileSync(directory+'/character.json',JSON.stringify(inputs));
 fs.writeFileSync(directory+'/graph.json',JSON.stringify(graph,null,2));
 fs.writeFileSync(directory+'/manifest.json',JSON.stringify({schemaVersion:4,jobId,details,contract,graph},null,2));
 return {inputs,files:Object.fromEntries(['character.json','graph.json','manifest.json'].map(name=>[name,directory+'/'+name])),details};
}
