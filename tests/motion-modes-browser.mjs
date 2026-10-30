// UI-only verification: never submit a render or alter saved characters.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const {chromium}=await import(process.env.OPENCAST_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.OPENCAST_TEST_BASE,out=process.env.OPENCAST_TEST_OUTPUT,video=process.env.OPENCAST_TEST_VIDEO;
if(!base||!out||!video)throw new Error('Set OPENCAST_TEST_BASE, OPENCAST_TEST_OUTPUT and OPENCAST_TEST_VIDEO.');
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCAST_CHROMIUM});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1050}}),errors=[],writes=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',route=>{
  if(route.request().method()==='POST'){writes.push(route.request().url());return route.abort()}
  return route.continue();
 });
 await page.goto(base+'#/motion');
 const transfer=page.getByRole('tab',{name:'Motion transfer',exact:true}),swap=page.getByRole('tab',{name:'Character swap',exact:true});
 await swap.waitFor();assert.equal(await swap.getAttribute('aria-selected'),'true');
 await page.getByLabel('Person to replace',{exact:true}).fill('The person on the left');
 await page.getByLabel('Upload source video').setInputFiles(video);
 await page.locator('.source-preview video').waitFor();
 await page.locator('.character-card .use-look').first().click();await page.locator('.selected-reference').waitFor();
 assert(await page.getByRole('button',{name:'Generate swap',exact:true}).isEnabled());
 await transfer.click();assert.equal(await transfer.getAttribute('aria-selected'),'true');
 assert.equal(await page.getByLabel('Person to replace',{exact:true}).count(),0);
 await page.getByText('Character to animate',{exact:true}).waitFor();
 await page.getByRole('switch',{name:'Enable direction prompt'}).click();
 await page.getByLabel('Motion direction',{exact:true}).fill('Perform in a sunlit garden.');
 const background=await sharp({create:{width:320,height:180,channels:3,background:'#43664b'}}).png().toBuffer();
 await page.getByLabel('Upload background image').setInputFiles({name:'garden.png',mimeType:'image/png',buffer:background});
 await page.getByAltText('Background: garden.png').evaluate(image=>image.decode());
 assert(await page.getByRole('button',{name:'Generate motion',exact:true}).isDisabled());
 await swap.click();assert.equal(await page.getByRole('region',{name:'Motion background'}).count(),0);
 assert.equal(await page.getByLabel('Person to replace',{exact:true}).inputValue(),'The person on the left');
 assert(await page.getByRole('button',{name:'Generate swap',exact:true}).isEnabled());
 await transfer.click();assert.equal(await page.getByLabel('Motion direction',{exact:true}).inputValue(),'Perform in a sunlit garden.');
 await page.getByAltText('Background: garden.png').waitFor();
 await page.getByLabel('Change background image').setInputFiles({name:'garden-two.png',mimeType:'image/png',buffer:background});
 await page.getByAltText('Background: garden-two.png').waitFor();
 await page.screenshot({path:out+'/motion-transfer-desktop.png'});
 await page.getByRole('button',{name:'Remove background',exact:true}).click();
 await page.getByText('Use the video’s background if left empty',{exact:true}).waitFor();
 const drop=await page.evaluateHandle(()=>{const data=new DataTransfer();data.items.add(new File(['bad'],'bad.txt',{type:'text/plain'}));return data});
 await page.locator('.background-upload').dispatchEvent('drop',{dataTransfer:drop});
 await page.getByText('Choose a PNG, JPEG or WebP background under 10 MB.',{exact:true}).waitFor();
 await page.reload();await transfer.waitFor();assert.equal(await transfer.getAttribute('aria-selected'),'true');
 assert.equal(await page.getByLabel('Motion direction',{exact:true}).inputValue(),'Perform in a sunlit garden.');
 await page.getByRole('tab',{name:'Character',exact:true}).click();await page.getByLabel('Character art direction').waitFor();
 await page.getByRole('tab',{name:'Motion',exact:true}).click();
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});
  await page.getByRole('navigation',{name:'Mobile navigation'}).getByRole('button',{name:'Create',exact:true}).click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await transfer.scrollIntoViewIfNeeded();await page.screenshot({path:out+`/motion-transfer-${width}.png`});
  await swap.click();await page.getByLabel('Person to replace',{exact:true}).waitFor();
  await transfer.click();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 fs.writeFileSync(out+'/motion-modes-checks.json',JSON.stringify({base,modeSwitch:true,separatePrompts:true,backgroundUploadChangeRemove:true,invalidBackgroundRejected:true,draftPersistence:true,sharedVideoAndCharacter:true,transferCannotSubmitToSwapWorker:true,mobileWidths:[390,320],writes,errors},null,2));
 console.log('PASS: motion modes, separate prompts, background controls, persistence, no render submissions, desktop/mobile');
}finally{await browser.close()}
