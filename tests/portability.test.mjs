import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
test('maintained runtime source contains no private workstation paths or hostnames',()=>{
 // Construct these markers so the audit does not match its own fixture.
 const privateMarkers=[['/home/','ak','atz'].join(''),['/mnt/','shared'].join(''),['tail9','ecf7d'].join(''),['ak','atz-arch'].join(''),['ak','atzfeyserver'].join('')];
 for(const root of ['src','server','shared','scripts','tests','docs','resources','workflows','custom_nodes','vendor'])for(const entry of fs.readdirSync(root,{recursive:true,withFileTypes:true})){
  if(!entry.isFile()||!['.ts','.tsx','.mjs','.py','.json','.md','.css','.toml','.lock','.js'].includes(path.extname(entry.name)))continue;
  const file=path.join(entry.parentPath,entry.name),text=fs.readFileSync(file,'utf8');for(const marker of privateMarkers)assert.ok(!text.includes(marker),`${file} contains a private deployment marker`);
 }
});
