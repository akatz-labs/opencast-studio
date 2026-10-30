import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import catalog from '../shared/traits.json' with {type:'json'};
import thumbnails from '../docs/trait-thumbnails.json' with {type:'json'};

test('every selectable trait has a unique reviewed thumbnail and retained provenance',()=>{
 assert.equal(thumbnails.complete,true);
 const options=catalog.flatMap(c=>c.options.map(o=>({category:c.name,...o})));
 assert.equal(thumbnails.records.length,options.length);
 assert.equal(new Set(options.map(o=>o.thumbnail)).size,options.length);
 for(const option of options){
  assert.ok(option.thumbnail,`${option.category}/${option.label}`);
  const record=thumbnails.records.find(r=>r.category===option.category&&r.option===option.label);
  assert.ok(record?.review);
  assert.ok(record.prompt.length>20);
  assert.match(record.sourceStorageVersion,/^asv_[a-f0-9]{32}$/);
  assert.match(record.sourceSha256,/^[a-f0-9]{64}$/);
  assert.equal(record.files.length,2);
  assert.ok(record.files.every(f=>f.path.includes(option.thumbnail)));
 }
});

test('thumbnail files are small WebPs with stable dimensions at both display sizes',async()=>{
 let smallBytes=0;
 for(const record of thumbnails.records)for(const file of record.files){
  const bytes=await fs.readFile(new URL('../'+file.path,import.meta.url));
  const metadata=await sharp(bytes).metadata();
  assert.equal(metadata.format,'webp');
  assert.equal(metadata.width,file.width);
  assert.equal(metadata.height,file.height);
  assert.equal(bytes.length,file.bytes);
  assert.ok(bytes.length<60000);
  if(file.width===160)smallBytes+=bytes.length;
 }
 assert.ok(smallBytes<1_000_000,'All 160px options should fit within 1 MB combined.');
});
