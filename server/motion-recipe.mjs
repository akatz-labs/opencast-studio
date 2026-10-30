import fs from 'node:fs';
import crypto from 'node:crypto';
export const motionOutputs={video:{name:'video.mp4',contentType:'video/mp4'},poster:{name:'poster.png',contentType:'image/png'},anchor:{name:'anchor.png',contentType:'image/png'},manifest:{name:'manifest.json',contentType:'application/json'},workflow:{name:'workflow.json',contentType:'application/json'}};
export async function prepareMotion({request,inputFiles,directory}){
 const parameters={...request.parameters,seed:request.parameters.seed??crypto.randomInt(2147483648),anchorSeed:request.parameters.anchorSeed??crypto.randomInt(2147483648)};
 const input={version:1,kind:request.kind,parameters,background:!!inputFiles.background};
 fs.writeFileSync(directory+'/motion.json',JSON.stringify(input,null,2));
 return {inputs:input,files:{'motion.json':directory+'/motion.json','source-upload':inputFiles.video,'character-upload':inputFiles.character,...(inputFiles.background?{'background-upload':inputFiles.background}:{})},details:{...parameters,megapixels:parameters.quality==='480p'?0.5:1,model:'FLUX3 anchor · Pika H3 Flex',workflowVersion:'opencast-motion-flux3-v1'}};
}
