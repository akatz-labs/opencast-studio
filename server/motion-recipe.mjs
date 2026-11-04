import fs from 'node:fs';
import crypto from 'node:crypto';
export const motionOutputs={video:{name:'video.mp4',contentType:'video/mp4'},poster:{name:'poster.png',contentType:'image/png'},manifest:{name:'manifest.json',contentType:'application/json'},workflow:{name:'workflow.json',contentType:'application/json'}};
export async function prepareMotion({request,inputFiles,directory}){
 const parameters={...request.parameters,seed:request.parameters.seed??crypto.randomInt(2147483648)};
 const input={version:1,workflowVersion:'opencast-alisson-v1',kind:request.kind,parameters,background:!!inputFiles.background};
 fs.writeFileSync(directory+'/motion.json',JSON.stringify(input,null,2));
 return {inputs:input,files:{'motion.json':directory+'/motion.json','source-upload':inputFiles.video,'character-upload':inputFiles.character,...(inputFiles.background?{'background-upload':inputFiles.background}:{})},details:{...parameters,megapixels:parameters.quality==='480p'?0.5:1,model:request.kind==='character-swap'?'Alisson Character Swap v1.1':'Alisson TARA Motion Transfer v1.0',workflowVersion:'opencast-alisson-v1'}};
}
