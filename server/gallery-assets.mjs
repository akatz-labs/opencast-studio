import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fail} from './api-state.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const gallery=JSON.parse(fs.readFileSync(root+'src/gallery.json'));

// Portable installs include these reviewed WebP references alongside the UI.
// They do not require the original generation machine or its artifact store.
export function galleryAsset(ref,{directory,assets,owner}){
 const character=gallery.find(c=>c.id===ref.id);
 if(!character)throw fail(404,'Example character not found.');
 const role=ref.role||'sheet';let location,contentType;
 if(role==='manifest'){
  const folder=path.join(directory,'gallery');fs.mkdirSync(folder,{recursive:true});
  location=path.join(folder,character.id+'.json');
  fs.writeFileSync(location,JSON.stringify(character,null,2));contentType='application/json';
 }else{
  const sheet=character.referenceSheet;
  const image=role==='portrait'?sheet?.portraitImage||character.image:role==='body'?sheet?.bodyImage||character.image:sheet?.image||character.image;
  location=[1600,960,480].map(size=>path.join(root,'public','media',`${image}-${size}.webp`)).find(file=>fs.existsSync(file));
  if(!location)throw fail(404,'Example reference image is missing from this installation.');
  contentType='image/webp';
 }
 const record=assets.register(owner,`gallery:${ref.id}:${role}`,{kind:role==='manifest'?'document':'image',name:character.name,contentType,bytes:fs.statSync(location).size,storage:{path:location}});
 return {id:record.id,status:record.status};
}
