import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import gallery from '../src/gallery.json' with {type:'json'};
import {compileCharacterSheet} from '../shared/prompt.mjs';
const {chromium}=await import(process.env.OPENCAST_PLAYWRIGHT_MODULE||'playwright');
const out=process.env.OPENCAST_TEST_OUTPUT,video=process.env.OPENCAST_TEST_VIDEO;
if(!out||!video)throw new Error('Set OPENCAST_TEST_OUTPUT and OPENCAST_TEST_VIDEO to retained evidence and a 4–30 second clip.');
const port=Number(process.env.OPENCAST_TEST_PORT||8395),base=`http://127.0.0.1:${port}/cast-studio/`;
const data=fs.mkdtempSync(path.join(os.tmpdir(),'cast-history-test-'));
const {compiled,fullBodyPrompt}=compileCharacterSheet({'Character type':'Bold'});
const fixtures=Array.from({length:7},(_,i)=>({id:`fixture-${i+1}`,batchId:'fixture',batchIndex:1,status:'complete',created:`2026-10-29T01:0${i}:00.000Z`,traits:compiled.traits,prompt:compiled.prompt,fullBodyPrompt,seed:i,steps:8,cfg:1,width:2048,height:1536,templateVersion:compiled.version,framing:'character-sheet',direction:'',manualPrompt:false,compiled,passes:2,outputs:{portrait:{}}}));
const ledger=JSON.stringify({jobs:fixtures,batches:[]});fs.writeFileSync(data+'/jobs.json',ledger);
for(const [index,j] of fixtures.entries()){
 fs.mkdirSync(data+'/jobs/'+j.id,{recursive:true});
 const c=gallery[index%gallery.length];
 await sharp(`public/media/${c.referenceSheet.image}-960.webp`).png().toFile(data+'/jobs/'+j.id+'/image.png');
 await sharp(`public/media/${c.referenceSheet.portraitImage}-960.webp`).png().toFile(data+'/jobs/'+j.id+'/portrait.png');
 fs.writeFileSync(data+'/jobs/'+j.id+'/manifest.json','{}');
}
let server,browser;
async function start(){server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,PORT:String(port),OPENCAST_BASE_PATH:'/cast-studio',OPENCAST_DATA:data,OPENCAST_DIST:path.resolve(process.env.OPENCAST_TEST_DIST||'dist-h3-preview'),OPENCAST_COMFY:'http://127.0.0.1:1',OPENCAST_WORKERS_DISABLED:'1'},stdio:['ignore','pipe','inherit']});await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error(`Test server exited ${code}`)))});}
async function stop(){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await exited;}
try{
 await start();
 const rename=(id,name)=>fetch(base+`api/jobs/${id}/name`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
 for(const name of ['', '  ', 'a'.repeat(81), 'bad\nname', null])assert.equal((await rename('fixture-1',name)).status,400);
 assert.equal((await rename('missing','Ari')).status,404);
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCAST_CHROMIUM});
 const page=await browser.newPage({viewport:{width:1500,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const extra=[];let releaseSubmission;let received;
 const swaps=[];
 const wire=j=>({id:j.id,kind:j.referenceName?'character-swap':'character',name:j.name,status:j.status,createdAt:j.created,requestKey:j.requestKey,details:j,outputs:Object.fromEntries(Object.entries({...j.artifacts,...Object.fromEntries(['image','video','poster','manifest','source','reference'].filter(k=>j[k]).map(k=>[k,j[k]]))}).map(([role,url])=>[role,{assetId:crypto.randomUUID(),access:{url,downloadUrl:url,expiresAt:null}}]))});
 await page.route('**/api/v1/assets/**',route=>{const endpoint=route.request().url();const id=crypto.randomUUID();return route.fulfill({json:endpoint.endsWith('/uploads')?{asset:{id,status:'pending'},upload:null}:{id,status:'ready'}})});
 await page.route('**/api/v1/jobs*',async route=>{
  if(route.request().method()==='POST'){
   const input=route.request().postDataJSON();
   if(input.kind==='character-swap'){
    const job={id:input.idempotencyKey,name:`Swap ${swaps.length+1}`,status:'queued',created:new Date().toISOString(),prompt:input.parameters.prompt||'the main person in the scene',seed:42,referenceName:'Test character',sourceName:'Test source',quality:input.parameters.quality,keepAudio:input.parameters.keepAudio,source:'',reference:'',manifest:'',video:null,poster:null};swaps.unshift(job);await route.fulfill({status:202,json:{jobs:[wire(job)]}});return;
   }
   received={...input.parameters,idempotencyKey:input.idempotencyKey};await new Promise(resolve=>releaseSubmission=resolve);
   extra.push(...Array.from({length:received.batchSize},(_,i)=>({...fixtures[0],id:`submitted-${i+1}`,requestKey:received.idempotencyKey,batchIndex:i+1,number:8+i,name:`Character ${8+i}`,created:'2026-10-29T03:00:00.000Z',status:'queued',image:null,artifacts:{},manifest:base+`api/jobs/submitted-${i+1}/manifest`})));
   await route.fulfill({status:202,json:{jobs:extra.map(wire)}});return;
  }
  const response=await route.fetch(),json=await response.json();await route.fulfill({json:{jobs:[...json.jobs,...extra.map(wire),...(route.request().url().includes('kind=character')?[]:swaps.map(wire))]}});
 });
 await page.route('**/api/v1/jobs/submitted-*/cancel',async route=>{const j=extra.find(j=>route.request().url().includes(j.id));j.status='cancelled';await route.fulfill({json:wire(j)})});
 await page.route(/\/api\/jobs\/[^/]+\/(image|portrait)$/,async route=>{const match=route.request().url().match(/(?:fixture|submitted)-(\d+)\/(image|portrait)$/);const c=gallery[(Number(match?.[1]||1)-1)%gallery.length];const key=match?.[2]==='portrait'?c.referenceSheet.portraitImage:c.referenceSheet.image;await route.fulfill({contentType:'image/webp',body:fs.readFileSync(`public/media/${key}-960.webp`)})});
 await page.goto(base+'#/character?view=history');await page.locator('.history-card').nth(6).waitFor();
 const ids=await page.locator('.history-card').evaluateAll(xs=>xs.map(x=>x.dataset.jobId));assert.deepEqual(ids,['fixture-7','fixture-6','fixture-5','fixture-4','fixture-3','fixture-2','fixture-1']);
 const boxes=await page.locator('.history-card').evaluateAll(xs=>xs.map(x=>({x:x.getBoundingClientRect().x,y:x.getBoundingClientRect().y})));
 assert.equal(boxes[0].y,boxes[1].y);assert(boxes[1].x>boxes[0].x);assert(boxes[4].y>boxes[0].y);assert.equal(boxes[4].x,boxes[0].x);
 await page.screenshot({path:out+'/history-desktop.png'});
 await page.getByRole('button',{name:'View Character 7',exact:true}).click();await page.locator('.character-name>span').first().dblclick();
 await page.getByRole('textbox',{name:'Character name',exact:true}).fill('Ari');await page.getByRole('textbox',{name:'Character name',exact:true}).press('Enter');await page.locator('.character-name>span').filter({hasText:/^Ari$/}).waitFor();
 await page.getByRole('button',{name:'Rename character',exact:true}).click();await page.getByRole('textbox',{name:'Character name',exact:true}).fill('Discard me');await page.getByRole('textbox',{name:'Character name',exact:true}).press('Escape');assert(await page.getByRole('dialog').isVisible());await page.locator('.character-name>span').filter({hasText:/^Ari$/}).waitFor();
 await page.getByText('Prompt & generation settings',{exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Result prompt',exact:true}).inputValue(),compiled.prompt);assert.equal(await page.getByRole('textbox',{name:'Result full-body prompt',exact:true}).inputValue(),fullBodyPrompt);
 await page.screenshot({path:out+'/history-detail.png'});await page.getByRole('button',{name:'Close dialog',exact:true}).click();await page.reload();await page.getByRole('button',{name:'View Ari',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Motion',exact:true}).click();assert.equal(await page.getByRole('tab',{name:'Transfer motion',exact:true}).count(),0);assert.equal(await page.getByRole('combobox',{name:'Subject to replace',exact:true}).count(),0);
 const drag=await page.evaluateHandle(()=>new DataTransfer());await page.getByRole('button',{name:'View Ari',exact:true}).dispatchEvent('dragstart',{dataTransfer:drag});await page.getByRole('region',{name:'Swap character',exact:true}).dispatchEvent('drop',{dataTransfer:drag});assert.equal(await page.locator('.selected-reference').count(),1);assert.equal(await page.locator('.selected-reference img').getAttribute('alt'),'Ari');
 await page.getByRole('navigation',{name:'Workspace'}).getByRole('button',{name:'Explore',exact:true}).click();const first=page.locator('.virtual-gallery [data-character] .card-image').first();await first.waitFor();const galleryId=await first.locator('..').getAttribute('data-character');const drag2=await page.evaluateHandle(()=>new DataTransfer());await first.dispatchEvent('dragstart',{dataTransfer:drag2});await page.getByRole('region',{name:'Swap character',exact:true}).dispatchEvent('drop',{dataTransfer:drag2});assert.equal(await page.locator('.selected-reference').count(),1);assert.equal(await page.locator('.selected-reference img').getAttribute('alt'),gallery.find(c=>c.id===galleryId).name);
 await page.getByLabel('Upload source video',{exact:true}).setInputFiles(video);await page.locator('.source-preview video').waitFor();
 await page.getByRole('button',{name:'Generate swap',exact:true}).click();await page.getByRole('button',{name:'View Swap 1',exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);await page.getByRole('button',{name:'View Swap 1',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByText('Prompt & settings',{exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Swap prompt',exact:true}).inputValue(),'the main person in the scene');await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 assert.equal(await page.locator('.swap-history [data-status=queued]').count(),1);
 await page.getByRole('textbox',{name:'Person to replace',exact:true}).fill('Swap the woman on the left in the red jacket.');await page.getByRole('button',{name:'Generate swap',exact:true}).click();await page.getByRole('button',{name:'View Swap 2',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByText('Prompt & settings',{exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Swap prompt',exact:true}).inputValue(),'Swap the woman on the left in the red jacket.');await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 const completedSwap=swaps[0];completedSwap.status='complete';completedSwap.video=base+'api/test-swap-video';completedSwap.poster=base+`media/${gallery[0].image}-480.webp`;
 await page.route('**/api/test-swap-video',route=>route.fulfill({contentType:'video/mp4',body:fs.readFileSync(video)}));
 await page.locator('.swap-history [data-status=complete]').waitFor();await page.getByRole('button',{name:'View Swap 2',exact:true}).click();
 const player=page.getByLabel('Generated swap video',{exact:true});await player.waitFor();await player.evaluate(async video=>{if(video.readyState<1)await new Promise(resolve=>video.addEventListener('loadedmetadata',resolve,{once:true}));video.muted=true;await video.play();video.pause()});
 assert((await player.evaluate(video=>video.duration))>=4);assert(await page.getByRole('link',{name:'Download video',exact:true}).isVisible());await page.screenshot({path:out+'/swap-result-player.png'});await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 const multi=await page.evaluateHandle(()=>{const d=new DataTransfer();d.items.add(new File(['x'],'one.png',{type:'image/png'}));d.items.add(new File(['x'],'two.png',{type:'image/png'}));return d});await page.getByRole('region',{name:'Swap character',exact:true}).dispatchEvent('drop',{dataTransfer:multi});await page.getByText('Choose one character image at a time.',{exact:true}).waitFor();assert.equal(await page.locator('.selected-reference').count(),1);
 await page.screenshot({path:out+'/swap-desktop.png'});
 await page.getByRole('tab',{name:'Character',exact:true}).click();await page.getByRole('button',{name:'Increase batch size',exact:true}).click();await page.getByRole('button',{name:'Generate',exact:true}).click();
 await page.locator('.history-card[data-status=submitting]').nth(1).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
 const pending=page.locator('.history-card').first();assert((await pending.getAttribute('data-job-id')).startsWith('pending-'));const pendingBox=await pending.locator('.card-image').boundingBox();
 await pending.locator('.card-image').click();await page.locator('.result-skeleton').waitFor();assert((await page.locator('.result-skeleton').boundingBox()).height>300);await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.screenshot({path:out+'/history-submitting.png'});releaseSubmission();await page.locator('.history-card[data-status=queued]').nth(1).waitFor();assert.equal(await page.locator('.history-card').first().getAttribute('data-job-id'),'submitted-2');
 const complete=extra[1];complete.status='complete';complete.image=base+'api/jobs/submitted-2/image';complete.artifacts={portrait:base+'api/jobs/submitted-2/portrait'};await page.locator('.history-card[data-job-id=submitted-2][data-status=complete]').waitFor();
 const finishedBox=await page.locator('.history-card[data-job-id=submitted-2] .card-image').boundingBox();assert.equal(finishedBox.height,pendingBox.height);assert.equal(finishedBox.width,pendingBox.width);
 await page.getByRole('button',{name:'Cancel Character 8',exact:true}).click();await page.locator('.history-card[data-job-id=submitted-1][data-status=cancelled]').waitFor();
 for(const width of [390,320]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const cards=await page.locator('.history-card').evaluateAll(xs=>xs.slice(0,3).map(x=>({x:x.getBoundingClientRect().x,y:x.getBoundingClientRect().y})));assert.equal(cards[0].y,cards[1].y);assert(cards[2].y>cards[0].y);await page.screenshot({path:out+`/history-${width}.png`});}
 await page.getByRole('navigation',{name:'Mobile navigation'}).getByRole('button',{name:'Create',exact:true}).click();await page.getByRole('tab',{name:'Motion',exact:true}).click();await page.getByRole('button',{name:'Generate swap',exact:true}).waitFor();await page.screenshot({path:out+'/swap-mobile.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);assert.equal(fs.readFileSync(data+'/jobs.json','utf8'),ledger);await stop();await start();assert.equal((await(await fetch(base+'api/jobs/fixture-7')).json()).name,'Ari');
 fs.writeFileSync(out+'/swap-history-checks.json',JSON.stringify({rowOrder:ids,renamePersistedAfterRestart:true,immutableLedgerPreserved:true,oneReference:true,exploreAndHistoryDrag:true,defaultAndCustomPrompt:true,pendingToCompletedSameSize:true,noAutomaticModal:true,cancel:true,mobileWidths:[390,320],errors},null,2));console.log('PASS: rename persistence, row-major grid, drag/drop, single reference, prompts, submission/queue/completion/cancel states and mobile');
}finally{if(browser)await browser.close();if(server&&server.exitCode===null)await stop();fs.rmSync(data,{recursive:true,force:true})}
