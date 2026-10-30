import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const dataDirectory=path.resolve(process.env.OPENCAST_DATA||path.join(os.homedir(),'.local/share/opencast'));
export const basePath=(process.env.OPENCAST_BASE_PATH||'').replace(/\/$/,'');
if(basePath&&(!basePath.startsWith('/')||basePath.includes('..')||basePath.includes('?')))throw new Error('OPENCAST_BASE_PATH must be a URL path prefix.');
export const deployment=process.env.OPENCAST_DEPLOYMENT_MODULE?await import(pathToFileURL(path.resolve(process.env.OPENCAST_DEPLOYMENT_MODULE)).href):{};
export function origins(port){return [`http://127.0.0.1:${port}`,`http://localhost:${port}`,'http://127.0.0.1:5173',...(process.env.OPENCAST_ALLOWED_ORIGINS||'').split(',').filter(Boolean)]}

// Local artifact retention is portable; deployments may supply a storage adapter.
export async function storage(command,...args){
 if(deployment.storage)return deployment.storage(command,...args);
 if(command==='begin-write'){
  const key=args[args.indexOf('--key')+1],id=crypto.createHash('sha256').update(key).digest('hex');
  const directory=path.join(dataDirectory,'artifacts',id);fs.mkdirSync(directory,{recursive:true});return {id,path:directory};
 }
 if(command==='commit-write')return {version_id:'local:'+args[0]};
 throw new Error('The selected storage adapter does not support this operation.');
}
