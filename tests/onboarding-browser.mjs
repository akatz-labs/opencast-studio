import assert from 'node:assert/strict';
import fs from 'node:fs';
const {chromium}=await import(process.env.OPENCAST_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.OPENCAST_TEST_BASE,out=process.env.OPENCAST_TEST_OUTPUT;
if(!base||!out)throw new Error('Set OPENCAST_TEST_BASE and OPENCAST_TEST_OUTPUT.');
fs.mkdirSync(out,{recursive:true});
const catalog=JSON.parse(fs.readFileSync(new URL('../resources/models.json',import.meta.url)));
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCAST_CHROMIUM});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1050}}),actions=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 let state='checking',folder='/home/example/.local/share/shared/models';
 await page.route('**/api/v1/resources*',async route=>{
  if(route.request().method()==='POST'){
   const body=route.request().postDataJSON();actions.push(body);if(body.action==='model-folder')folder=body.path;
   await route.fulfill({status:202,json:{accepted:true}});return;
  }
  await route.fulfill({json:{onboarding:{state,message:state==='ready'?'Runtime and model checks passed.':'Set up the runtimes and models before generating.'},modelDirectory:{path:folder,currentPath:null,pending:false},connection:state==='checking'?'checking':state==='ready'?'connected':'offline',executorKind:'local',executorName:'This machine',setupAvailable:true,setupJob:null,models:catalog.models.map(m=>({...m,state:state==='ready'?'installed':'unknown',verified:state==='ready'})),jobs:[],runtimes:[],storage:null}});
 });
 await page.goto(base);await page.getByRole('button',{name:'Open settings',exact:true}).waitFor();
 assert.equal(await page.getByRole('dialog').count(),0,'No modal during an unresolved check');
 state='required';const modal=page.getByRole('dialog');await modal.waitFor({timeout:12000});
 assert.equal(await modal.getByRole('button',{name:'Resources',exact:true}).getAttribute('aria-current'),'page');
 assert.equal(actions.length,0,'Startup must never download automatically');
 await modal.getByLabel('Model folder',{exact:true}).fill('/media/Existing models');
 assert.ok(await modal.getByRole('button',{name:'Install missing',exact:true}).isDisabled());
 await modal.getByRole('button',{name:'Use folder',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.install-missing')?.disabled);
 assert.deepEqual(actions,[{action:'model-folder',path:'/media/Existing models'}]);
 await modal.getByRole('button',{name:'Install missing',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.install-missing')?.disabled);
 assert.deepEqual(actions.at(-1),{action:'setup'});
 await page.screenshot({path:out+'/onboarding-desktop.png'});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await modal.locator('.settings-content').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 await page.screenshot({path:out+'/onboarding-mobile.png'});
 await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
 await page.waitForTimeout(4300);assert.equal(await modal.count(),0,'Dismissed setup must not reopen in this page session');
 await page.reload();await modal.waitFor({timeout:12000});
 assert.equal(await modal.getByLabel('Model folder',{exact:true}).inputValue(),folder);
 state='ready';await page.reload();await page.getByRole('button',{name:'Open settings',exact:true}).waitFor();
 await page.waitForTimeout(4500);assert.equal(await modal.count(),0,'Ready installs must open Studio normally on reload');
 await page.getByRole('button',{name:'Open settings',exact:true}).click();await modal.waitFor();
 assert.deepEqual(errors,[]);
 fs.writeFileSync(out+'/onboarding-browser.json',JSON.stringify({passed:true,actions,checks:['no early popup','automatic Resources','explicit folder save','explicit setup','dismissal','reload pending','reload ready','mobile fit'],errors},null,2));
}finally{await browser.close()}
