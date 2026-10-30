/** Import only visually selected, verified character sheets; preserve source records. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
const [root,storageVersion]=process.argv.slice(2);
if(!root||!/^asv_[a-f0-9]{32}$/.test(storageVersion||''))throw new Error('Usage: node scripts/import-gallery-sheets.mjs ALLOCATED_REVIEW_DIRECTORY STORAGE_VERSION');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const gallery=await read('src/gallery.json'),review=await read(path.join(root,'selection.json'));
if(review.characters.length!==gallery.length||new Set(review.characters.map(r=>r.characterId)).size!==gallery.length)throw new Error('Review must cover every gallery character once.');
const entries=[];
for(let index=0;index<gallery.length;index++){
 const c=gallery[index],selection=review.characters.find(r=>r.characterId===c.id);
 if(!selection||selection.accepted!==true)throw new Error('Unreviewed character '+c.id);
 const relative='renders/'+selection.renderId,dir=path.join(root,relative),r=await read(path.join(dir,'receipt.json'));
 if(r.state!=='complete'||r.characterId!==c.id)throw new Error('Incomplete or mismatched render '+c.id);
 const assets={};const bytesByView={};
 for(const view of ['portrait','body','sheet']){
  const bytes=await fs.readFile(path.join(dir,view+'.png'));bytesByView[view]=bytes;
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==r.outputs[view].sha256)throw new Error('Output digest mismatch '+c.id+'/'+view);
  const metadata=await sharp(bytes).metadata();if(metadata.width!==(view==='sheet'?2048:1024)||metadata.height!==1536)throw new Error('Incorrect reference dimensions');
  const previews=[];for(const width of view==='sheet'?[960,1600]:[160,480,960])previews.push({width,bytes:await sharp(bytes).resize({width}).webp({quality:88}).toBuffer()});
  const revision=crypto.createHash('sha256').update(Buffer.concat(previews.map(p=>p.bytes))).digest('hex').slice(0,10);const key=`${c.id}-${view}-${revision}`;
  for(const preview of previews)await fs.writeFile(`public/media/${key}-${preview.width}.webp`,preview.bytes);
  assets[view]=key;
 }
 const portrait=await sharp(bytesByView.portrait).removeAlpha().raw().toBuffer();const body=await sharp(bytesByView.body).removeAlpha().raw().toBuffer();
 for(const [x,original]of [[0,portrait],[1024,body]]){const panel=await sharp(bytesByView.sheet).extract({left:x,top:0,width:1024,height:1536}).removeAlpha().raw().toBuffer();if(!panel.equals(original))throw new Error('Sheet panel changed pixels '+c.id)}
 if(r.mode==='existing-portrait'){const original=await sharp(await fs.readFile(path.join(root,'sources',c.id+'.png'))).removeAlpha().raw().toBuffer();if(!original.equals(portrait))throw new Error('Original close-up changed '+c.id)}
 c.gridView=index%2?'body':'portrait';c.image=assets[c.gridView];c.aspect=2/3;
 c.referenceSheet={image:assets.sheet,portraitImage:assets.portrait,bodyImage:assets.body,mode:r.mode,seed:r.seed,bodySeed:r.bodySeed,prompt:r.prompt,fullBodyPrompt:r.fullBodyPrompt,direction:r.direction,placement:r.placement,storageVersion};
 entries.push({characterId:c.id,sourceJob:r.sourceJob,sourceStorageVersion:r.sourceStorageVersion,sourceSha256:r.sourceSha256,mode:r.mode,renderId:r.id,storageVersion,manifest:relative+'/receipt.json',outputs:{sheet:relative+'/sheet.png',portrait:relative+'/portrait.png',body:relative+'/body.png'},sha256:Object.fromEntries(['sheet','portrait','body'].map(v=>[v,r.outputs[v].sha256])),placement:r.placement,review:selection.notes});
}
await fs.writeFile('src/gallery.json',JSON.stringify(gallery,null,2)+'\n');
await fs.writeFile('docs/gallery-sheets.json',JSON.stringify({schemaVersion:1,recipe:'cast-krea-character-sheet-v2',storageVersion,artifactRoot:path.resolve(root),characters:entries,review},null,2)+'\n');
console.log(`Imported ${entries.length} reviewed sheets; original portrait and both panel pixels verified.`);
