const {chromium}=await import(process.env.OPENCAST_PLAYWRIGHT_MODULE||'playwright');
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const [base,output,device='desktop']=process.argv.slice(2);
if(!base||!output)throw new Error('Usage: node tests/cache-browser.mjs BASE_URL OUTPUT_JSON');
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'cast-browser-cache-'));
const gallery=JSON.parse(await fs.readFile(new URL('../src/gallery.json',import.meta.url),'utf8'));
const thumbnails=JSON.parse(await fs.readFile(new URL('../docs/trait-thumbnails.json',import.meta.url),'utf8'));
const urls=[...thumbnails.records.flatMap(r=>r.files.map(f=>base+f.path.replace(/^public\//,''))),...gallery.flatMap(c=>[160,480,960].map(w=>`${base}media/${c.image}-${w}.webp`))];
const errors=[],results=[];
const launch=()=>chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.OPENCAST_CHROMIUM,...(device==='mobile'?{viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true}:{viewport:{width:1500,height:1050}})});
let context=await launch();
async function visit(label){
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.locator('[data-card]').first().waitFor();
 await page.locator('img:visible').evaluateAll(images=>Promise.all(images.map(i=>i.decode())));
 await page.waitForTimeout(300);
 const metrics=await page.evaluate(()=>{const rows=performance.getEntriesByType('resource').filter(r=>r.name.includes('/media/'));return {images:rows.length,networkBytes:rows.reduce((n,r)=>n+r.transferSize,0),cacheHits:rows.filter(r=>r.transferSize===0).length,encodedBytes:rows.reduce((n,r)=>n+r.encodedBodySize,0)}});
 results.push({label,...metrics});return page;
}
let page=await visit('cold');await page.close();
page=await visit('new-tab');assert.equal(results.at(-1).networkBytes,0);
await page.evaluate(async urls=>{
 for(const url of urls){const r=await fetch(url);if(!r.ok||r.headers.get('cache-control')!=='private, max-age=31536000, immutable')throw new Error(`Uncacheable image ${url}`);await r.arrayBuffer()}
},urls);
await context.close();context=await launch();
page=await visit('browser-reopened');assert.equal(results.at(-1).networkBytes,0);
await page.evaluate(()=>performance.clearResourceTimings());
const decodedImages=await page.evaluate(async urls=>{performance.setResourceTimingBufferSize(1000);let count=0;for(const url of urls){const i=new Image();i.src=url;await i.decode();count++}return count},urls);
const catalogCache=await page.evaluate(()=>{const rows=performance.getEntriesByType('resource').filter(r=>r.name.includes('/media/'));return {requests:rows.length,networkBytes:rows.reduce((n,r)=>n+r.transferSize,0),cacheHits:rows.filter(r=>r.transferSize===0).length}});
// Images already decoded on this page can be reused without another timing entry.
assert.equal(decodedImages,urls.length);assert.equal(catalogCache.networkBytes,0);
const api=await page.request.get(base+'api/jobs');assert.equal(api.headers()['cache-control'],'no-store');
await page.reload();await page.locator('[data-card]').first().waitFor();await page.locator('img:visible').evaluateAll(images=>Promise.all(images.map(i=>i.decode())));
const reload=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>r.name.includes('/media/')).reduce((n,r)=>n+r.transferSize,0));assert.equal(reload,0);
assert.deepEqual(errors,[]);await context.close();await fs.rm(profile,{recursive:true});
const report={base,device,results,allImageVariants:{decodedImages,...catalogCache},reloadImageNetworkBytes:reload,errors};
await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
