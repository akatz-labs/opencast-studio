import fs from 'node:fs';
import path from 'node:path';
import {releaseFiles} from './release-files.mjs';
const issues=[];
for(const file of ['server/hosted','deploy','tests/hosted','scripts/hosted-local-config.mjs'])if(fs.existsSync(file))issues.push(file+': hosted implementation belongs in a separate repository');
const packageJson=JSON.parse(fs.readFileSync('package.json'));
if(packageJson.dependencies.pg||Object.keys(packageJson.scripts).some(k=>k.includes('hosted')))issues.push('package.json: hosted dependency or entry point');
const patterns={
 'private workstation':new RegExp(['/home/'+'ak'+'atz','/mnt/'+'shared','/mnt/'+'hub-','tail9'+'ecf7d','ak'+'atz-arch','ak'+'atzfeyserver'].join('|')),
 'private key':/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
 'provider token':/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,}|hf_[A-Za-z0-9]{30,}|sb_secret_[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}/,
};
const files=releaseFiles();
for(const file of files){
 if(/(?:^|\/)(?:\.env(?!\.example$)|hub-library\.json$)|\.(?:zip|pem|key|sqlite|db|log)$/.test(file))issues.push(file+': private state or generated artifact');
 if(fs.statSync(file).size>=50*1024*1024)issues.push(file+': unexpected large release file');
 if(['.mjs','.js','.ts','.tsx','.json','.py','.md','.toml','.lock','.txt','.css','.html'].includes(path.extname(file))||file==='.env.example'){
  const text=fs.readFileSync(file,'utf8');for(const [rule,pattern]of Object.entries(patterns))if(pattern.test(text))issues.push(file+': '+rule);
 }
}
const models=JSON.parse(fs.readFileSync('resources/models.json')).models;
for(const m of models){if(!m.url.startsWith('https://')||!m.url.includes(m.revision)||!/^[a-f0-9]{64}$/.test(m.sha256)||m.sizeBytes<1||!['manual','download'].includes(m.acquisition))issues.push('Invalid model pin: '+m.id)}
if(new Set(models.map(m=>m.relativePath)).size!==models.length)issues.push('Duplicate model destinations');
console.log(JSON.stringify({files:files.length,models:models.length,modelGiB:Number((models.reduce((n,m)=>n+m.sizeBytes,0)/1024**3).toFixed(1)),issues},null,2));
if(issues.length)process.exitCode=1;
