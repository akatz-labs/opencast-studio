import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
const originals=process.argv[2];
if(!originals)throw new Error('Usage: node scripts/prepare-media.mjs ORIGINALS_DIRECTORY');
await fs.mkdir('public/media',{recursive:true});
for(const key of ['nyra','ren','elise','jasper','milo','zuri','felix','mei']){
  for(const width of [160,480,960])await sharp(path.join(originals,`${key}.png`)).resize({width}).webp({quality:82}).toFile(`public/media/${key}-${width}.webp`);
}
