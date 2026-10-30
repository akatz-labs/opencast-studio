const {chromium}=await import(process.env.OPENCAST_PLAYWRIGHT_MODULE||'playwright');
import fs from 'node:fs';
import assert from 'node:assert/strict';

const catalog=JSON.parse(fs.readFileSync(new URL('../shared/traits.json',import.meta.url)));
const [base,out,prefix='thumbnails']=process.argv.slice(2);
if(!base||!out)throw new Error('Usage: node tests/thumbnail-browser.mjs BASE_URL EVIDENCE_DIRECTORY [PREFIX]');
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCAST_CHROMIUM});
const errors=[],failures=[],results=[];
for(const mobile of [false,true]){
 const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1500,height:1050},isMobile:mobile,hasTouch:mobile});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.status()>=400)failures.push([r.status(),r.url()])});
 await page.goto(base);
 await page.locator('[data-card]').first().waitFor();
 if(mobile)await page.getByRole('navigation',{name:'Mobile navigation'}).getByRole('button',{name:'Create',exact:true}).click();
 let count=0;
 for(const category of catalog){
  const trigger=page.locator('.fold-trigger').filter({hasText:new RegExp('^'+category.name)});
  if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
  const group=page.getByRole('group',{name:category.name,exact:true});
  assert.equal(await group.locator('img').count(),category.options.length);
  for(const option of category.options){
   const button=group.getByRole('button',{name:option.label,exact:true});
   await button.scrollIntoViewIfNeeded();
   await button.locator('img').evaluate(i=>i.decode());
   assert(await button.locator('img').evaluate(i=>i.naturalWidth>0&&i.currentSrc.endsWith('.webp')));
   await button.click();
   assert.equal(await button.getAttribute('aria-pressed'),'true');
   await page.waitForFunction(({category,label})=>JSON.parse(localStorage.getItem('cast-draft-v1')).traits[category]===label,{category:category.name,label:option.label});
   const style=await button.evaluate(e=>({cursor:getComputedStyle(e).cursor,select:getComputedStyle(e).userSelect,overflow:e.scrollWidth>e.clientWidth+1}));
   assert.equal(style.cursor,'pointer');assert.equal(style.select,'none');assert.equal(style.overflow,false);
   count++;
  }
  if(['Height','Mouth','Eye color','Neck'].includes(category.name)){
   await group.scrollIntoViewIfNeeded();
   await page.screenshot({path:`${out}/${prefix}-${mobile?'phone':'desktop'}-${category.name.toLowerCase().replaceAll(' ','-')}.png`});
  }
  await trigger.click();
 }
 await page.reload();
 if(mobile)await page.getByRole('navigation',{name:'Mobile navigation'}).getByRole('button',{name:'Create',exact:true}).click();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('cast-draft-v1')).traits);
 for(const category of catalog)assert.equal(saved[category.name],category.options.at(-1).label);
 const first=page.locator('.fold-trigger').first();
 if(await first.getAttribute('aria-expanded')!=='true')await first.click();
 const option=page.getByRole('group',{name:catalog[0].name,exact:true}).getByRole('button').first();
 await option.focus();await page.keyboard.press('Enter');assert.equal(await option.getAttribute('aria-pressed'),'true');
 await page.screenshot({path:`${out}/${prefix}-${mobile?'phone':'desktop'}.png`});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 if(!mobile){await page.evaluate(()=>document.documentElement.style.zoom='2');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 results.push({viewport:mobile?'390x844':'1500x1050',optionsSelected:count,persistedCategories:catalog.length});
 await page.close();
}
assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
fs.writeFileSync(`${out}/${prefix}-browser-validation.json`,JSON.stringify({base,results,errors,failures,checks:['all images decode','all options select and persist','keyboard selection','pointer and user-select','labels fit','no horizontal overflow','200 percent zoom']},null,2));
await browser.close();console.log(JSON.stringify(results));
