import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import sharp from 'sharp';
import gallery from '../src/gallery.json' with {type:'json'};
import provenance from '../docs/generated-gallery.json' with {type:'json'};
import {validateTraits} from '../shared/prompt.mjs';
test('gallery is a unique, curated set of replayable actual generations',()=>{
 assert.ok(gallery.length>=20&&gallery.length<=30);
 assert.equal(new Set(gallery.map(c=>c.id)).size,gallery.length);
 assert.equal(new Set(gallery.map(c=>c.generation.jobId)).size,gallery.length);
 assert.ok(gallery.some(c=>c.family==='Animal'));assert.ok(gallery.some(c=>c.traits['Character type']==='Extreme'));assert.ok(gallery.some(c=>c.traits['Character type']==='Bold'));
 // Saved prompts describe historical renders and must not be regenerated with today's template.
 for(const c of gallery){const g=c.generation;validateTraits(c.traits);assert.equal(typeof g.prompt,'string');assert.ok(g.prompt.trim().length>0);assert.equal(g.steps,8);assert.ok(Number.isInteger(g.seed));assert.match(g.storageVersion,/^asv_[a-f0-9]{32}$/);const p=provenance.sources.find(p=>p.characterId===c.id);assert.equal(p.jobId,g.jobId);assert.equal(p.storageVersion,g.storageVersion);assert.equal(p.models.at(-1).training_steps,4000)}
});
test('gallery thumbnails preserve original image aspect and are available at all display sizes',async()=>{
 for(const c of gallery)for(const size of [160,480,960]){const image=await fs.readFile(new URL(`../public/media/${c.image}-${size}.webp`,import.meta.url));const m=await sharp(image).metadata();assert.equal(m.width,size);assert.equal(m.height,size*1.5);assert.equal(c.aspect,2/3)}
});

test('every Explore card has both views and opens a landscape reference sheet',async()=>{
 const sheets=JSON.parse(await fs.readFile(new URL('../docs/gallery-sheets.json',import.meta.url),'utf8'));
 assert.equal(sheets.characters.length,gallery.length);
 assert.equal(gallery.filter(c=>c.referenceSheet.mode==='existing-portrait').length,16);
 assert.equal(gallery.filter(c=>c.referenceSheet.mode==='regenerate-portrait').length,10);
 for(const [i,c]of gallery.entries()){
  assert.equal(c.gridView,i%2?'body':'portrait');
  assert.equal(c.image,c.gridView==='body'?c.referenceSheet.bodyImage:c.referenceSheet.portraitImage);
  for(const width of [960,1600]){const m=await sharp(new URL(`../public/media/${c.referenceSheet.image}-${width}.webp`,import.meta.url).pathname).metadata();assert.equal(m.width,width);assert.equal(m.height,width*.75)}
  assert.ok(sheets.characters.some(s=>s.characterId===c.id&&s.storageVersion===c.referenceSheet.storageVersion));
 }
});
