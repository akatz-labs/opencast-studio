import { createServer } from 'node:http';
import { DatabaseSync, backup } from 'node:sqlite';
import { createReadStream, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { configPath } from './index.mjs';
import { storagePaths, syncDirectory } from './storage.mjs';
import { inspectMp4File } from './mp4.mjs';

export const MEDIA_API_VERSION = 1;
export const MAX_MEDIA_BYTES = 4 * 1024 ** 3;
const IMAGE_LIMIT = 25 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const fail = (status, message) => Object.assign(new Error(message), { status });
const stamp = () => new Date().toISOString();
export async function mediaConfig(options = {}) {
  const env = options.env ?? process.env;
  let value = {};
  try { value = JSON.parse(await readFile(join(dirname(configPath(options)), 'media.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (Object.keys(value).some(key => !['schemaVersion','root','url'].includes(key)) || (value.schemaVersion !== undefined && value.schemaVersion !== 1)) throw new Error('Invalid media configuration');
  const root = resolve(env.AKATZ_MEDIA_ROOT || value.root || join(storagePaths('library', options).dataRoot, 'media'));
  const url = new URL(env.AKATZ_MEDIA_URL || value.url || 'http://127.0.0.1:8840');
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Media v1 requires a loopback HTTP origin');
  return { root, url: url.origin };
}
function text(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw fail(400, `Invalid ${label}`);
  return value;
}
function association(value) {
  if (!value || typeof value !== 'object') throw fail(400, 'A project association is required');
  const result = {};
  for (const key of ['appId','instanceId','projectId']) {
    if (!ID.test(value[key] ?? '')) throw fail(400, `Invalid ${key}`);
    result[key] = value[key];
  }
  return result;
}
function metadata(value) {
  const source = association(value);
  const name = text(value.name, 'name', 180), sourceKey = text(value.sourceKey, 'sourceKey');
  const parents = value.parents ?? [];
  if (!Array.isArray(parents) || parents.length > 32 || parents.some(id => typeof id !== 'string' || !ID.test(id))) throw fail(400,'Invalid parent media IDs');
  const origin = value.origin ?? null;
  if (origin !== null) text(origin, 'origin', 2048);
  const result = { ...source, sourceKey, name, parents: [...new Set(parents)].sort(), origin };
  if (value.createdAt !== undefined) {
    if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw fail(400,'Invalid original timestamp');
    result.createdAt = value.createdAt;
  }
  return result;
}
export function inspectMedia(bytes) {
  const n = bytes.length;
  if (n >= 33 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let p = 8, ended = false;
    while (p + 12 <= n) {
      const size = bytes.readUInt32BE(p), kind = bytes.toString('ascii',p+4,p+8);
      if (p === 8 && (kind !== 'IHDR' || size !== 13 || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20))) break;
      if (p + size + 12 > n) break;
      p += size + 12;
      if (kind === 'IEND') { ended = size === 0 && p === n; break; }
    }
    if (!ended || n > IMAGE_LIMIT) throw fail(400,'Incomplete or oversized PNG');
    return { mime: 'image/png', extension: '.png' };
  }
  if (n >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    if (bytes[n-2] !== 255 || bytes[n-1] !== 217 || n > IMAGE_LIMIT) throw fail(400,'Incomplete or oversized JPEG');
    return { mime: 'image/jpeg', extension: '.jpg' };
  }
  if (n >= 20 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== n || n > IMAGE_LIMIT) throw fail(400,'Incomplete or oversized WebP');
    return { mime: 'image/webp', extension: '.webp' };
  }
  if (n >= 28 && bytes.toString('ascii',0,4) === 'glTF') {
    if (bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== n) throw fail(400,'Incomplete GLB 2.0');
    let p = 12, doc, binary = 0;
    while (p < n) {
      if (p+8 > n) throw fail(400,'Truncated GLB chunk');
      const size = bytes.readUInt32LE(p), kind = bytes.readUInt32LE(p+4);
      if (size % 4 || p+8+size > n || (p === 12 && kind !== 0x4e4f534a)) throw fail(400,'Invalid GLB chunk');
      if (kind === 0x4e4f534a) {
        if (doc) throw fail(400,'Duplicate GLB JSON');
        try { doc = JSON.parse(bytes.toString('utf8',p+8,p+8+size)); } catch { throw fail(400,'Invalid GLB JSON'); }
      }
      if (kind === 0x004e4942) binary += size;
      p += size + 8;
    }
    if (doc?.asset?.version !== '2.0' || !doc.meshes?.length) throw fail(400,'GLB must contain a mesh');
    for (const item of [...(doc.buffers || []), ...(doc.images || [])]) if (item.uri && !item.uri.startsWith('data:')) throw fail(400,'GLB must embed its buffers and textures');
    if ((doc.buffers || []).some(item => !item.uri && item.byteLength > binary)) throw fail(400,'GLB is missing binary data');
    return { mime: 'model/gltf-binary', extension: '.glb' };
  }
  throw fail(415,'Supported media: PNG, JPEG, WebP and self-contained GLB');
}
export async function inspectMediaFile(file) {
  const handle = await open(file, 'r');
  const header = Buffer.alloc(12); let size;
  try { size = (await handle.stat()).size; await handle.read(header, 0, 12, 0); }
  finally { await handle.close(); }
  if (header.toString('ascii', 4, 8) === 'ftyp') return inspectMp4File(file);
  if (size > 512 * 1024 * 1024) throw fail(413, 'Non-video media exceeds 512 MB');
  return inspectMedia(await readFile(file));
}
async function jsonBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw fail(413,'Metadata too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw fail(400,'Invalid JSON'); }
}
export async function createMediaService({ root: location } = {}) {
  const root = resolve(location || (await mediaConfig()).root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, 'service.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Never steal a live or ambiguous owner. An operator can recover malformed locks.
    const pid = Number(await readFile(lockPath,'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Media library has an ambiguous owner lock');
    try { process.kill(pid, 0); throw new Error('Media library is already owned by a running service'); }
    catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
    await rm(lockPath); lock = await open(lockPath,'wx',0o600);
  }
  await lock.writeFile(String(process.pid));
  let db;
  try {
    await mkdir(join(root,'blobs'),{recursive:true,mode:0o700});
    await mkdir(join(root,'staging'),{recursive:true,mode:0o700});
    for (const entry of await readdir(join(root,'staging'))) await rm(join(root,'staging',entry),{force:true});
    db = new DatabaseSync(join(root,'catalog.sqlite'));
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0,1,2,3].includes(version)) throw new Error('Unsupported media catalog schema');
    if(version>0&&version<3){await mkdir(join(root,'backups'),{recursive:true,mode:0o700});await backup(db,join(root,'backups','before-schema-3-'+Date.now()+'.sqlite'));}
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS library (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, extension TEXT NOT NULL, metadata TEXT NOT NULL, app_id TEXT NOT NULL, instance_id TEXT NOT NULL, project_id TEXT NOT NULL, source_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(app_id,instance_id,project_id,source_key));
      CREATE TABLE IF NOT EXISTS links (media_id TEXT NOT NULL REFERENCES media(id), app_id TEXT NOT NULL, instance_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(media_id,app_id,instance_id,project_id));
      CREATE TABLE IF NOT EXISTS trash (media_id TEXT PRIMARY KEY REFERENCES media(id), trashed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS apps (app_id TEXT NOT NULL, instance_id TEXT NOT NULL, name TEXT NOT NULL, data_root TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(app_id,instance_id));
      CREATE TABLE IF NOT EXISTS projects (app_id TEXT NOT NULL, instance_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(app_id,instance_id,project_id));
      PRAGMA user_version=3; COMMIT;`);
    if (!db.prepare('SELECT id FROM library').get()) db.prepare('INSERT INTO library VALUES (?)').run(randomUUID());
  } catch (error) { db?.close(); await lock.close(); await rm(lockPath); throw error; }
  const libraryId = db.prepare('SELECT id FROM library').get().id;
  const get = id => { const row=db.prepare('SELECT * FROM media WHERE id=?').get(id); if(!row)throw fail(404,'Media not found');return row; };
  const trashed = id => db.prepare('SELECT trashed_at FROM trash WHERE media_id=?').get(id)?.trashed_at || null;
  const active = id => {const row=get(id);if(trashed(id))throw fail(409,'Media is in trash; restore it first');return row;};
  const available = row => {try {return statSync(join(root,'blobs',row.hash)).size===row.size;}catch{return false;}};
  const info = row => ({ id:row.id,libraryId,hash:row.hash,size:row.size,mime:row.mime,createdAt:row.created_at,available:!trashed(row.id)&&available(row),trashedAt:trashed(row.id),...JSON.parse(row.metadata),links:db.prepare('SELECT app_id appId,instance_id instanceId,project_id projectId FROM links WHERE media_id=?').all(row.id) });
  function link(id, value) { const a=association(value);active(id);db.prepare('INSERT OR IGNORE INTO links VALUES (?,?,?,?)').run(id,a.appId,a.instanceId,a.projectId); }
  async function ingest(req, input) {
    const meta=metadata(input), serialized=JSON.stringify(meta), staging=join(root,'staging',randomUUID());
    const file=await open(staging,'wx',0o600);let size=0;const digest=createHash('sha256');
    try {
      for await(const chunk of req) { size+=chunk.length;if(size>MAX_MEDIA_BYTES)throw fail(413,'Media exceeds 4 GB');digest.update(chunk);await file.writeFile(chunk); }
      if(!size)throw fail(400,'Empty media');
      await file.sync();await file.close();
      const format=await inspectMediaFile(staging),hash=digest.digest('hex');
      for(const parent of meta.parents)active(parent);
      await rename(staging,join(root,'blobs',hash));
      await syncDirectory(join(root,'blobs'));
      for(const parent of meta.parents)active(parent);
      const previous=db.prepare('SELECT * FROM media WHERE app_id=? AND instance_id=? AND project_id=? AND source_key=?').get(meta.appId,meta.instanceId,meta.projectId,meta.sourceKey);
      if(previous) {
        active(previous.id);
        if(previous.hash!==hash || previous.metadata!==serialized)throw fail(409,'Source key already has different content or provenance');
        // Restore bytes if they were externally removed; the verified digest is identical.
        return info(previous);
      }
      const id=randomUUID();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO media VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,hash,size,format.mime,format.extension,serialized,meta.appId,meta.instanceId,meta.projectId,meta.sourceKey,meta.createdAt || stamp());
        link(id,meta);db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      return info(get(id));
    } finally { await file.close().catch(()=>{});await rm(staging,{force:true}); }
  }
  const server=createServer(async(req,res)=>{
    const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
    try {
      const host=new URL('http://'+req.headers.host);
      if(!LOOPBACK.has(host.hostname))throw fail(403,'Loopback Host required');
      if(req.headers.origin && req.headers.origin!==host.origin)throw fail(403,'Cross-origin media access is disabled');
      const url=new URL(req.url,host),path=url.pathname.split('/').filter(Boolean),method=req.method;
      if(path[0]!=='v1')throw fail(404,'Unknown media API version');
      if(path.length===2 && path[1]==='health' && method==='GET')return json(200,{ok:true,apiVersion:1,schemaVersion:3,libraryId,storageRoot:root,capabilities:['import','list','metadata','bytes','ranges','project-links','parents','trash','restore','mp4','app-registry','project-registry'],storage:{local:true,cloud:false}});
      if(path.length===2 && ['apps','projects'].includes(path[1])) {
        const table=path[1];
        if(method==='POST') {
          const value=await jsonBody(req),a=association({...value,projectId:value.projectId||'default'}),name=text(value.name,'name',180);
          if(table==='apps') {
            const dataRoot=text(value.dataRoot,'dataRoot',2048);
            db.prepare('INSERT INTO apps VALUES (?,?,?,?,?) ON CONFLICT(app_id,instance_id) DO UPDATE SET name=excluded.name,data_root=excluded.data_root,updated_at=excluded.updated_at').run(a.appId,a.instanceId,name,dataRoot,stamp());
          } else {
            if(!db.prepare('SELECT 1 FROM apps WHERE app_id=? AND instance_id=?').get(a.appId,a.instanceId))throw fail(409,'Register the app instance first');
            const createdAt=value.createdAt||stamp();if(!Number.isFinite(Date.parse(createdAt)))throw fail(400,'Invalid project timestamp');
            db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?) ON CONFLICT(app_id,instance_id,project_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at').run(a.appId,a.instanceId,a.projectId,name,createdAt,stamp());
          }
          return json(200,{ok:true});
        }
        if(method==='GET') {
          const where=[],args=[];
          for(const [param,column] of [['appId','app_id'],['instanceId','instance_id']])if(url.searchParams.has(param)){where.push(column+'=?');args.push(url.searchParams.get(param));}
          const rows=db.prepare('SELECT * FROM '+table+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY updated_at DESC').all(...args);
          const items=rows.map(row=>({appId:row.app_id,instanceId:row.instance_id,name:row.name,...(table==='apps'?{dataRoot:row.data_root}:{projectId:row.project_id,createdAt:row.created_at}),updatedAt:row.updated_at}));
          return json(200,{items});
        }
      }
      if(path[1]!=='media')throw fail(404,'Unknown endpoint');
      if(path.length===2) {
        if(method==='POST') {
          let input;try{input=JSON.parse(url.searchParams.get('metadata'));}catch{throw fail(400,'Invalid import metadata');}
          return json(201,await ingest(req,input));
        }
        if(method==='GET') {
          const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit')||100))),offset=Math.max(0,Number(url.searchParams.get('offset')||0));
          if(!Number.isInteger(limit)||!Number.isInteger(offset))throw fail(400,'Invalid page');
          const where=[],args=[];
          if(url.searchParams.get('includeTrashed')!=='true')where.push('NOT EXISTS (SELECT 1 FROM trash WHERE trash.media_id=media.id)');
          for(const [param,column] of [['appId','app_id'],['mime','mime']])if(url.searchParams.has(param)){where.push(column+'=?');args.push(url.searchParams.get(param));}
          if(url.searchParams.has('kind')){const kind=url.searchParams.get('kind');if(!['image','video','model'].includes(kind))throw fail(400,'Invalid media kind');where.push('mime LIKE ?');args.push(kind+'/%');}
          if(url.searchParams.has('q')){where.push("json_extract(metadata,'$.name') LIKE ?");args.push('%'+url.searchParams.get('q')+'%');}
          const rows=db.prepare('SELECT * FROM media'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(...args,limit+1,offset);
          return json(200,{items:rows.slice(0,limit).map(info),nextOffset:rows.length>limit?offset+limit:null});
        }
      }
      const row=get(path[2]);
      if(path.length===3 && method==='GET')return json(200,info(row));
      if(path.length===4 && path[3]==='trash') {
        if(method==='POST'){
          if(db.prepare('SELECT 1 FROM links WHERE media_id=? LIMIT 1').get(row.id))throw fail(409,'Remove project associations before trashing media');
          const child=db.prepare("SELECT m.id FROM media m,json_each(m.metadata,'$.parents') p WHERE p.value=? AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.media_id=m.id) LIMIT 1").get(row.id);
          if(child)throw fail(409,'Active derived media still references this original');
          db.prepare('INSERT OR IGNORE INTO trash VALUES (?,?)').run(row.id,stamp());
        }else if(method==='DELETE'){
          for(const parent of JSON.parse(row.metadata).parents)active(parent);
          db.prepare('DELETE FROM trash WHERE media_id=?').run(row.id);
        }
        else throw fail(405,'Method not allowed');
        return json(200,info(get(row.id)));
      }
      if(path.length===4 && path[3]==='links') {
        const a=association(await jsonBody(req));
        if(method==='POST')link(row.id,a);
        else if(method==='DELETE')db.prepare('DELETE FROM links WHERE media_id=? AND app_id=? AND instance_id=? AND project_id=?').run(row.id,a.appId,a.instanceId,a.projectId);
        else throw fail(405,'Method not allowed');
        return json(200,info(get(row.id)));
      }
      if(path.length===4 && ['file','preview'].includes(path[3]) && ['GET','HEAD'].includes(method)) {
        if(trashed(row.id))throw fail(410,'Media is in trash; restore it first');
        if(path[3]==='preview'&&!row.mime.startsWith('image/'))throw fail(404,'No image preview');
        const file=join(root,'blobs',row.hash);const stats=await stat(file).catch(()=>null);
        if(!stats||stats.size!==row.size)throw fail(409,'Library bytes are missing or changed; reimport from the source');
        let start=0,end=row.size-1,status=200;
        const headers={'content-type':row.mime,'content-length':row.size,'accept-ranges':'bytes','cache-control':'private, max-age=86400','x-content-type-options':'nosniff','etag':'"'+row.hash+'"','content-disposition':`${url.searchParams.get('download')==='1'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(JSON.parse(row.metadata).name)}`};
        if(req.headers.range) {
          const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if(match&&(match[1]||match[2])) {start=match[1]?Number(match[1]):Math.max(0,row.size-Number(match[2]));end=match[1]&&match[2]?Math.min(Number(match[2]),end):end;}
          else start=-1;
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=row.size){res.writeHead(416,{'content-range':`bytes */${row.size}`});return res.end();}
          status=206;headers['content-range']=`bytes ${start}-${end}/${row.size}`;headers['content-length']=end-start+1;
        }
        res.writeHead(status,headers);if(method==='HEAD')return res.end();
        const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());return stream.pipe(res);
      }
      throw fail(404,'Unknown endpoint');
    }catch(error){if(!res.headersSent)json(error.status||500,{message:error.status?error.message:'Media service could not complete the request'});else res.destroy();}
  });
  return {server,root,libraryId,async close(){await new Promise(resolve=>server.close(resolve));db.close();await lock.close();await rm(lockPath,{force:true});}};
}
