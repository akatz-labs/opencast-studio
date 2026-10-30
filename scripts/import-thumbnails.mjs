/** Build small, reviewed option thumbnails without changing generation behavior. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const root=process.argv[2],partial=process.argv.includes('--partial');
if(!root)throw new Error('Usage: node scripts/import-thumbnails.mjs REVIEW_DIRECTORY [--partial]');
const plan=JSON.parse(await fs.readFile(path.join(root,'plan.json'),'utf8'));
const review=JSON.parse(await fs.readFile(path.join(root,'review.json'),'utf8'));
const catalog=JSON.parse(await fs.readFile('shared/traits.json','utf8'));
const records=[];
const figure=new Set(['Build','Style','Height','Proportions','Neck']);
const detail=new Set(['Jaw','Chin','Cheeks','Nose','Brows','Mouth','Eye shape','Eye color','Features','Facial hair']);
await fs.mkdir('public/media/options',{recursive:true});
for(const category of catalog){
 category.thumbnailLayout=figure.has(category.name)?'figure':detail.has(category.name)?'detail':'portrait';
 for(const option of category.options){
  const row=plan.find(r=>r.category===category.name&&r.option===option.label);
  if(!row)throw new Error(`Missing plan: ${category.name}/${option.label}`);
  const selected=review.items[row.id];
  if(!selected?.approved){if(partial)continue;throw new Error(`Thumbnail has not passed visual review: ${row.id}`)}
  const referenceId=selected.referenceId||row.id;
  if(!plan.some(r=>r.id===referenceId))throw new Error(`Unknown source reference: ${referenceId}`);
  const receipt=JSON.parse(await fs.readFile(path.join(root,'receipts',referenceId+'.json'),'utf8'));
  if(receipt.state!=='complete'||!receipt.job.storageVersion)throw new Error(`Unretained generation: ${row.id}`);
  const source=selected.source||'originals/'+row.id+'.png';
  if(path.isAbsolute(source)||source.split('/').includes('..'))throw new Error(`Source must be inside the review directory: ${row.id}`);
  const original=await fs.readFile(path.join(root,source));
  const originalSha256=crypto.createHash('sha256').update(original).digest('hex');
  if(!selected.source&&originalSha256!==receipt.job.output.sha256)throw new Error(`Original hash mismatch: ${row.id}`);
  if(selected.source&&(!selected.generator||!selected.promptFile))throw new Error(`Edited source needs generator and prompt provenance: ${row.id}`);
  const metadata=await sharp(original).metadata();
  const crop=selected.crop||{left:0,top:0,width:metadata.width,height:category.thumbnailLayout==='figure'?metadata.height:category.thumbnailLayout==='portrait'?Math.min(metadata.height,Math.round(metadata.width*1.25)):metadata.width};
  if(!['left','top','width','height'].every(k=>Number.isInteger(crop[k])&&crop[k]>=(k==='left'||k==='top'?0:1))||crop.left+crop.width>metadata.width||crop.top+crop.height>metadata.height)throw new Error(`Invalid crop: ${row.id}`);
  const expectedRatio=category.thumbnailLayout==='figure'?2/3:category.thumbnailLayout==='portrait'?4/5:1;
  if(Math.abs(crop.width/crop.height-expectedRatio)>0.01)throw new Error(`Crop must match ${category.thumbnailLayout} tile: ${row.id}`);
  const files=[];
  // Hash encoded bytes too, so changes to compression get a new cacheable URL.
  const previews=[];
  for(const width of [160,320])previews.push({width,bytes:await sharp(original).extract(crop).resize({width}).webp({quality:82,effort:5}).toBuffer()});
  const revision=crypto.createHash('sha256').update(Buffer.concat(previews.map(p=>p.bytes))).digest('hex').slice(0,10);
  const key=`${row.id}-${revision}`;
  for(const {width,bytes:encoded} of previews){
   const output=`public/media/options/${key}-${width}.webp`;
   await fs.writeFile(output,encoded);
   const bytes=(await fs.stat(output)).size;
   if(bytes>60000)throw new Error(`Thumbnail exceeds 60 KB: ${output}`);
   files.push({path:output,width,height:Math.round(width/expectedRatio),bytes});
  }
  option.thumbnail=key;
  records.push({category:category.name,option:option.label,id:row.id,source,sourceSha256:originalSha256,crop,files,generator:selected.generator||'Krea 2 Turbo + LoRA 4000',prompt:selected.promptFile?await fs.readFile(path.join(root,selected.promptFile),'utf8'):receipt.job.prompt,seed:selected.generator?.startsWith('GPT')?null:receipt.job.seed,sourceSeed:receipt.job.seed,sourceJobId:receipt.job.id,sourceStorageVersion:receipt.job.storageVersion,review:selected.note});
 }
}
await fs.writeFile('shared/traits.json',JSON.stringify(catalog,null,2)+'\n');
await fs.writeFile('docs/trait-thumbnails.json',JSON.stringify({schemaVersion:1,complete:!partial,generatedAt:new Date().toISOString(),sizes:[160,320],records},null,2)+'\n');
console.log(`Imported ${records.length} reviewed thumbnails; ${(records.reduce((n,r)=>n+r.files.reduce((s,f)=>s+f.bytes,0),0)/1024).toFixed(0)} KiB for both sizes.`);
