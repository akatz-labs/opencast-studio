import test from 'node:test';
import assert from 'node:assert/strict';
import {compilePrompt} from '../shared/prompt.mjs';
import graph from '../workflows/krea-api.json' with {type:'json'};
import contract from '../workflows/contract.json' with {type:'json'};

test('extreme geometry is specific and independent of body mass',()=>{
 const r=compilePrompt({'Character type':'Extreme',Build:'Strongman'});
 assert.match(r.prompt,/jaw corners project far beyond/);assert.match(r.prompt,/Two enormous rounded chin lobes/);assert.match(r.prompt,/lean upper cheeks/);assert.match(r.prompt,/Massive shoulders/);
 assert.doesNotMatch(r.prompt,/enormous face|massive cheeks|natural head-to-body/);
});
test('explicit face choices override intensity defaults',()=>{
 const r=compilePrompt({'Character type':'Extreme',Jaw:'Tapered',Chin:'Natural',Cheeks:'Round',Mouth:'Wide'});
 assert.match(r.prompt,/jaw tapering/);assert.match(r.prompt,/naturally proportioned chin/);assert.doesNotMatch(r.prompt,/chin lobes|wide shelf|lean upper cheeks|tiny mouth/);
});
test('Natural and animal settings do not inherit human caricature defaults',()=>{
 for(const kind of ['Natural','Fox']){const r=compilePrompt({'Character type':kind});assert.doesNotMatch(r.prompt,/chin lobes|central cleft|square jaw/);if(kind==='Fox')assert.doesNotMatch(r.prompt,/Lifelike human skin/)}
 assert.equal(compilePrompt({'Character type':'Surreal'}).traits['Character type'],'Extreme');assert.equal(compilePrompt({'Character type':'Expressive'}).traits['Character type'],'Bold');
});
test('the contract addresses the Krea graph and the published OpenCast adapter',()=>{
 for(const input of contract.contracts.character.inputs)assert.ok(input.api_field_key in graph[input.api_node_id].inputs);
 assert.deepEqual(graph['7'].inputs.model,['10',0]);assert.equal(graph['10'].inputs.lora_name,'krea2_opencast_v1.safetensors');assert.equal(graph['10'].inputs.strength_model,1);
 assert.equal(graph['7'].inputs.steps,8);assert.equal(graph['7'].inputs.cfg,1);assert.equal(graph['7'].inputs.sampler_name,'euler');assert.equal(graph['7'].inputs.scheduler,'simple');
});
