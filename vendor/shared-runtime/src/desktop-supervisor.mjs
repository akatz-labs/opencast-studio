import {isMain} from './entrypoint.mjs';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readDesktopLaunch, desktopIdentity, localDesktopUrl, DESKTOP_HEALTH_PATH } from './desktop-runtime.mjs';
import {captureProcessIdentity} from '../dist/process-identity.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

async function main(directory) {
  const app = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
  const launch = await readDesktopLaunch(app.packageRoot);
  if (!launch || launch.digest !== app.launchDigest || launch.appId !== app.appId) throw new Error('The desktop payload changed after Open was requested');
  const origin = localDesktopUrl(app.url);
  const identity = desktopIdentity(app), attemptId = directory.split(/[\\/]/).at(-1);
  const children = [], checks = [];
  let phase = 'starting', failure, routes = [], closing = false;
  async function check(url,verify) {
    try {const response=await fetch(url,{signal:AbortSignal.timeout(1200),redirect:'error'});return response.ok&&(!verify||verify(await response.json()));}
    catch { return false; }
  }
  let logBytes=0;
  function forward(bytes){if(logBytes<65536){const part=Buffer.from(bytes).subarray(0,65536-logBytes);process.stdout.write(part);logBytes+=part.length;if(logBytes===65536)console.log('\nChild diagnostics reached the 64 KiB limit.');}}
  async function close() {
    if (closing) return;
    closing = true;
    for (const child of children) child.kill('SIGTERM');
    const deadline = Date.now() + 8000;
    while (children.some(child => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) await pause(100);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  }
  const server = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const host = new URL('http://' + req.headers.host);
      if (!loopback.has(host.hostname) || (req.headers.origin && req.headers.origin !== origin.origin) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Use this app’s local address' });
      const url = new URL(req.url, origin);
      if (url.pathname === '/__akatz/stop' && req.method === 'POST') {
        if (req.headers['x-akatz-desktop-identity'] !== identity) return send(403, { error: 'App identity does not match' });
        send(200, { stopping: true }); void close(); return;
      }
      if (url.pathname === DESKTOP_HEALTH_PATH) {
        const healthy = phase === 'ready' && (await Promise.all(checks.map(({url,verify})=>check(url,verify)))).every(Boolean);
        return send(healthy ? 200 : 503, { appId: app.appId, identity, pid: process.pid, attemptId, phase: phase === 'ready' && !healthy ? 'failed' : phase, error: failure || (phase === 'ready' && !healthy ? 'The app UI or API stopped responding. Open the app again to restart it.' : undefined) });
      }
      if (phase !== 'ready') return send(503, { error: failure || 'The app is starting' });
      const route = routes.find(route => url.pathname === route.prefix || url.pathname.startsWith(route.prefix.endsWith('/') ? route.prefix : route.prefix + '/'));
      if (!route) return send(404, { error: 'Unknown app route' });
      const target = new URL(route.url);
      const requestPath = (route.strip ? url.pathname.slice(route.prefix.length) || '/' : url.pathname) + url.search;
      const upstream = httpRequest({ hostname: target.hostname, port: target.port, path: requestPath, method: req.method,
        headers: { ...req.headers } }, response => {
        res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) send(502, { error: 'The app service stopped responding' }); else res.destroy(); });
      req.on('aborted', () => upstream.destroy());
      req.pipe(upstream);
    } catch { if (!res.headersSent) send(500, { error: 'The app could not complete this request' }); else res.destroy(); }
  });
  // Binding first makes the address the cross-process startup lock.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(origin.port), origin.hostname === '[::1]' ? '::1' : '127.0.0.1', resolve); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void close());
  const supervisor = {
    async startProcess({name,executable,args,cwd=app.packageRoot,env={},healthPath,verifyHealth,readyPrefix='AKATZ_APP_READY '}) {
      if(!isAbsolute(executable)||!Array.isArray(args)||args.some(a=>typeof a!=='string')||typeof readyPrefix!=='string'||!readyPrefix||readyPrefix.length>64)throw Error('Declare a bounded owned child startup');
      const parent=captureProcessIdentity(process.pid);
      const child=spawn(executable,args,{cwd,env:{...process.env,...env,AKATZ_APP_PARENT:JSON.stringify(parent)},stdio:['ignore','pipe','pipe'],windowsHide:true});children.push(child);
      child.stderr.on('data',forward);
      const url=await new Promise((done,fail)=>{
        let buffer='',settled=false;const timer=setTimeout(()=>finish(Error(name+' did not report its listening address')),30000);
        function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);if(error)fail(error);else done(value);}
        child.once('error',error=>finish(error));child.once('exit',code=>finish(Error(name+' exited during startup ('+code+')')));
        child.stdout.on('data',bytes=>{
          forward(bytes);if(settled)return;buffer+=String(bytes);if(buffer.length>65536)return finish(Error(name+' startup message exceeded its bound'));
          let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.startsWith(readyPrefix))continue;
            try{const ready=JSON.parse(line.slice(readyPrefix.length));finish(null,localDesktopUrl(ready.url).href);}catch{finish(Error(name+' reported an invalid local address'));}
          }
        });
      });
      const healthUrl=new URL(healthPath,url).href,deadline=Date.now()+30000;
      while(!await check(healthUrl,verifyHealth)){if(Date.now()>deadline||child.exitCode!==null)throw Error(name+' did not become healthy');await pause(200);}
      checks.push({url:healthUrl,verify:verifyHealth});
      child.once('exit',()=>{if(!closing&&phase==='ready'){failure=name+' stopped. Open the app again to restart it.';phase='failed';void close();}});
      return url;
    },
    async startNode({ name, args, cwd = app.packageRoot, env = {}, healthPath,verifyHealth }) {
      // Each service gets an OS-selected port and reports it through IPC.
      const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./desktop-child.mjs', import.meta.url)), ...args], {
        cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      });
      children.push(child);
      child.stdout.on('data',forward);
      child.stderr.on('data',forward);
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(name + ' did not report its listening address')), 30000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(name + ' exited during startup (' + code + ')')); });
        child.on('message', value => {
          if (value?.type === 'akatz-listening' && typeof value.url === 'string') { clearTimeout(timer); resolve(value.url); }
        });
      });
      const healthUrl = new URL(healthPath, url).href;
      const deadline = Date.now() + 30000;
      while (!await check(healthUrl,verifyHealth)) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(name + ' did not become healthy');
        await pause(200);
      }
      checks.push({url:healthUrl,verify:verifyHealth});
      child.once('exit', () => {
        if (!closing && phase === 'ready') { failure = name + ' stopped. Open the app again to restart it.'; phase = 'failed'; void close(); }
      });
      return url;
    },
  };
  try {
    const module = await import(pathToFileURL(launch.modulePath).href);
    routes = await module.start({ supervisor, settings: app.launchSettings || {}, appRoot: app.packageRoot });
    if (!Array.isArray(routes) || !routes.some(route => route.prefix === '/')) throw new Error('The app startup entrypoint did not provide a UI route');
    phase = 'ready';
    console.log(app.appId + ' ready at ' + app.url);
  } catch (error) {
    failure = error.message; phase = 'failed';
    await writeFile(join(directory, 'failure.json'), JSON.stringify({ message: failure }), { mode: 0o600 });
    console.error(failure);
    setTimeout(() => void close(), 3000).unref();
  }
}

if (isMain(import.meta.url)) {
  const directory = resolve(process.argv[2]);
  main(directory).catch(async error => {
    await writeFile(join(directory, 'failure.json'), JSON.stringify({ message: error.code === 'EADDRINUSE' ? 'The app address is already in use by another process.' : error.message }), { mode: 0o600 });
    console.error(error.message); process.exit(1);
  });
}
