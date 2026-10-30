// Read-only verification against one real retained swap; never queues GPU work.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.OPENCAST_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.OPENCAST_TEST_BASE,out=process.env.OPENCAST_TEST_OUTPUT,id=process.env.OPENCAST_SWAP_ID;
if(!base||!out||!id)throw new Error('Set OPENCAST_TEST_BASE, OPENCAST_TEST_OUTPUT and OPENCAST_SWAP_ID.');
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCAST_CHROMIUM});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1050}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+`#/motion?view=history&tab=swaps&swap=${id}`);
 await page.getByRole('dialog').waitFor();
 const wire=await (await page.request.get(base+`api/v1/jobs/${id}`)).json();const job={...wire.details,status:wire.status};
 const manifest=await (await page.request.get(new URL(wire.outputs.manifest.access.url,base).href)).json();
 assert.equal(manifest.recipe,'h3-omni-v15-no-mask-v1');assert.equal(manifest.useMask,false);assert.equal(manifest.useAnchor,false);
 assert.match(manifest.graph.model.inputs.unet_name,/fasth3_omniref/);
 await page.getByText('Source & character reference',{exact:true}).click();
 const original=page.getByLabel('Original source video',{exact:true});
 await original.evaluate(async video=>{if(video.readyState<1)await new Promise(resolve=>video.addEventListener('loadedmetadata',resolve,{once:true}))});
 assert((await original.evaluate(video=>video.duration))>=4);
 await page.locator('.swap-inputs img').evaluate(image=>image.decode());
 let playback=false,download=false;
 if(job.status==='complete'){
  const result=page.getByLabel('Generated swap video',{exact:true});
  await result.evaluate(async video=>{if(video.readyState<1)await new Promise(resolve=>video.addEventListener('loadedmetadata',resolve,{once:true}));video.muted=true;await video.play();video.pause();video.currentTime=Math.min(2,video.duration/2);await new Promise(resolve=>video.addEventListener('seeked',resolve,{once:true}))});
  assert(Math.abs((await result.evaluate(video=>video.duration))-job.duration)<.1);playback=true;
  const luminance=await result.evaluate(async video=>{
   const frame=new Promise(resolve=>video.requestVideoFrameCallback(resolve));await video.play();await frame;video.pause();
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const context=canvas.getContext('2d');context.drawImage(video,0,0,64,64);
   const pixels=context.getImageData(0,0,64,64).data;let total=0;for(let i=0;i<pixels.length;i+=4)total+=pixels[i]+pixels[i+1]+pixels[i+2];return total/(64*64*3);
  });assert(luminance>10,'Generated video must render visible pixels, not just expose metadata');
  const response=await page.request.get(new URL(wire.outputs.video.access.downloadUrl,base).href);
  assert.equal(response.status(),200);assert.match(response.headers()['content-disposition'],/attachment/);assert.equal(response.headers()['content-type'],'video/mp4');assert((await response.body()).length>10000);download=true;
 }
 await page.screenshot({path:out+'/live-swap-desktop.png'});
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:out+'/live-swap-mobile.png'});assert.deepEqual(errors,[]);
 fs.writeFileSync(out+'/live-swap-checks.json',JSON.stringify({base,id,status:job.status,realSourcePlayback:true,fullReferenceLoaded:true,omniNoMaskGraph:true,generatedPlayback:playback,download,mobileWidth:390,errors},null,2));
 console.log('PASS: retained swap browser flow; status='+job.status+'; generated playback='+playback);
}finally{await browser.close()}
