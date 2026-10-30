import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import gallery from '../src/gallery.json' with {type:'json'};
const {chromium}=await import(process.env.OPENCAST_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.OPENCAST_TEST_OUTPUT;
if(!out)throw new Error('Set OPENCAST_TEST_OUTPUT to allocated evidence storage.');
fs.mkdirSync(out,{recursive:true});
const base=process.env.OPENCAST_TEST_BASE||'http://127.0.0.1:8391/cast-studio/';
const b=await chromium.launch({headless:true,executablePath:process.env.OPENCAST_CHROMIUM});
const p=await b.newPage({viewport:{width:1500,height:1050},acceptDownloads:true});
const errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.goto(base);await p.getByRole('button',{name:'View Ramon Volt',exact:true}).waitFor();
await p.locator('[data-card] img').evaluateAll(images=>Promise.all(images.map(i=>i.decode())));
await p.screenshot({path:out+'/explore-desktop.png'});
const checks=[];
for(const c of gallery){
 await p.getByLabel('Search characters',{exact:true}).fill(c.name);
 const card=p.getByRole('button',{name:'View '+c.name,exact:true});await card.waitFor();
 assert((await card.locator('img').getAttribute('src')).includes(c.image));await card.click();
 const image=p.getByAltText('Full character reference of '+c.name,{exact:true});await image.evaluate(i=>i.decode());
 const size=await image.evaluate(i=>[i.naturalWidth,i.naturalHeight]);assert(Math.abs(size[0]-size[1]*4/3)<=2,'Responsive image density must preserve sheet aspect ratio');
 const response=await p.request.get(base+'api/gallery/'+c.id+'/sheet?download=1');assert.equal(response.status(),200);
 const png=await response.body();assert.equal(png.readUInt32BE(16),2048);assert.equal(png.readUInt32BE(20),1536);
 assert.equal(response.headers()['cache-control'],'private, no-cache');
 const manifest=await(await p.request.get(base+'api/gallery/'+c.id+'/manifest')).json();
 assert.equal(crypto.createHash('sha256').update(png).digest('hex'),manifest.outputs.sheet.sha256);
 assert.equal(manifest.characterId,c.id);assert.equal(manifest.graph['11'].inputs.top,c.referenceSheet.placement.top);
 if(['cast-ramon','cast-ines','cast-bird'].includes(c.id))await p.screenshot({path:out+'/'+c.id+'-sheet.png'});
 checks.push({characterId:c.id,gridView:c.gridView,sheetDimensions:size,downloadSha256:manifest.outputs.sheet.sha256});
 await p.getByRole('button',{name:'Close dialog',exact:true}).click();
}
for(const id of ['cast-ramon','cast-ines','cast-bird']){
 const c=gallery.find(c=>c.id===id),s=c.referenceSheet;
 await p.getByLabel('Search characters',{exact:true}).fill(c.name);await p.getByRole('button',{name:'View '+c.name,exact:true}).click();
 await p.getByRole('dialog').getByRole('button',{name:'Recreate',exact:true}).click();await p.getByRole('button',{name:/Edit prompt/}).click();
 assert.equal(await p.getByLabel('Exact prompt',{exact:true}).inputValue(),s.prompt);assert.equal(await p.getByLabel('Full-body prompt',{exact:true}).inputValue(),s.fullBodyPrompt);
 assert.equal(await p.getByLabel('Generation seed').inputValue(),String(s.seed));assert.equal(await p.getByLabel('Full-body seed').inputValue(),String(s.bodySeed));
 await p.getByRole('button',{name:'Use this prompt',exact:true}).click();
}
let generatedJob=null;
if(process.env.OPENCAST_TEST_GENERATE==='1'){
 const response=p.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/jobs'));
 await p.getByRole('button',{name:'Generate',exact:true}).click();const res=await response;assert.equal(res.status(),202);const job=(await res.json()).jobs[0];generatedJob=job.id;
 assert.equal(job.placement.top,96);assert.equal(job.placement.sourceWidth,192);
 const s=gallery.find(c=>c.id==='cast-bird').referenceSheet;assert.equal(job.bodySeed,s.bodySeed);
 const manifest=await(await p.request.get(base+'api/jobs/'+job.id+'/manifest')).json();assert.equal(manifest.graph['11'].inputs.top,96);assert.deepEqual(manifest.graph['27'].inputs,{height:'Tall',proportions:'Long-limbed'});
 await p.getByRole('heading',{name:'Your character is ready',exact:true}).waitFor({timeout:180000});
 await p.getByAltText('Generated character',{exact:true}).evaluate(i=>i.decode());
 await p.screenshot({path:out+'/api-replay.png'});
 fs.writeFileSync(out+'/api-manifest.json',JSON.stringify(manifest,null,2));
 await p.getByRole('button',{name:'Close dialog',exact:true}).click();
}
await p.setViewportSize({width:390,height:844});await p.getByRole('navigation',{name:'Mobile navigation'}).getByRole('button',{name:'Explore',exact:true}).click();
await p.getByLabel('Search characters',{exact:true}).fill('Ines Pocket');await p.getByRole('button',{name:'View Ines Pocket',exact:true}).click();
await p.getByAltText('Full character reference of Ines Pocket',{exact:true}).evaluate(i=>i.decode());
assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
const bounds=await p.getByRole('dialog').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390);
await p.screenshot({path:out+'/sheet-mobile.png'});
const download=p.waitForEvent('download');await p.getByRole('link',{name:'Reference sheet PNG',exact:true}).click();assert.equal((await download).suggestedFilename(),'cast-ines-sheet.png');
await p.getByRole('dialog').getByRole('button',{name:'Recreate',exact:true}).click();await p.getByRole('button',{name:/Edit prompt/}).click();assert.equal(await p.getByLabel('Generation seed').inputValue(),String(gallery.find(c=>c.id==='cast-ines').referenceSheet.seed));
assert.deepEqual(errors,[]);fs.writeFileSync(out+'/validation.json',JSON.stringify({base,checks,generatedJob,recreate:['cast-ramon','cast-ines','cast-bird'],mobile:'sheet, download, recreate, no overflow',errors},null,2));await b.close();console.log('PASS: 26 sheet viewers/downloads, 3 exact recreates, mobile'+(generatedJob?', real API generation '+generatedJob:''));
