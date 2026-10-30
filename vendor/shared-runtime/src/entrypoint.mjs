import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
/** Node resolves a symlinked entry module but retains its original argv path. */
export function isMain(url,entry=process.argv[1]) {
  if(!entry)return false;
  try{return realpathSync(entry)===realpathSync(fileURLToPath(url));}catch{return false;}
}
