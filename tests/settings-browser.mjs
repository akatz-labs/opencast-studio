import assert from 'node:assert/strict';
import fs from 'node:fs';
const {chromium}=await import(process.env.OPENCAST_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.OPENCAST_TEST_BASE,out=process.env.OPENCAST_TEST_OUTPUT;
if(!base||!out)throw new Error('Set OPENCAST_TEST_BASE and OPENCAST_TEST_OUTPUT.');
fs.mkdirSync(out,{recursive:true});
const catalog=JSON.parse(fs.readFileSync(new URL('../resources/models.json',import.meta.url)));
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCAST_CHROMIUM});
const page=await browser.newPage({viewport:{width:1500,height:1050}}),errors=[],actions=[];
page.on('pageerror',e=>errors.push(e.message));
let fixture={executorKind:'local',setupAvailable:true,setupJob:null,connection:'connected',executorName:'Test workstation',models:catalog.models.map((m,i)=>({...m,state:i===0?'installed':m.acquisition==='manual'?'unknown':'missing',verified:i===0})),jobs:[],runtimes:[{id:'comfyui',name:'ComfyUI',installed:false,detail:'Workflow installation pending'}],storage:{freeBytes:100*1024**3,path:'/models'}};
await page.route('**/api/v1/resources*',async route=>{
 if(route.request().method()==='POST'){actions.push(route.request().postDataJSON());await route.fulfill({status:202,json:{accepted:true}})}else await route.fulfill({json:fixture});
});
try{
 await page.goto(base);await page.getByRole('button',{name:'Open settings',exact:true}).click();
 const modal=page.getByRole('dialog');await modal.getByText('Test workstation',{exact:true}).waitFor();
 assert.equal(await modal.locator('[data-resource-id]').count(),catalog.models.length);
 await modal.getByRole('button',{name:'Install Qwen3-VL · image text encoder',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.settings-modal button[aria-label="Install Qwen3-VL · image text encoder"]')?.disabled);
 assert.deepEqual(actions[0],{action:'download',resourceIds:['krea-text']});
 assert.equal(await modal.getByRole('button',{name:'Install OpenCast character LoRA'}).count(),1);
 assert.equal(await modal.getByText('Depth Anything 3 Base',{exact:true}).count(),0);
 const refresh=await modal.getByRole('button',{name:'Refresh',exact:true}).boundingBox(),install=await modal.getByRole('button',{name:'Install missing',exact:true}).boundingBox();
 assert.ok(install.x>refresh.x&&Math.abs(install.y-refresh.y)<3,'Install missing must sit to the right of Refresh');
 await modal.getByRole('button',{name:'Install missing',exact:true}).click();assert.deepEqual(actions.at(-1),{action:'setup'});
 await page.screenshot({path:out+'/settings-desktop.png'});
 await modal.getByRole('button',{name:'General',exact:true}).click();
 await modal.getByRole('radio',{name:'Amber',exact:true}).check();
 await modal.getByRole('switch',{name:'Reduce interface motion'}).click();
 await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
 await page.reload();assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()),'#FFD34E');
 await page.getByRole('button',{name:'Open settings',exact:true}).click();await modal.getByRole('button',{name:'General',exact:true}).click();
 assert.equal(await modal.getByRole('switch',{name:'Reduce interface motion'}).getAttribute('aria-checked'),'true');
 await modal.getByRole('radio',{name:'Neon green',exact:true}).check();await modal.getByRole('switch',{name:'Reduce interface motion'}).click();
 await modal.getByRole('button',{name:'About',exact:true}).click();await modal.getByText('OpenCast',{exact:false}).first().waitFor();
 assert.equal(await modal.getByRole('link',{name:'GitHub · akatz-labs/opencast-studio',exact:true}).getAttribute('href'),'https://github.com/akatz-labs/opencast-studio');
 await modal.getByRole('button',{name:'Resources',exact:true}).click();
 fixture={...fixture,connection:'offline',message:'The configured executor is unavailable.',models:fixture.models.map(m=>({...m,state:'unknown'}))};
 await modal.getByRole('button',{name:'Refresh',exact:true}).click();await modal.getByText('Offline',{exact:true}).waitFor();
 assert.ok(await modal.getByRole('button',{name:'Install missing',exact:false}).isEnabled(),'First-run local setup must be available without a worker');
 fixture={...fixture,connection:'connected',message:undefined,jobs:[{id:'finished',kind:'download',status:'succeeded',progress:1}],models:fixture.models.map(m=>({...m,state:m.acquisition==='manual'?'unknown':'missing'}))};
 await modal.getByRole('button',{name:'Refresh',exact:true}).click();await modal.getByText('Connected',{exact:true}).waitFor();assert.ok(await modal.getByRole('button',{name:'Install missing',exact:false}).isEnabled());
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});
  assert.ok(await modal.evaluate(el=>el.getBoundingClientRect().left>=0&&el.getBoundingClientRect().right<=window.innerWidth));
  assert.ok(await modal.locator('.settings-content').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  await page.screenshot({path:out+`/settings-mobile-${width}.png`});
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(out+'/settings-browser.json',JSON.stringify({passed:true,actions,widths:[1500,390,320],errors},null,2));
}finally{await browser.close()}
