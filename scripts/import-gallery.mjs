/** Import reviewed, completed Cast Studio jobs as the editable gallery. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {compilePrompt} from '../shared/prompt.mjs';
const root=process.argv[2];
if(!root)throw new Error('Usage: node scripts/import-gallery.mjs ALLOCATED_REVIEW_DIRECTORY');
const plan=JSON.parse(await fs.readFile(path.join(root,'plan.json'),'utf8'));
const review=JSON.parse(await fs.readFile(path.join(root,'selection.json'),'utf8'));
if(!Array.isArray(review.selected)||!review.selected.length||new Set(review.selected).size!==review.selected.length)throw new Error('Selection must contain unique reviewed character IDs.');
const characters=[],sources=[];
await fs.mkdir('public/media',{recursive:true});
for(const id of review.selected){
 const row=plan.find(r=>r.id===id);if(!row)throw new Error(`No planned character: ${id}`);
 const receipt=JSON.parse(await fs.readFile(path.join(root,'receipts',id+'.json'),'utf8'));
 const j=receipt.job;if(j.status!=='complete'||!j.storageVersion)throw new Error(`Unretained job: ${id}`);
 const compiled=compilePrompt(j.traits,{direction:j.direction,framing:j.framing});
 if(compiled.prompt!==j.prompt||receipt.manifest.graph['4'].inputs.text!==j.prompt)throw new Error(`Prompt mismatch: ${id}`);
 const input=path.join(root,'originals',id+'.png');const bytes=await fs.readFile(input);
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==j.output.sha256)throw new Error(`Original hash mismatch: ${id}`);
 const previews=[];
 for(const width of [160,480,960])previews.push({width,bytes:await sharp(bytes).resize({width}).webp({quality:85}).toBuffer()});
 const revision=crypto.createHash('sha256').update(Buffer.concat(previews.map(p=>p.bytes))).digest('hex').slice(0,10);
 const image=`cast-4000-${id}-${revision}`;
 for(const preview of previews)await fs.writeFile(`public/media/${image}-${preview.width}.webp`,preview.bytes);
 characters.push({id:'cast-'+id,name:row.name,tag:row.tag,family:['Natural','Bold','Extreme'].includes(j.traits['Character type'])?'Human':'Animal',image,aspect:j.width/j.height,traits:j.traits,generation:{jobId:j.id,prompt:j.prompt,direction:j.direction,framing:j.framing,seed:j.seed,steps:j.steps,model:j.model,storageVersion:j.storageVersion}});
 sources.push({characterId:'cast-'+id,jobId:j.id,storageVersion:j.storageVersion,originalSha256:j.output.sha256,graphSha256:receipt.manifest.graphSha256,compilerSha256:receipt.manifest.compilerSha256,models:receipt.manifest.models,review:review.notes[id]});
}
await fs.writeFile('src/gallery.json',JSON.stringify(characters,null,2)+'\n');
await fs.writeFile('docs/generated-gallery.json',JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),recipe:'cast-krea-turbo-step4000-v1',selection:review,sources},null,2)+'\n');
// Replace existing illustrative trait thumbnails with matching generated examples.
const traits=JSON.parse(await fs.readFile('shared/traits.json','utf8'));
for(const category of traits)for(const option of category.options){if(option.image){const match=characters.find(c=>c.traits[category.name]===option.label);if(match)option.image=match.image}}
await fs.writeFile('shared/traits.json',JSON.stringify(traits,null,2)+'\n');
console.log(`Imported ${characters.length} reviewed characters with exact replay settings.`);
