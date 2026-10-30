import test from 'node:test';
import assert from 'node:assert/strict';
import {compileCharacterSheet,presets} from '../shared/prompt.mjs';
import graph from '../workflows/krea-api.json' with {type:'json'};
import contract from '../workflows/contract.json' with {type:'json'};

test('the two views share traits and direction while describing the appropriate framing',()=>{
 const p=compileCharacterSheet(presets[0].traits,{direction:'A brass pin on the jacket.'});
 assert.match(p.prompt,/Tightly cropped/);assert.match(p.fullBodyPrompt,/Full-body/);
 for(const text of [p.prompt,p.fullBodyPrompt]){assert.match(text,/brass pin/);assert.match(text,/chin lobes/)}
 assert.deepEqual(p.compiled.traits,p.bodyCompiled.traits);
});
test('manual prompts survive byte-for-byte; derived body follows the edited character',()=>{
 const prompt='A purple-haired adult in a silver jacket.  ',body='Head to shoes, same silver jacket.  ';
 const p=compileCharacterSheet({}, {promptOverride:prompt,fullBodyPromptOverride:body});
 assert.equal(p.prompt,prompt);assert.equal(p.fullBodyPrompt,body);
 const derived=compileCharacterSheet({}, {promptOverride:prompt}).fullBodyPrompt;
 assert.match(derived,/^Full-body front-facing/);assert.match(derived,/purple-haired/);
 assert.throws(()=>compileCharacterSheet({}, {fullBodyPromptOverride:123}));
});
test('primary output depends on both passes and the preserved source face',()=>{
 assert.deepEqual(graph[contract.contracts.character.outputs[0].node_id].inputs.images,['20',0]);
 assert.deepEqual(graph['20'].inputs,{portrait:['8',0],full_body:['19',0]});
 assert.deepEqual(graph['19'].inputs.generated,['18',0]);assert.deepEqual(graph['11'].inputs.source,['8',0]);
 assert.equal(new Set(contract.contracts.character.outputs.map(o=>o.name)).size,4);
 for(const output of contract.contracts.character.outputs)assert.equal(graph[output.node_id].class_type,'SaveImage');
});

test('reference size follows height and preserves deliberate oversized-head proportions',async()=>{
 const {referencePlacement}=await import('../shared/placement.mjs');
 const tall=referencePlacement({Height:'Tall'}),average=referencePlacement({Height:'Average'}),short=referencePlacement({Height:'Short'}),oversized=referencePlacement({Height:'Short',Proportions:'Oversized head'});
 assert.ok(tall.sourceWidth<average.sourceWidth);assert.ok(average.sourceWidth<short.sourceWidth);assert.ok(short.sourceWidth<oversized.sourceWidth);
 assert.equal(referencePlacement({Build:'Tall'}).height,'Tall');assert.equal(referencePlacement({Build:'Tall',Height:'Short'}).height,'Short');
 assert.deepEqual(graph['11'].inputs.source_width,['27',0]);
});

test('managed character recipe preserves prompts, seeds, placement and all output roles',async t=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const {prepareCharacter,characterOutputs}=await import('../server/character-recipe.mjs');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'opencast-character-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const prompt='Exact portrait prompt.  ',body='Exact full-body prompt.  ';
 const plan=await prepareCharacter({jobId:'test-character',directory,request:{parameters:{traits:{Height:'Tall'},seed:2147483647,referenceTop:32,promptOverride:prompt,fullBodyPromptOverride:body}}});
 const graph=JSON.parse(fs.readFileSync(plan.files['graph.json']));
 assert.equal(graph['4'].inputs.text,prompt);assert.equal(graph['12'].inputs.prompt,body);
 assert.equal(graph['7'].inputs.seed,2147483647);assert.equal(graph['17'].inputs.seed,1000002);
 assert.equal(graph['27'].inputs.height,'Tall');assert.equal(graph['11'].inputs.top,32);
 assert.deepEqual(Object.keys(characterOutputs),['image','portrait','full-body','raw-body','manifest','workflow']);
 assert.deepEqual(plan.inputs,{version:1,kind:'character'});
});
