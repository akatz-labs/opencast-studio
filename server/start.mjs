import {configuredResources} from './resources.mjs';
import http from 'node:http';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {apiV1} from './api-v1.mjs';
import {assetService,localMediaStore} from './assets.mjs';
import {configuredExecutor} from './configured-executor.mjs';
import {file,immutableAsset} from './files.mjs';
import {dataDirectory,basePath,origins} from './deployment.mjs';

// Portable entry point: no fleet paths, SSH identity, managed-storage CLI, or GPU
// startup is implicit. The shared runner owns ComfyUI, models and GPU admission.
const directory=dataDirectory;
const port=Number(process.env.PORT||8389),prefix=basePath;
const assets=assetService({directory,store:localMediaStore({directory:directory+'/media',base:prefix+'/api/v1'})});
const executor=await configuredExecutor({directory,assets});
const api=apiV1({directory,assets,executor,resources:configuredResources(),allowedOrigins:origins(port)});
const dist=path.resolve(process.env.OPENCAST_DIST||'dist');
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),route=url.pathname.startsWith(prefix+'/')?url.pathname.slice(prefix.length):url.pathname;
 if(await api(req,res,route,url))return;
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
 let decoded;try{decoded=decodeURIComponent(route)}catch{res.writeHead(400);res.end();return}
 const target=path.resolve(dist,'.'+(decoded==='/'?'/index.html':decoded));
 if(!target.startsWith(dist+path.sep)||decoded.includes('\0')){res.writeHead(400);res.end();return}
 file(req,res,target,null,{immutable:immutableAsset(route)});
});
server.listen(port,'127.0.0.1',()=>{
 const url=`http://127.0.0.1:${port}${prefix}/`;
 console.log(`OpenCast Studio: ${url}`);
 if(process.env.OPENCAST_OPEN_BROWSER==='1'||process.stdout.isTTY&&process.env.OPENCAST_OPEN_BROWSER!=='0'&&!process.env.CI){
  const command=process.platform==='darwin'?'open':process.platform==='win32'?'rundll32':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  const browser=spawn(command,args,{stdio:'ignore',detached:true});browser.unref();
  browser.on('error',()=>console.log('Open the Studio URL above in your browser.'));
 }
});
const timer=setInterval(()=>void executor.tick(),2000);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);server.close()});
