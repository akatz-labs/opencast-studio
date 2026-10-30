import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {file,immutableAsset} from '../server/files.mjs';
import gallery from '../src/gallery.json' with {type:'json'};
import catalog from '../shared/traits.json' with {type:'json'};

test('only versioned static assets get immutable caching',()=>{
 for(const c of gallery)assert(immutableAsset(`/media/${c.image}-480.webp`));
 for(const c of catalog)for(const o of c.options)assert(immutableAsset(`/media/options/${o.thumbnail}-160.webp`));
 assert(immutableAsset('/assets/index-BiyNalqW.js'));
 for(const route of ['/index.html','/hub-library.json','/api/jobs','/media/nyra-480.webp','/media/cast-4000-ramon-480.webp','/cast-studio-source.zip','/media/missing.webp'])assert.equal(immutableAsset(route),false,route);
});

test('gallery URLs contain a digest of their actual encoded images',async()=>{
 for(const c of gallery){
  const bytes=await Promise.all([160,480,960].map(w=>fs.readFile(new URL(`../public/media/${c.image}-${w}.webp`,import.meta.url))));
  const digest=crypto.createHash('sha256').update(Buffer.concat(bytes)).digest('hex').slice(0,10);
  assert(c.image.endsWith('-'+digest));
 }
});

test('HTTP cache validates unchanged files and notices updates without stale bodies',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cast-cache-test-'));await fs.writeFile(root+'/image.webp','first image');
 const server=http.createServer((req,res)=>file(req,res,root+(req.url==='/missing'?'/missing':'/image.webp'),null,{immutable:req.url==='/versioned'}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true})});
 const base=`http://127.0.0.1:${server.address().port}`;
 const first=await fetch(base+'/versioned');assert.equal(first.headers.get('cache-control'),'private, max-age=31536000, immutable');assert.equal(await first.text(),'first image');
 const etag=first.headers.get('etag');
 const same=await fetch(base+'/versioned',{headers:{'If-None-Match':etag}});assert.equal(same.status,304);assert.equal(await same.text(),'');
 const head=await fetch(base+'/versioned',{method:'HEAD'});assert.equal(head.headers.get('content-length'),'11');assert.equal(await head.text(),'');
 const mutable=await fetch(base+'/mutable');assert.equal(mutable.headers.get('cache-control'),'private, no-cache');await mutable.text();
 const dated=await fetch(base+'/mutable',{headers:{'If-Modified-Since':mutable.headers.get('last-modified')}});assert.equal(dated.status,304);
 await fs.writeFile(root+'/image.webp','replacement image');
 const changed=await fetch(base+'/mutable',{headers:{'If-None-Match':etag}});assert.equal(changed.status,200);assert.equal(await changed.text(),'replacement image');assert.notEqual(changed.headers.get('etag'),etag);
 const missing=await fetch(base+'/missing');assert.equal(missing.status,404);assert.equal(missing.headers.get('cache-control'),'no-store');
});
