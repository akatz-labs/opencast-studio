import { readFile, mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { verifyFile, digest } from './manifest.mjs';
import { desktopRegistryRoot, listDesktopApps } from './desktop-apps.mjs';

export const DESKTOP_HEALTH_PATH = '/__akatz/health';
export const desktopRunRoot = () => join(desktopRegistryRoot(), 'runs');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function localDesktopUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Managed apps need an HTTP loopback address with a port, such as http://127.0.0.1:8890/');
  return url;
}

export async function readDesktopLaunch(root, { verify = true } = {}) {
  let bytes;
  try { bytes = await readFile(join(root, 'desktop', 'launch.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const launch = JSON.parse(bytes);
  if (launch.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9-]*$/.test(launch.appId) || !Number.isInteger(launch.defaultPort) || launch.defaultPort < 1024 || launch.defaultPort > 65535 || !Array.isArray(launch.files))
    throw new Error('Invalid desktop launch package');
  const modulePath = verifyFile(root, launch.module);
  if (verify) for (const file of launch.files) verifyFile(root, file);
  return { ...launch, modulePath, digest: digest(bytes) };
}

export async function buildDesktopLaunch({ root, appId, defaultPort, files }) {
  const refs = [];
  async function collect(name) {
    const entries = await readdir(join(root, name), { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (entries) {
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw new Error('Desktop payloads cannot contain symlinks');
        await collect(join(name, entry.name));
      }
    } else {
      refs.push({ path: name.replaceAll('\\', '/'), sha256: digest(await readFile(join(root, name))) });
    }
  }
  for (const name of files) await collect(name);
  const module = { path: 'desktop/start.mjs', sha256: digest(await readFile(join(root, 'desktop/start.mjs'))) };
  const launch = { schemaVersion: 1, appId, defaultPort, module, files: refs };
  await writeFile(join(root, 'desktop/launch.json'), JSON.stringify(launch, null, 2) + '\n');
  return launch;
}

export function desktopIdentity(app) {
  return digest(JSON.stringify([app.appId, resolve(app.packageRoot), app.launchDigest, app.launchSettings || {}]));
}

export async function desktopHealth(app) {
  try {
    const response = await fetch(new URL(DESKTOP_HEALTH_PATH, app.url), { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const value = await response.json();
    return value.appId === app.appId && value.identity === desktopIdentity(app) ? value : { phase: 'conflict' };
  } catch { return null; }
}

// Only stop a supervisor whose identity matches the reviewed local registration.
export async function stopDesktopApp(app) {
  const health = await desktopHealth(app);
  if (!health || health.phase === 'conflict') return false;
  await fetch(new URL('/__akatz/stop', app.url), { method: 'POST', headers: { 'x-akatz-desktop-identity': desktopIdentity(app) }, signal: AbortSignal.timeout(3000) });
  for (let i = 0; i < 100; i++) {
    if (!await desktopHealth(app)) return true;
    await pause(100);
  }
  throw new Error('The previous app process is still shutting down. Try again shortly.');
}

export async function readDesktopLog(appId, attemptId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(appId) || !/^[a-f0-9-]{36}$/.test(attemptId)) throw new Error('Invalid startup log');
  const file = await open(join(desktopRunRoot(), appId, attemptId, 'startup.log'), 'r');
  try {
    const info = await file.stat();
    const size = Math.min(info.size, 32000), buffer = Buffer.alloc(size);
    await file.read(buffer, 0, size, Math.max(0, info.size - size));
    return buffer.toString();
  } finally { await file.close(); }
}

export async function startDesktopApp(appId, { timeoutMs = 90000 } = {}) {
  const app = (await listDesktopApps()).find(item => item.appId === appId);
  if (!app?.available) throw new Error(app?.problem || 'The app folder is unavailable');
  if (!app.launchDigest) {
    try {
      const response = await fetch(app.url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (response.ok) return { url: app.url, reused: true };
    } catch {}
    throw new Error('This app is not running. Review its app registration to enable managed startup, or start it independently.');
  }
  localDesktopUrl(app.url);
  const launch = await readDesktopLaunch(app.packageRoot);
  if (!launch || launch.appId !== appId || launch.digest !== app.launchDigest)
    throw new Error('The app startup package changed. Review its registration before opening it.');
  let health = await desktopHealth(app);
  if (health?.phase === 'ready') return { url: app.url, reused: true };
  if (health?.phase === 'conflict') throw new Error('Another application is using this address. Choose a different app port.');
  if (health?.phase === 'failed') {
    await fetch(new URL('/__akatz/stop', app.url), { method: 'POST', headers: { 'x-akatz-desktop-identity': desktopIdentity(app) }, signal: AbortSignal.timeout(3000) }).catch(() => {});
    for (let i = 0; i < 40 && await desktopHealth(app); i++) await pause(250);
    health = await desktopHealth(app);
    if (health) throw new Error('The previous app process is still shutting down. Try Open again shortly.');
  }
  const attemptId = randomUUID(), directory = join(desktopRunRoot(), appId, attemptId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'request.json'), JSON.stringify(app), { mode: 0o600, flag: 'wx' });
  let childError;
  if (!health) {
    const log = openSync(join(directory, 'startup.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./desktop-supervisor.mjs', import.meta.url)), directory], {
        cwd: app.packageRoot, detached: true, stdio: ['ignore', log, log], windowsHide: true,
      });
      child.on('error', error => { childError = error.message; });
      child.unref();
    } finally { closeSync(log); }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    health = await desktopHealth(app);
    if (health?.phase === 'ready') return { url: app.url, reused: false };
    if (health?.phase === 'failed') throw Object.assign(new Error(health.error || 'App startup failed'), { appId, attemptId: health.attemptId });
    if (health?.phase === 'conflict') throw new Error('Another application is using this address. Choose a different app port.');
    let failure;
    try { failure = JSON.parse(await readFile(join(directory, 'failure.json'), 'utf8')).message; } catch {}
    // A concurrent request may have won the port and is starting the same app.
    if ((failure || childError) && !health) throw Object.assign(new Error(failure || childError), { appId, attemptId });
    await pause(250);
  }
  throw Object.assign(new Error('The app did not become ready in time. Check its startup log and try Open again.'), { appId, attemptId: health?.attemptId || attemptId });
}
