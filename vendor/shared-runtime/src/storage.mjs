import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, link, copyFile, stat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { ecosystemDataRoot } from './index.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');
const migrationDigest = migration => digest(migration.sql + (migration.up ? '\n' + migration.up.toString() : ''));

export function storagePaths(appId, options = {}) {
  if (!ID.test(appId)) throw new Error('Invalid storage app ID');
  const dataRoot = ecosystemDataRoot(options);
  const root = resolve(options.root || join(dataRoot, 'apps', appId));
  return { dataRoot, root, database: join(root, 'state.sqlite'), objects: join(root, 'objects'),
    staging: join(root, 'staging'), cache: join(root, 'cache'), backups: join(root, 'backups') };
}

export function ensureAppIdentity(appId, root, { legacyInstanceId } = {}) {
  if (!ID.test(appId) || (legacyInstanceId && !ID.test(legacyInstanceId))) throw new Error('Invalid app identity');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, 'identity.json');
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, appId, instanceId: legacyInstanceId || randomUUID(), createdAt: now() }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const identity = JSON.parse(readFileSync(file, 'utf8'));
  if (identity.schemaVersion !== 1 || identity.appId !== appId || !ID.test(identity.instanceId)) throw new Error('Storage identity does not match this app');
  return identity;
}

export async function hashFile(file) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk); }
  return { hash: hash.digest('hex'), size };
}

export async function syncDirectory(directory) {
  let handle;
  try { handle = await open(directory, 'r'); await handle.sync(); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

/** A local app owns this handle. Other apps use the shared catalog API. */
export function openAppDatabase({ appId, root, filename = 'state.sqlite', migrations = [], legacyInstanceId, ...options }) {
  if (!/^[a-zA-Z0-9._-]+\.sqlite$/.test(filename)) throw new Error('Invalid database filename');
  const paths = storagePaths(appId, { ...options, root });
  const identity = ensureAppIdentity(appId, paths.root, { legacyInstanceId });
  for (const directory of [paths.objects, paths.staging, paths.cache, paths.backups]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  paths.database = join(paths.root, filename);
  const lockPath = paths.database + '.owner';
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = readFileSync(lockPath, 'utf8'), value = JSON.parse(previous);
    if (!Number.isInteger(value.pid) || value.pid <= 0 || !value.token) throw new Error('Ambiguous database owner');
    try { process.kill(value.pid, 0); throw new Error('App database is already open by a running process'); }
    catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
    if (readFileSync(lockPath, 'utf8') !== previous) throw new Error('Database ownership changed');
    unlinkSync(lockPath); lock = openSync(lockPath, 'wx', 0o600);
  }
  writeFileSync(lock, owner);
  let db, closed = false;
  const release = () => { closeSync(lock); if (readFileSync(lockPath, 'utf8') === owner) unlinkSync(lockPath); };
  try {
    for (const file of readdirSync(paths.staging)) unlinkSync(join(paths.staging,file));
    const existing = existsSync(paths.database);
    db = new DatabaseSync(paths.database);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    db.exec('CREATE TABLE IF NOT EXISTS _akatz_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const applied = db.prepare('SELECT * FROM _akatz_migrations ORDER BY version').all();
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    if (sorted.some((m, i) => m.version !== i + 1 || typeof m.sql !== 'string' || (m.up && typeof m.up !== 'function'))) throw new Error('Migrations must be consecutive SQL versions starting at 1');
    for (const row of applied) if (!sorted[row.version - 1] || migrationDigest(sorted[row.version - 1]) !== row.checksum) throw new Error('App schema is newer or a released migration changed');
    const pending = sorted.slice(applied.length);
    if (existing && pending.length) db.exec("VACUUM INTO '" + join(paths.backups, 'before-migration-' + Date.now() + '-' + randomUUID() + '.sqlite').replaceAll("'", "''") + "'");
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS _akatz_objects (key TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, created_at TEXT NOT NULL)');
      for (const migration of pending) {
        db.exec(migration.sql);
        const result=migration.up?.(db);if(result&&typeof result.then==='function')throw new Error('Migrations must be synchronous');
        db.prepare('INSERT INTO _akatz_migrations VALUES (?,?,?)').run(migration.version, migrationDigest(migration), now());
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { db?.close(); release(); throw error; }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); if (result && typeof result.then === 'function') throw new Error('Database transactions must be synchronous'); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const object = key => {
    const row = db.prepare('SELECT * FROM _akatz_objects WHERE key=?').get(key);
    if (!row) throw Object.assign(new Error('Object not found'), { code: 'OBJECT_NOT_FOUND' });
    return { key: row.key, hash: row.hash, size: row.size, mime: row.mime, createdAt: row.created_at, path: join(paths.objects, row.hash) };
  };
  let writes = 0;
  return {
    db, paths, identity, transaction, object,
    objects() { return db.prepare('SELECT key FROM _akatz_objects ORDER BY key').all().map(row => object(row.key)); },
    async putObject(key, source, { mime = 'application/octet-stream', expectedHash, createdAt = now(), maxBytes = 4 * 1024 ** 3, allowEmpty = false } = {}) {
      if (closed) throw new Error('App database is closed');
      if (typeof key !== 'string' || !key || key.length > 1024 || /[\x00-\x1f]/.test(key) || (expectedHash && !HASH.test(expectedHash))) throw new Error('Invalid object identity');
      if (typeof mime !== 'string' || !mime || mime.length > 160 || !Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid object metadata');
      const staging = join(paths.staging, randomUUID()); const file = await open(staging, 'wx', 0o600);
      writes++; const hash = createHash('sha256'); let size = 0;
      try {
        const input = typeof source === 'string' ? createReadStream(source) : source instanceof Uint8Array ? [source] : source;
        for await (const chunk of input) { size += chunk.length; if (size > maxBytes) throw new Error('Object exceeds its byte limit'); hash.update(chunk); await file.writeFile(chunk); }
        if (!size && !allowEmpty) throw new Error('Empty object');
        const value = hash.digest('hex');
        if (expectedHash && value !== expectedHash) throw new Error('Object integrity verification failed');
        const prior = db.prepare('SELECT * FROM _akatz_objects WHERE key=?').get(key);
        if (prior && (prior.hash !== value || prior.mime !== mime)) throw new Error('Object key already contains different content');
        await file.sync(); await file.close();
        await rename(staging, join(paths.objects, value));
        await syncDirectory(paths.objects);
        // Another asynchronous import may have committed while this one flushed.
        transaction(() => {
          const current = db.prepare('SELECT hash,mime FROM _akatz_objects WHERE key=?').get(key);
          if (current && (current.hash !== value || current.mime !== mime)) throw new Error('Object key already contains different content');
          db.prepare('INSERT OR IGNORE INTO _akatz_objects VALUES (?,?,?,?,?)').run(key, value, size, mime, createdAt);
        });
        return object(key);
      } finally { await file.close().catch(() => {}); await rm(staging, { force: true }); writes--; }
    },
    async readObject(key) {
      const record = object(key), body = await readFile(record.path);
      if (body.length !== record.size || digest(body) !== record.hash) throw new Error('Stored object failed integrity verification');
      return body;
    },
    async materializeObject(key, name) {
      if(typeof name!=='string'||isAbsolute(name)||name.includes('\\')||name.split('/').some(part=>!part||part==='..')||name.split('/').length<2||['objects','staging','backups','cache'].includes(name.split('/')[0]))throw new Error('Choose an app file path outside managed storage internals');
      const record=object(key),destination=resolve(paths.root,name);
      if(relative(paths.root,destination).startsWith('..'))throw new Error('App file path escapes its data root');
      await mkdir(dirname(destination),{recursive:true,mode:0o700});
      const realRoot=await realpath(paths.root),realParent=await realpath(dirname(destination));
      const parentRelative=relative(realRoot,realParent);
      if(parentRelative==='..'||parentRelative.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(parentRelative))throw new Error('App file parent escapes its data root');
      const sourceStat=await stat(record.path),prior=await stat(destination).catch(()=>null);
      if(prior&&prior.ino===sourceStat.ino&&prior.dev===sourceStat.dev)return destination;
      const staging=join(dirname(destination),'.'+randomUUID()+'.link');
      try{
        try{await link(record.path,staging);}catch(error){if(!['EXDEV','EPERM','ENOTSUP','EACCES'].includes(error.code))throw error;await copyFile(record.path,staging);const copy=await open(staging,'r+');try{await copy.sync();}finally{await copy.close();}}
        await rename(staging,destination);await syncDirectory(dirname(destination));return destination;
      }finally{await rm(staging,{force:true});}
    },
    async verifyObjects() {
      const rows = db.prepare('SELECT key FROM _akatz_objects ORDER BY key').all();
      for (const row of rows) { const record = object(row.key), actual = await hashFile(record.path); if (actual.hash !== record.hash || actual.size !== record.size) throw new Error('Stored object failed integrity verification: ' + row.key); }
      return { objects: rows.length };
    },
    async backup(destination) { await mkdir(dirname(resolve(destination)), { recursive: true, mode: 0o700 }); await backup(db, destination); return destination; },
    close() { if (closed) return; if (writes) throw new Error('Wait for object writes before closing app storage'); closed = true; db.close(); release(); },
  };
}
