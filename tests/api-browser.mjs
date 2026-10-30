// Runs the actual frontend client against signed-storage HTTP fixtures. No GPU or
// provider requests are made; every API and signed-storage request is intercepted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const {chromium}=await import(process.env.OPENCAST_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.OPENCAST_TEST_BASE,out=process.env.OPENCAST_TEST_OUTPUT;
if(!base||!out)throw new Error('Set OPENCAST_TEST_BASE to a Vite dev server and OPENCAST_TEST_OUTPUT.');
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCAST_CHROMIUM});
try{
 const context=await browser.newContext();await context.addCookies([{name:'private-cookie',value:'must-not-forward',domain:'signed-storage.test',path:'/',secure:true}]);
 const page=await context.newPage(),uploads=[],submissions=[],errors=[],assets=new Map();let accessCount=0;
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://signed-storage.test/**',async route=>{
  const request=route.request();assert.equal(request.headers().cookie,undefined);assert.equal(request.headers().authorization,undefined);
  if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'PUT,POST','Access-Control-Allow-Headers':'content-type,x-upload-signature'}});return}
  assert(request.url().includes('signature=keep-this'));assert(request.postDataBuffer().length>0);
  uploads.push({url:request.url(),method:request.method(),contentType:request.headers()['content-type'],bytes:request.postDataBuffer().length});
  await route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*'},body:''});
 });
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),url=new URL(req.url()),endpoint=url.pathname.split('/api/v1/')[1];
  let result;
  if(endpoint==='capabilities')result={operations:{character:{available:true},'character-swap':{available:true},'motion-transfer':{available:false}}};
  else if(endpoint==='assets/uploads'){
   const input=req.postDataJSON(),id=crypto.randomUUID();assets.set(id,input);
   result={asset:{id,status:'pending'},upload:{url:`https://signed-storage.test/${id}?signature=keep-this`,method:input.kind==='video'?'POST':'PUT',headers:input.kind==='video'?{}:{'Content-Type':input.contentType,'x-upload-signature':'fixture'},...(input.kind==='video'?{fields:{policy:'signed-form-policy'}}:{}),expiresAt:new Date(Date.now()+60000).toISOString()}};
  }else if(endpoint.endsWith('/complete')){const id=endpoint.split('/')[1];assert(assets.has(id));result={id,status:'ready'}}
  else if(endpoint.endsWith('/access'))result={url:`https://signed-storage.test/result?signature=${++accessCount}`,downloadUrl:`https://signed-storage.test/download?signature=${accessCount}`,expiresAt:new Date(Date.now()+60000).toISOString()};
  else if(endpoint==='jobs'){
   if(req.method()==='POST'){const input=req.postDataJSON();submissions.push(input);result={jobs:[{id:crypto.randomUUID(),kind:input.kind,status:'queued',name:'Fixture',createdAt:new Date().toISOString(),details:{},outputs:{}}]}}
   else result={jobs:[]};
  }else throw new Error(`Unexpected API request ${endpoint}`);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
 });
 await page.goto(base);await page.getByLabel('Character art direction').waitFor();
 const result=await page.evaluate(async()=>{
  const client=await import('/cast-studio/src/api.ts');
  const character=await client.uploadMedia(new File(['image bytes'],'face.png',{type:'image/png'}),'image');
  const video=await client.uploadMedia(new File(['video bytes'],'clip.mp4',{type:'video/mp4'}),'video');
  const jobs=await client.submitGeneration({idempotencyKey:crypto.randomUUID(),kind:'motion-transfer',inputs:{video,character,background:character},parameters:{prompt:'Dance in the garden',quality:'720p',keepAudio:true}});
  const first=await client.resolveAsset(character),renewed=await client.resolveAsset(character);
  return {id:jobs[0].id,character,video,first,renewed};
 });
 assert.equal(uploads.length,2);assert.equal(uploads[0].method,'PUT');assert.equal(uploads[1].method,'POST');assert.match(uploads[1].contentType,/multipart\/form-data/);
 assert.equal(submissions.length,1);assert.deepEqual(submissions[0].inputs,{video:result.video,character:result.character,background:result.character});
 assert(!JSON.stringify(submissions).includes('https:'));assert.notEqual(result.first.url,result.renewed.url);assert.deepEqual(errors,[]);
 fs.writeFileSync(out+'/api-browser-checks.json',JSON.stringify({signedPutAndPost:true,appCookiesNotForwarded:true,assetIdsOnly:true,refreshAccess:true,submissions,errors},null,2));
 console.log('PASS: actual browser client, signed PUT and POST uploads, no cookie forwarding, asset IDs, access refresh');
}finally{await browser.close()}
