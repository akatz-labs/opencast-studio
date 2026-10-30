import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function atomicJson(location,value){
 fs.mkdirSync(path.dirname(location),{recursive:true});
 const tmp=location+'.'+crypto.randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 fs.renameSync(tmp,location);
}
export const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const fail=(status,message)=>Object.assign(new Error(message),{status});
export function serial(){let tail=Promise.resolve();return fn=>{const next=tail.then(fn);tail=next.catch(()=>{});return next}}
