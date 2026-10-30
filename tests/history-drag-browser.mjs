import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.OPENCAST_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.OPENCAST_TEST_BASE,out=process.env.OPENCAST_TEST_OUTPUT;
if(!base||!out)throw new Error('Set OPENCAST_TEST_BASE and OPENCAST_TEST_OUTPUT. This check only reads existing history.');
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCAST_CHROMIUM});
const page=await browser.newPage({viewport:{width:1500,height:1050}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 window.dragChecks={previews:[],drops:[]};
 const setImage=DataTransfer.prototype.setDragImage;
 DataTransfer.prototype.setDragImage=function(image,x,y){const rect=image.getBoundingClientRect();window.dragChecks.previews.push({tag:image.tagName,width:rect.width,height:rect.height,x,y,images:image.querySelectorAll('img').length,overlay:getComputedStyle(image.querySelector('.card-reveal')).opacity,text:image.textContent});setImage.call(this,image,x,y)};
 document.addEventListener('drop',e=>window.dragChecks.drops.push({types:[...e.dataTransfer.types],job:e.dataTransfer.getData('application/x-cast-job')}));
});
const checks=[];
try{
 await page.goto(base+'#/motion?view=history');
 for(const [width,framing,grabY]of [[1500,'full-body',.5],[1100,'portrait',.9]]){
  await page.setViewportSize({width,height:1050});
  const card=page.locator(`.history-card[data-status=complete][data-framing=${framing}]`).first(),button=card.locator('.card-image');
  await button.scrollIntoViewIfNeeded();await card.locator('img').evaluate(i=>i.decode());
  const id=await card.getAttribute('data-job-id'),name=await card.locator('h3').textContent();
  const from=await button.boundingBox(),to=await page.getByRole('region',{name:'Swap character',exact:true}).boundingBox();
  await page.mouse.move(from.x+from.width*.5,from.y+from.height*grabY);await page.mouse.down();
  await page.mouse.move(from.x+from.width*.5-15,from.y+from.height*grabY,{steps:5});
  await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:25});
  await page.mouse.move(to.x+to.width/2+1,to.y+to.height/2+1);await page.mouse.up();
  await page.waitForFunction(n=>document.querySelector('.selected-reference strong')?.textContent===n,name);
  assert.equal(await page.locator('.selected-reference').count(),1);assert.equal(await page.getByRole('dialog').count(),0);
  const result=await page.evaluate(()=>window.dragChecks),preview=result.previews.at(-1),drop=result.drops.at(-1);
  assert.equal(preview.tag,'DIV');assert(Math.abs(preview.width-from.width)<1);assert(Math.abs(preview.height-from.height)<1);assert.equal(preview.images,1);assert.equal(preview.overlay,'1');assert.equal(preview.text.trim(),'View character');assert.equal(drop.job,id);
  assert(Math.abs(preview.x-from.width*.5)<2);assert(Math.abs(preview.y-from.height*grabY)<2);
  assert.equal(await page.locator('.history-drag-preview').count(),0);
  checks.push({width,framing,id,name,preview:{width:preview.width,height:preview.height},drop});
 }
 await page.screenshot({path:out+'/history-drop-result.png'});assert.deepEqual(errors,[]);
 fs.writeFileSync(out+'/native-drag-checks.json',JSON.stringify({base,method:'real pointer movement, no synthetic drag events',checks,errors},null,2));console.log('PASS: real mouse drags from full-body and portrait History cards, card-sized previews, correct single-reference drops');
}finally{await browser.close()}
