/** Host-owned development selection. Never comes from an app recipe or remote client. */
import {readFile,realpath,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const PROBE=String.raw`
import importlib,importlib.metadata as m,json,sys,tomllib
from pathlib import Path
from packaging.requirements import Requirement
root=Path(sys.argv[1]).resolve(); versions={}
for name,package,module in [('comfygit','cli','comfygit_cli'),('comfygit-core','core','comfygit_core'),('comfygit-studio','studio-runtime','comfygit_studio')]:
 d=m.distribution(name); source=root/'packages'/package
 declared=tomllib.loads((source/'pyproject.toml').read_text())['project']
 direct=json.loads(d.read_text('direct_url.json') or '{}')
 assert direct.get('dir_info',{}).get('editable') and direct.get('url')==source.as_uri(), name+' is not editable from selected source'
 assert Path(importlib.import_module(module).__file__).resolve().is_relative_to(source), name+' resolves outside selected source'
 assert d.version==declared['version'], name+' metadata is stale; run uv sync --frozen --all-packages'
 actual={str(Requirement(r)) for r in (d.requires or []) if 'extra ==' not in r}
 expected={str(Requirement(r)) for r in declared.get('dependencies',[])}
 assert actual==expected, name+' dependency metadata is stale; run uv sync --frozen --all-packages'
 versions[name]=d.version
assert len(set(versions.values()))==1, 'ComfyGit versions must match'
from comfygit_core import Workspace
print(json.dumps({'versions':versions,'sourceRoot':str(root)}))
`;
export async function developmentComfyGit({env=process.env,home=homedir(),platform=process.platform}={}) {
  if(env.AKATZ_COMFYGIT_MODE==='release')return null;
  let source=env.AKATZ_COMFYGIT_DEV_ROOT;
  if(!source){
    const base=platform==='win32'?(env.APPDATA||join(home,'AppData','Roaming')):platform==='darwin'?join(home,'Library','Application Support'):(env.XDG_CONFIG_HOME||join(home,'.config'));
    let config;try{config=JSON.parse(await readFile(join(base,'akatz','comfygit-development.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(config.schemaVersion!==1||typeof config.enabled!=='boolean')throw new Error('Invalid ComfyGit development configuration');
    if(!config.enabled)return null;source=config.sourceRoot;
  }
  if(typeof source!=='string'||!isAbsolute(source))throw new Error('ComfyGit development sourceRoot must be absolute');
  const sourceRoot=await realpath(source),bin=join(sourceRoot,'.venv',platform==='win32'?'Scripts':'bin');
  const python=join(bin,platform==='win32'?'python.exe':'python'),cg=join(bin,platform==='win32'?'cg.exe':'cg');
  await Promise.all([access(python,constants.X_OK),access(cg,constants.X_OK)]);
  const {stdout}=await execute(python,['-I','-c',PROBE,sourceRoot],{timeout:15000,maxBuffer:65536,windowsHide:true});
  return {mode:'editable-source',sourceRoot,python,cg,...JSON.parse(stdout)};
}
