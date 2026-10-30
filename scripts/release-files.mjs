import fs from 'node:fs';
import path from 'node:path';
export const roots=['src','server','shared','scripts','tests','docs','resources','workflows','custom_nodes','vendor','public'];
export function releaseFiles(){
 const files=['AGENTS.md','README.md','LICENSE','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','index.html','tsconfig.json','vite.config.ts','.gitignore','.env.example'];
 for(const root of roots)for(const entry of fs.readdirSync(root,{recursive:true,withFileTypes:true})){
  const file=path.join(entry.parentPath,entry.name);
  if(entry.isSymbolicLink())throw new Error('Release source must not depend on symlinks: '+file);
  if(entry.isFile()&&!file.includes('__pycache__')&&!file.endsWith('.pyc'))files.push(file);
 }
 return files.sort();
}
