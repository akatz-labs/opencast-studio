import { createMediaService, mediaConfig } from './media.mjs';
const config=await mediaConfig(),url=new URL(config.url),service=await createMediaService(config);
service.server.on('error',async error=>{console.error(error.message);await service.close();process.exitCode=1;});
service.server.listen(Number(url.port||80),url.hostname,()=>console.log('Akatz media service listening on '+url.origin));
let closing=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(closing)return;closing=true;void service.close().then(()=>process.exit(0));});
