import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname, delimiter, relative } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { readAppManifest, verifyFile, digest } from './manifest.mjs';
import { inspectInstallation, appDataRoot } from './index.mjs';
const MAX_LOG = 2_000_000;
const ownMarker = '.akatz-component.json';
const pythonIn = path => process.platform === 'win32' ? join(path, 'Scripts', 'python.exe') : join(path, 'bin', 'python');
function findExecutable(value) {
  if (!value) return null;
  if (value.includes('/') || value.includes('\\')) return existsSync(value) ? resolve(value) : null;
  for (const path of (process.env.PATH ?? '').split(delimiter)) for (const suffix of process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']) { const candidate = join(path, value + suffix); if (existsSync(candidate) && statSync(candidate).isFile()) return candidate; }
  return null;
}
export class AppRuntime {
  constructor(descriptorPath, config = {}, { defaults = {}, commands = {}, comfygitTargets = {} } = {}) {
    this.manifest = readAppManifest(descriptorPath);
    if (config.appId && config.appId !== this.manifest.descriptor.id) throw new Error('Configuration belongs to another application');
    this.config = config; this.defaults = defaults; this.commands = { uv: 'uv', git: 'git', cg: 'cg', ...commands };
    this.comfygitTargets = comfygitTargets;
    this.runtimeRoot = resolve(config.runtimeRoot ?? join(appDataRoot(), 'runtimes'), this.manifest.descriptor.id);
    this.children = new Set(); this.closed = false;
  }
  component(id) { const c = this.manifest.descriptor.components[id]; if (!c) throw new Error(`Unknown runtime component: ${id}`); return c; }
  location(id) {
    const component = this.component(id), identity = digest(JSON.stringify(component)), managed = join(this.runtimeRoot, id, identity.slice(0, 20));
    const supplied = { ...this.defaults[id], ...this.config.components?.[id] };
    const receiptPath = join(managed, ownMarker);
    let receipt = null;
    if (existsSync(receiptPath)) { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); if (receipt.appId !== this.manifest.descriptor.id || receipt.componentId !== id || receipt.identity !== identity) throw new Error('Runtime ownership receipt mismatch'); }
    const installed = receipt?.state === 'ready';
    const executable = this.config.components?.[id]?.executable ?? (installed ? pythonIn(join(managed, 'venv')) : supplied.executable) ?? (component.kind === 'native' ? (component.bundled ? verifyFile(this.manifest.root, component.bundled) : component.executable) : null);
    return { id, component, identity, managed, receiptPath, receipt, executable: findExecutable(executable), sourceRoot: this.config.components?.[id]?.sourceRoot ?? (installed && component.source ? join(managed, 'source') : supplied.sourceRoot ?? null), workRoot: supplied.workRoot ?? join(this.runtimeRoot, 'work', id), modelCache: supplied.modelCache ?? this.config.modelCache ?? process.env.HF_HUB_CACHE ?? join(process.env.HF_HOME ?? join(homedir(), '.cache', 'huggingface'), 'hub'), ownership: this.config.components?.[id]?.executable ? 'external' : installed ? 'managed' : 'external' };
  }
  executeFile(command, args, { cwd = this.manifest.root, env = {}, timeout = 120000, signal, onOutput, onStart } = {}) {
    if (this.closed) return Promise.reject(new Error('Application runtime is closed'));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    return new Promise((resolveJob, reject) => {
      let output = '', timedOut = false, cancelled = false, killTimer;
      const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: false, stdio: ['ignore','pipe','pipe'] });
      this.children.add(child);
      const stop = () => { cancelled = true; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 3000); killTimer.unref(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeout); timer.unref();
      signal?.addEventListener('abort', stop, { once: true });
      const record = bytes => { const text = bytes.toString(); output = (output + text).slice(-MAX_LOG); onOutput?.(text); };
      child.stdout.on('data', record); child.stderr.on('data', record);
      let startError;
      child.on('error', error => { startError = error; });
      child.on('close', (code, sig) => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); this.children.delete(child); if (code === 0 && !timedOut && !cancelled) resolveJob({ code, output }); else reject(Object.assign(new Error(timedOut ? 'Runtime command timed out' : cancelled ? 'Runtime command cancelled' : startError?.message ?? `Runtime command exited with ${code ?? sig}`), { output, code, cancelled: cancelled || sig === 'SIGTERM' || sig === 'SIGKILL', timedOut })); });
      onStart?.(child);
    });
  }
  snapshots(id) {
    const c = this.component(id); return c.modelSnapshots ? JSON.parse(readFileSync(verifyFile(this.manifest.root, c.modelSnapshots), 'utf8')) : [];
  }
  async inspect(id) {
    const c = this.component(id), base = { id, label: c.label ?? id, kind: c.kind, status: 'ready', reasons: [] };
    const unavailable = (status, reason) => ({ ...base, status, reasons: [reason] });
    if (!c.platforms.includes(`${process.platform}-${process.arch}`)) return unavailable('unsupported', `No validated component build for ${process.platform}-${process.arch}`);
    for (const dep of c.dependsOn ?? []) if ((await this.inspect(dep)).status !== 'ready') return unavailable('blocked', `Dependency ${dep} is unavailable`);
    if (c.kind === 'comfygit') {
      try {
        const target = this.comfygitTargets[id] ?? this.config;
        const installation = target.workspace ? await inspectInstallation(target, { command: this.commands.cg }) : null;
        if (installation && !installation.installed) return unavailable('missing','Selected ComfyGit environment is not installed');
        if (!target.serveUrl) return unavailable('missing','Select a ComfyGit contract service URL');
        const response = await fetch(target.serveUrl + '/health?check_proxy=true', { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return unavailable('missing','ComfyGit contract service is unavailable');
        const health = await response.json();
        if (!health.ok || !target.environment || health.environment !== target.environment) return unavailable('incompatible','ComfyGit service environment does not match this application selection');
        if (!health.comfyui?.available || health.proxy?.available === false) return unavailable('missing','ComfyUI execution service is offline');
        return { ...base, installation, serviceEnvironment: health.environment };
      }
      catch (error) { return unavailable('missing', error.message); }
    }
    try {
      const location = this.location(id);
      if (!location.executable) return unavailable('missing', `${c.label ?? id} is not installed or selected`);
      const version = await this.executeFile(location.executable, c.versionArgs ?? ['--version'], { timeout: 15000 });
      const expected = c.kind === 'python' ? `Python ${c.python}.` : c.versionPrefix;
      if (!version.output.trim().startsWith(expected)) return unavailable('incompatible', `Expected ${expected}; got ${version.output.trim().split('\n')[0]}`);
      if (c.kind === 'python') {
        await this.executeFile(location.executable, ['-c', `import importlib; [importlib.import_module(n) for n in ${JSON.stringify(c.imports)}]`], { timeout: 30000, env: c.environment });
        const requirements = readFileSync(verifyFile(this.manifest.root, c.requirements), 'utf8').split('\n').filter(line => /^[\w.-]+==/.test(line) || line.includes('.whl#sha256=')).map(line => line.includes('==') ? line.trim().split('==') : [line.split(' @ ')[0], decodeURIComponent(new URL(line.split(' @ ')[1]).pathname).split('/').pop().split('-')[1]]);
        await this.executeFile(location.executable, ['-c', `import importlib.metadata as m; expected=${JSON.stringify(requirements)}; errors=[n+' expected '+v+', installed '+m.version(n) for n,v in expected if m.version(n)!=v]; assert not errors, '; '.join(errors)`], { timeout: 15000 });
        if (c.source) {
          if (!location.sourceRoot) return unavailable('missing', 'Pinned source checkout is not selected');
          const revision = await this.executeFile(this.commands.git, ['-C',location.sourceRoot,'rev-parse','HEAD'], { timeout: 10000 });
          if (revision.output.trim() !== c.source.revision) return unavailable('incompatible', 'Source revision differs from the pinned application recipe');
        }
      }
      for (const model of this.snapshots(id)) for (const file of model.required_files) {
        const path = join(location.modelCache, 'models--'+model.repo_id.replaceAll('/','--'), 'snapshots', model.revision, file);
        if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) return unavailable('missing', `Missing pinned model file: ${model.repo_id}/${file}`);
      }
      return { ...base, executable: location.executable, ownership: location.ownership, version: version.output.trim().split('\n')[0] };
    } catch (error) { return unavailable('broken', error.message + (error.output ? `: ${error.output.slice(-500)}` : '')); }
  }
  async plan() {
    const components = [];
    for (const id of this.manifest.order) components.push(await this.inspect(id));
    const features = Object.entries(this.manifest.descriptor.features).map(([id,f]) => ({ id, label: f.label ?? id, available: f.requires.every(id => components.find(c => c.id === id)?.status === 'ready'), requires: f.requires }));
    return { appId: this.manifest.descriptor.id, descriptorSha256: this.manifest.sha256, platform: `${process.platform}-${process.arch}`, runtimeRoot: this.runtimeRoot, components, features };
  }
  async run(id, entrypoint, args = [], options = {}) {
    const ready = await this.inspect(id);
    if (ready.status !== 'ready') throw Object.assign(new Error(`${ready.label}: ${ready.reasons.join('; ')}`), { status: 503 });
    const loc = this.location(id), c = loc.component;
    if (c.kind === 'comfygit') throw new Error('Execute ComfyGit workflows through its contract API');
    const ref = c.entrypoints?.[entrypoint];
    if (!ref && !(c.kind === 'native' && entrypoint === 'exec')) throw new Error(`Unknown component entrypoint: ${entrypoint}`);
    await mkdir(loc.workRoot, { recursive: true, mode: 0o700 });
    const fixed = ref ? (c.kind === 'python' ? [verifyFile(this.manifest.root, ref)] : ['--background','--python',verifyFile(this.manifest.root, ref),'--']) : [];
    return this.executeFile(loc.executable, [...fixed, ...args], { cwd: loc.workRoot, ...options, env: { ...c.environment, HF_HUB_CACHE: loc.modelCache, ...options.env } });
  }
  async install(id, { onOutput, signal } = {}) {
    const loc = this.location(id), c = loc.component;
    if (!c.platforms.includes(`${process.platform}-${process.arch}`)) throw new Error('Unsupported component platform');
    if (c.kind !== 'python') throw new Error(c.kind === 'comfygit' ? 'Use cg materialize with the referenced recipe' : 'Select a compatible native executable or bundle a verified binary');
    if (this.config.components?.[id]?.executable) throw new Error('External Python selection is read-only; remove the override to install a managed component');
    if (loc.receipt?.state === 'ready') return this.inspect(id);
    await mkdir(dirname(loc.managed), { recursive: true, mode: 0o700 });
    if (relative(realpathSync(this.runtimeRoot), realpathSync(dirname(loc.managed))).startsWith('..')) throw new Error('Runtime install destination escapes its root');
    const lock = loc.managed + '.lock'; await mkdir(lock);
    const receipt = { schemaVersion: 1, appId: this.manifest.descriptor.id, componentId: id, identity: loc.identity, state: 'installing' };
    let owned = false;
    try {
      if (existsSync(loc.managed)) throw new Error('Incomplete or unowned install exists; preserve it and choose a new runtimeRoot');
      await mkdir(loc.managed); owned = true; await writeFile(loc.receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      const run = (command,args) => this.executeFile(command,args,{timeout:1800000,onOutput,signal});
      await run(this.commands.uv,['venv','--python',c.python,join(loc.managed,'venv')]);
      const python = pythonIn(join(loc.managed,'venv'));
      const sync = ['pip','sync','--python',python,verifyFile(this.manifest.root,c.requirements)]; if(c.extraIndexUrl)sync.push('--extra-index-url',c.extraIndexUrl);
      await run(this.commands.uv,sync);
      if(c.source){ const source=join(loc.managed,'source'); await run(this.commands.git,['clone','--no-checkout',c.source.url,source]); await run(this.commands.git,['-C',source,'checkout','--detach',c.source.revision]); await run(this.commands.git,['-C',source,'submodule','update','--init','--recursive']); await run(this.commands.uv,['pip','install','--python',python,'--no-deps',source]); }
      await run(python,['-c',`import importlib; [importlib.import_module(n) for n in ${JSON.stringify(c.imports)}]`]);
      const freeze=await run(this.commands.uv,['pip','freeze','--python',python]); await writeFile(join(loc.managed,'installed.txt'),freeze.output);
      await writeFile(loc.receiptPath,JSON.stringify({...receipt,state:'ready',installedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
      return this.inspect(id);
    } catch(error){ if(owned)await rm(loc.managed,{recursive:true,force:true}); throw error; }
    finally { await rm(lock,{recursive:true,force:true}); }
  }
  async acquireModels(id, options = {}) {
    const loc=this.location(id); if(!loc.executable)throw new Error('Install or select the Python component first');
    const hf=join(dirname(loc.executable),process.platform==='win32'?'hf.exe':'hf');
    for(const model of this.snapshots(id))await this.executeFile(hf,['download',model.repo_id,'--revision',model.revision,'--cache-dir',loc.modelCache,'--include',...model.required_files],{timeout:3600000,...options});
    return this.inspect(id);
  }
  async close() { this.closed=true; const children=[...this.children]; for(const child of children)child.kill('SIGTERM'); await Promise.all(children.map(child=>new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('close',()=>{clearTimeout(timer);resolve();});}))); }
}
