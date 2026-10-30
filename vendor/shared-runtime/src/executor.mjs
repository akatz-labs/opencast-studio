import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, openSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, copyFile, stat, lstat, rename } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openAppDatabase, hashFile } from './storage.mjs';
import { atomicJson, contained } from './executor-runner.mjs';
import { inspectInstallation, isEnvironmentBusy } from './executor-readiness.mjs';
import { ExecutorMemory } from './executor-memory.mjs';
import { RuntimeSessions, managedDescriptor } from '../dist/runtime-sessions.js';
import { captureProcessIdentity,processAlive } from '../dist/process-identity.js';
import { inspectAccepted } from '../dist/accepted-attempt.js';
import { inspectAbsentComfyRuntime } from '../dist/absent-comfy-runtime.js';

export const EXECUTOR_API_VERSION = 1;
export const EXECUTOR_PORT = 8841;
export const EXECUTOR_PHASES = ['queued','preparing','rendering','finalizing','completed','failed','cancelled','uncertain'];
export function executorCapabilities() {
  return ['cpu-only-install-v1','environment-contention-v1','runtime-paths-win32-v1','comfy-torch-backend-v1','cooperative-cancel-v1','job-recovery-v1','model-resources-v1','model-storage-progress-v1','uninstall-model-v1','idle-memory-v1','directory-usage-v1',
    ...(process.platform==='linux'?['managed-runtime-v1','accepted-attempt-v1','cancel-admission-v1','auto-placement-v1']:[])];
}
const ACTIVE = ['preparing','rendering','finalizing','uncertain'];
const READINESS_WAIT_MS = 5 * 60 * 1000;

function deferReadiness(job, readiness) {
  const timestamp=Date.now(), previous=job.readinessWait?.resolvedAt?undefined:job.readinessWait;
  const attempts=(previous?.attempts || 0)+1;
  const issues=readiness.issues.filter(issue=>issue.features.includes(job.feature));
  const backoff=Math.max(Math.min(10000,1000*2**Math.min(attempts-1,4)),...issues.map(issue=>issue.retryAfterMs || 1000));
  const deadlineAt=previous?.deadlineAt || new Date(timestamp+READINESS_WAIT_MS).toISOString();
  job.phase='queued';
  job.activity='Waiting for ComfyGit environment operation to complete';
  job.readinessWait={firstObservedAt:previous?.firstObservedAt || new Date(timestamp).toISOString(),deadlineAt,
    nextAttemptAt:new Date(Math.min(Date.parse(deadlineAt),timestamp+backoff)).toISOString(),attempts,lastIssues:issues};
}
const now = () => new Date().toISOString();
export const digest = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function requireId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value)) throw new Error('Invalid identifier');
  return value;
}
const migrations = [{ version: 1, sql: `
CREATE TABLE executors(id TEXT PRIMARY KEY, document TEXT NOT NULL);
CREATE TABLE preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE installations(id TEXT PRIMARY KEY, app_id TEXT NOT NULL, document TEXT NOT NULL);
CREATE TABLE plans(id TEXT PRIMARY KEY, digest TEXT NOT NULL, document TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
 phase TEXT NOT NULL, created_at TEXT NOT NULL, document TEXT NOT NULL);
CREATE INDEX jobs_queue ON jobs(phase,created_at);
` }];

export class Executor {
  readinessObservations = new Map();
  constructor({ root, dispatch = true, memoryOptions, preparationInspector=inspectAbsentComfyRuntime, maintenanceGuard=async()=>{if(dispatch)throw new Error('Offline maintenance is required');} } = {}) {
    this.preparationInspector=preparationInspector;
    this.maintenanceGuard=maintenanceGuard;
    this.storage = openAppDatabase({ appId: 'executor', root, migrations });
    this.db = this.storage.db; this.root = this.storage.paths.root;
    this.closed = false; this.ticking = false;
    if (!this.db.prepare('SELECT id FROM executors WHERE id=?').get('local')) {
      this.register({ id:'local', name:'This machine', kind:'local', port:EXECUTOR_PORT });
      this.preference('default', 'local');
    }
    this.memory = new ExecutorMemory(this, memoryOptions);
    this.sessions = new RuntimeSessions(this.identity, this.root, {
      load: () => this.db.prepare("SELECT value FROM preferences WHERE key LIKE 'runtime-session:%' ORDER BY rowid").all().map(row => JSON.parse(row.value)),
      save: session => this.db.prepare('INSERT INTO preferences VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('runtime-session:'+session.id,JSON.stringify(session)),
    });
    if (dispatch) { this.timer = setInterval(() => void this.tick().catch(error => console.error('Executor reconcile:',error.message)), 500); this.timer.unref(); }
  }
  get identity() { return this.storage.identity.instanceId; }
  listExecutors() { return this.db.prepare('SELECT document FROM executors ORDER BY rowid').all().map(row=>JSON.parse(row.document)); }
  register(value) {
    requireId(value.id);
    if (!value.name?.trim() || !['local','ssh'].includes(value.kind)) throw new Error('Executor needs a name and connection');
    if (value.kind === 'local' && value.id !== 'local') throw new Error('Reuse this machine’s local executor');
    if (value.kind === 'ssh' && !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.host || '')) throw new Error('Enter an SSH host alias or user@hostname');
    for (const key of ['port','sshPort']) if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key]<1 || value[key]>65535)) throw new Error('Invalid port');
    const row = {id:value.id,name:value.name.trim(),kind:value.kind,port:value.port || EXECUTOR_PORT,
      ...(value.kind === 'ssh' ? {host:value.host,sshPort:value.sshPort || 22} : {})};
    this.db.prepare('INSERT INTO executors VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(row.id,JSON.stringify(row));
    return row;
  }
  preference(key, value) {
    if (value === null) { if (!key.startsWith('app:')) throw new Error('The global default cannot be cleared'); this.db.prepare('DELETE FROM preferences WHERE key=?').run(key); return null; }
    if (value !== undefined) {
      if (!this.listExecutors().some(item=>item.id===value)) throw new Error('Unknown executor');
      this.db.prepare('INSERT INTO preferences VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
    }
    return this.db.prepare('SELECT value FROM preferences WHERE key=?').get(key)?.value || null;
  }
  selection(appId) { requireId(appId); return { defaultExecutorId:this.preference('default'), selectedExecutorId:this.preference('app:'+appId) || this.preference('default'), selectionSource:this.preference('app:'+appId)?'app':'default' }; }
  installations(appId) { return this.db.prepare('SELECT document FROM installations ORDER BY rowid DESC').all().map(row=>JSON.parse(row.document)).filter(row=>!appId || row.appId===appId); }
  plan(installation) {
    requireId(installation.id); requireId(installation.appId);
    if (!Array.isArray(installation.features) || !installation.features.length || installation.features.some(id=>typeof id!=='string')) throw new Error('Declare installation features');
    if (typeof installation.revision !== 'string' || !installation.revision || typeof installation.adapter !== 'string' || !isAbsolute(installation.adapter)) throw new Error('Pinned adapter revision and absolute path required');
    if (!Array.isArray(installation.probes) || !installation.probes.length) throw new Error('Readiness probes are required');
    if (installation.runtime?.managed !== undefined) {
      if(process.platform!=='linux')throw new Error('Managed GPU sessions are currently qualified only on Linux');
      managedDescriptor(installation.runtime.managed);
    }
    const document = { installation, createdAt:now(), writes:[join(this.root,'state.sqlite'),...(installation.setup?.writes || [])], downloads:installation.setup?.downloads || [],
      description:installation.setup?.description || 'Adopt the selected existing app runtime after checking its adapter, required files and services. Existing runtime and model folders are preserved.' };
    const id=randomUUID(), hash=digest(document);
    this.db.prepare('INSERT INTO plans VALUES (?,?,?)').run(id,hash,JSON.stringify(document));
    return {id,digest:hash,...document};
  }
  async install(planId, hash) {
    const row=this.db.prepare('SELECT * FROM plans WHERE id=?').get(planId);
    if(!row || row.digest!==hash)throw new Error('Installation confirmation does not match the reviewed plan');
    const plan=JSON.parse(row.document), installation=plan.installation;
    const existing=this.installations().find(item=>item.id===installation.id);
    if(existing){const {observations,...definition}=existing;if(canonical(definition)!==canonical(installation))throw new Error('Use a new installation ID for a changed revision');return {installation:existing,readiness:await this.inspectInstallation(existing)};}
    const pending=this.jobs().find(job=>job.kind==='installation' && job.installation.id===installation.id && !['failed','cancelled'].includes(job.phase));
    if(pending){if(canonical(pending.installation)!==canonical(installation))throw new Error('Use a new installation ID for a changed revision');return {job:pending};}
    if(installation.setup || installation.probes.some(probe=>probe.modelHash)) {
      const sourceKey=canonical(['installation',planId]),prior=this.db.prepare('SELECT document FROM jobs WHERE source_key=?').get(sourceKey);
      if(prior)return {job:JSON.parse(prior.document)};
      const job={id:randomUUID(),kind:'installation',appId:installation.appId,executorId:this.identity,phase:'queued',createdAt:now(),updatedAt:now(),installation,files:[],inputs:{}};
      this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(job.id,sourceKey,hash,job.phase,job.createdAt,JSON.stringify(job));
      this.memory.activity();
      return {job};
    }
    const readiness=await this.inspectInstallation(installation);
    if(!readiness.ready)throw new Error(readiness.problems.join('; '));
    this.db.prepare('INSERT OR IGNORE INTO installations VALUES (?,?,?)').run(installation.id,installation.appId,JSON.stringify(installation));
    return {installation,readiness};
  }
  reviewedInstallation(planId, hash) {
    const row=this.db.prepare('SELECT * FROM plans WHERE id=?').get(planId);
    if(!row || row.digest!==hash)throw new Error('Installation confirmation does not match the reviewed plan');
    return JSON.parse(row.document).installation;
  }
  async verifyModels(appId) {
    const results=[];
    for(const installation of this.installations(appId)) {
      const readiness=await inspectInstallation(installation,{verifyModels:true});
      this.db.prepare('UPDATE installations SET document=? WHERE id=? AND app_id=?').run(JSON.stringify({...installation,observations:readiness.observations}),installation.id,appId);
      results.push({installation,...readiness});
    }
    return results;
  }
  inspectInstallation(installation,options) { return inspectInstallation(installation,options); }
  async readiness(appId) {
    // UI polling must not launch overlapping CUDA/native probes. This short
    // inventory cache does not apply to admission or dispatch safety checks.
    // Historical registrations often point at the same live catalog. Share
    // only this inventory batch's fresh GETs; admission/dispatch stay uncached.
    const httpSnapshots=new Map();
    const installed=await Promise.all(this.installations(appId).map(async installation=>{
      const key=canonical(installation), prior=this.readinessObservations.get(installation.id);
      let entry=prior;
      if(!entry || entry.key!==key || entry.expiresAt<Date.now()) {
        entry={key,expiresAt:Infinity,promise:null};
        entry.promise=this.inspectInstallation(installation,{httpSnapshots}).then(result=>{entry.expiresAt=Date.now()+10000;return result;},error=>{this.readinessObservations.delete(installation.id);throw error;});
        this.readinessObservations.set(installation.id,entry);
      }
      return {installation,...await entry.promise};
    }));
    for(const job of this.jobs().filter(job=>job.kind==='installation'&&(!appId||job.appId===appId)&&job.phase!=='completed')) {
      if(!installed.some(item=>item.installation.id===job.installation.id))installed.push({installation:job.installation,ready:false,features:[],problems:[job.error || job.activity || 'Installation '+job.phase],checkedAt:now(),setupJobId:job.id});
    }
    return installed;
  }
  managedRuntimeUrls() {
    return new Set(this.installations().filter(item => item.runtime?.managed).flatMap(item => item.runtime.comfyUrls || []));
  }
  async prepareGpu({allowStoppedRuntimes=false,requiredRuntimes=null,inspectOnly=false,skipFreeUrls=new Set()}={}) {
    const urls=[...new Set(this.installations().flatMap(item=>item.runtime?.comfyUrls || []))];
    const online=[];
    for(const origin of urls) {
      const url=new URL(origin);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Managed GPU runtimes must use worker loopback');
      let response;
      try{response=await fetch(origin+'/queue',{signal:AbortSignal.timeout(4000)});}catch(error){
        // Setup must be able to restore a stopped runtime. Only a refused
        // loopback connection proves there is no listener; timeouts and other
        // failures remain blocking. Generation requires its own runtime, not
        // stopped services belonging to unrelated applications.
        if(error.cause?.code==='ECONNREFUSED'&&(allowStoppedRuntimes||
          (requiredRuntimes!==null&&!requiredRuntimes.includes(origin))))continue;
        return false;
      }
      // A superseded installation may name a port since reused by a non-ComfyUI
      // helper. It has no queue to drain; never apply this exception to a runtime
      // required by the job, or to an unknown/temporary HTTP failure.
      if(response.status===404 && requiredRuntimes!==null && !requiredRuntimes.includes(origin))continue;
      if(!response.ok)throw new Error('Unable to inspect an adopted runtime queue');
      const queue=await response.json();
      if(!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending))throw new Error('Unsupported runtime queue response');
      if(queue.queue_running.length || queue.queue_pending.length)return false;
      online.push(origin);
    }
    for(const origin of inspectOnly ? [] : online) {
      if(skipFreeUrls.has(origin))continue;
      const response=await fetch(origin+'/free',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({unload_models:true,free_memory:true}),signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error('Unable to release an idle adopted runtime');
    }
    return true;
  }
  getJob(id) { const row=this.db.prepare('SELECT document FROM jobs WHERE id=?').get(id);return row ? JSON.parse(row.document) : null; }
  jobs() { return this.db.prepare('SELECT document FROM jobs ORDER BY created_at,rowid').all().map(row=>JSON.parse(row.document)); }
  pendingJobs() { return this.db.prepare("SELECT document FROM jobs WHERE phase NOT IN ('completed','failed','cancelled') ORDER BY created_at,rowid").all().map(row=>JSON.parse(row.document)); }
  save(job) { job.updatedAt=now();this.db.prepare('UPDATE jobs SET phase=?,document=? WHERE id=?').run(job.phase,JSON.stringify(job),job.id);return job; }
  async submit(input,{cancel=false}={}) {
    for(const key of Object.keys(input))if(!['appId','instanceId','sourceJobId','installationId','feature','inputs','files','executorId'].includes(key))throw new Error('Unknown job field: '+key);
    if(input.executorId && input.executorId!==this.identity)throw Object.assign(new Error('Executor identity changed'),{status:409});
    for(const key of ['appId','instanceId','sourceJobId','installationId'])requireId(input[key]);
    const sourceKey=canonical([input.appId,input.instanceId,input.sourceJobId]),hash=digest(input);
    const existing=this.db.prepare('SELECT * FROM jobs WHERE source_key=?').get(sourceKey);
    if(existing){if(existing.digest!==hash)throw Object.assign(new Error('Job identity already has different inputs'),{status:409});const prior=JSON.parse(existing.document);return cancel&&!['finalizing','completed','failed','cancelled'].includes(prior.phase)?this.cancel(prior.id):prior;}
    const installation=this.installations(input.appId).find(row=>row.id===input.installationId);
    if(!installation || !installation.features.includes(input.feature))throw new Error('Install this app feature on the executor first');
    const readiness=await this.inspectInstallation(installation);
    if(!readiness.features.includes(input.feature) && !isEnvironmentBusy(readiness,input.feature))throw new Error(readiness.problems.join('; '));
    for(const file of input.files || []) {
      requireId(file.name);if(!/^[a-f0-9]{64}$/.test(file.hash))throw new Error('Input hash required');
      const object=this.storage.object('input:'+file.hash);if(!object || object.size!==file.size)throw new Error('Upload complete input bytes before submitting');
    }
    // No asynchronous gap in the final identity check and insert.
    const raced=this.db.prepare('SELECT * FROM jobs WHERE source_key=?').get(sourceKey);
    if(raced){if(raced.digest!==hash)throw Object.assign(new Error('Job identity conflict'),{status:409});const prior=JSON.parse(raced.document);return cancel&&!['finalizing','completed','failed','cancelled'].includes(prior.phase)?this.cancel(prior.id):prior;}
    const job={...input,id:randomUUID(),executorId:this.identity,phase:cancel?'cancelled':'queued',createdAt:now(),updatedAt:now(),installation,admissionFields:Object.keys(input)};
    if(!cancel&&!readiness.features.includes(input.feature))deferReadiness(job,readiness);
    this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(job.id,sourceKey,hash,job.phase,job.createdAt,JSON.stringify(job));
    if(cancel)return job;
    this.memory.activity();
    // A durable shared admission protects owned cache timers. Driver admission
    // can lose an idle race; the accepted job still keeps this worker binding.
    try{await this.sessions.protectPending(this.pendingJobs().map(j=>j.id));}
    catch(error){job.activity='Accepted; runtime observation pending: '+error.message;this.save(job);}
    return job;
  }
  cancel(id) { const job=this.getJob(id);if(!job)throw new Error('Job not found');if(job.phase==='cancelled')return job;
    if(['preparing','rendering'].includes(job.phase)&&job.installation.capabilities?.includes('cooperative-cancel-v1')) {
      // A request is not terminal evidence. Keep the GPU slot until the adapter
      // observes backend termination and writes its terminal receipt.
      const marker=join(this.root,'jobs',job.id,'cancel-requested');
      mkdirSync(join(this.root,'jobs',job.id),{recursive:true,mode:0o700});
      try{writeFileSync(marker,'requested\n',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
      job.cancelRequestedAt ||= now();return this.save(job);
    }
    if(job.phase!=='queued')throw Object.assign(new Error('This job has started. Cancellation needs terminal runtime evidence.'),{status:409});job.phase='cancelled';return this.save(job); }
  async cancelAdmission(input) {return this.submit(input,{cancel:true});}
  async runnerAlive(job,directory) {
    const owner=await readFile(join(directory,'runner-owner.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(owner){
      const bytes=await readFile(join(directory,'request.json'));
      if(owner.jobId!==job.id||owner.requestDigest!==digest(bytes))throw new Error('Runner ownership identity changed');
      if(processAlive(owner.identity)){
        if(job.pid!==owner.identity.pid||canonical(job.runnerIdentity)!==canonical(owner.identity)){job.pid=owner.identity.pid;job.runnerIdentity=owner.identity;this.save(job);}
        return true;
      }
      return false;
    }
    if(job.runnerIdentity)return processAlive(job.runnerIdentity);
    if(!job.pid)return false;
    try{process.kill(job.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}
  }
  async spawnRunner(job,directory,proof=null) {
    if(proof){
      await mkdir(join(directory,'observation-history'),{recursive:true,mode:0o700});
      const receipt=join(directory,'receipt.json');
      try{await rename(receipt,join(directory,'observation-history','receipt-'+randomUUID()+'.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
      await atomicJson(join(directory,'reattach-proof.json'),proof);
      job.observationHistory=[...(job.observationHistory || []),{at:now(),proof,previousPid:job.pid}];
      job.phase='preparing';job.activity=proof.outcome==='terminal'?'Collecting the verified retained attempt':'Observing the same accepted attempt';delete job.error;
      this.save(job);
    }
    const log=openSync(join(directory,'runner.log'),'a',0o600);
    const child=spawn(process.execPath,[fileURLToPath(new URL('./executor-runner.mjs',import.meta.url)),directory,...(proof?['--reattach']:[])],{windowsHide:true,detached:true,stdio:['ignore',log,log]});
    closeSync(log);child.unref();job.pid=child.pid;job.runnerIdentity=captureProcessIdentity(child.pid);this.save(job);
    child.on('error',error=>{if(!this.closed){const current=this.getJob(job.id);current.phase='uncertain';current.error='Runner launch needs inspection: '+error.message;this.save(current);}});
  }
  async reconcileAccepted(job,directory) {
    if(job.kind==='installation'||!job.installation.capabilities?.includes('accepted-attempt-v1')||await this.runnerAlive(job,directory))return false;
    const inputDigest=this.db.prepare('SELECT digest FROM jobs WHERE id=?').get(job.id).digest;
    const proof=await inspectAccepted(job,directory,inputDigest);
    job.recoveryObservation=proof;
    if(!['active','terminal'].includes(proof.outcome)){job.phase='uncertain';job.error=proof.reason || 'The accepted attempt requires inspection';this.save(job);return false;}
    if(await this.runnerAlive(job,directory))return false;
    await this.spawnRunner(job,directory,proof);return true;
  }
  async reconcileJob(id,executorId) {
    if(executorId!==this.identity)throw Object.assign(new Error('Executor identity changed'),{status:409});
    if(this.ticking||this.recovering||this.closed)throw Object.assign(new Error('Executor observation is busy; retry the read'),{status:409});
    this.ticking=true;
    try{
      const job=this.getJob(id);if(!job)throw new Error('Job not found');
      if(job.phase==='uncertain')await this.reconcileAccepted(job,join(this.root,'jobs',id));
      return this.getJob(id);
    }finally{this.ticking=false;}
  }
  async preparationCancellationFacts(id,executorId) {
    if(executorId!==this.identity)throw new Error('Executor identity changed');
    const job=this.getJob(id);if(!job||job.phase!=='uncertain'||job.pid||job.runnerIdentity||job.runtimeSession)throw new Error('Only a fenced preparation without a dispatched runner can be inspected');
    if(this.pendingJobs().some(j=>j.id!==id))throw new Error('Preserve other pending admissions before preparation maintenance');
    const directory=join(this.root,'jobs',id);
    for(const file of ['request.json','runner-owner.json','receipt.json','checkpoint.json','runtime-admission.json'])
      if(await lstat(join(directory,file)).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))throw new Error('A runnable or observed attempt exists; use its normal cancellation/recovery contract');
    const descriptor=managedDescriptor(job.installation.runtime?.managed);
    const sessions=this.sessions.records().filter(s=>s.owner===this.identity&&s.installationId===job.installation.id&&s.descriptor.driverRevision===descriptor.driverRevision&&s.status?.phase!=='stopped');
    if(sessions.length!==1)throw new Error('The owned preparation session is not uniquely identified');
    if(canonical(sessions[0].descriptor)!==canonical(descriptor)||sessions[0].status?.activeAttempt)throw new Error('The preparation session differs or has a recorded active attempt');
    const session=sessions[0],evidence=await this.preparationInspector(session,this.identity);
    const inputDigest=this.db.prepare('SELECT digest FROM jobs WHERE id=?').get(id).digest;
    return {job,session,evidence,inputDigest,directory};
  }
  async planPreparationCancellation(id,executorId) {
    if(this.ticking||this.recovering||this.closed)throw new Error('Executor maintenance is busy');this.ticking=true;
    try {
      const f=await this.preparationCancellationFacts(id,executorId);
      const plan={version:1,id:randomUUID(),jobId:id,executorId,inputDigest:f.inputDigest,sessionId:f.session.id,driverRevision:f.session.descriptor.driverRevision,specSha256:f.evidence.specSha256,
        action:'cancel-absent-preparation',submission:'unknown',expiresAt:new Date(Date.now()+10*60000).toISOString(),
        description:'Cancel only this fenced preparation after verifying no matching controller, runtime listener or GPU compute remains. Earlier submission remains unknown. No generation is retried.'};
      const result={...plan,digest:digest(plan),physicalObservation:f.evidence};
      await mkdir(f.directory,{recursive:true,mode:0o700});
      await atomicJson(join(f.directory,'preparation-cancel-plan.json'),result);return result;
    }finally{this.ticking=false;}
  }
  async cancelPreparation(id,{executorId,planId,planDigest}) {
    if(this.ticking||this.recovering||this.closed)throw new Error('Executor maintenance is busy');this.ticking=true;
    try {
      const f=await this.preparationCancellationFacts(id,executorId);
      const saved=JSON.parse(await readFile(join(f.directory,'preparation-cancel-plan.json'),'utf8'));
      const {digest:expected,physicalObservation,...plan}=saved;
      if(saved.id!==planId||expected!==planDigest||digest(plan)!==expected||saved.expiresAt<now()||saved.jobId!==id||saved.executorId!==executorId||saved.inputDigest!==f.inputDigest||
         saved.sessionId!==f.session.id||saved.driverRevision!==f.session.descriptor.driverRevision||saved.specSha256!==f.evidence.specSha256)throw new Error('Preparation cancellation review changed or expired');
      const status=this.sessions.retireAfterAbsentInspection(f.session,f.evidence);
      const receipt={version:1,phase:'cancelled',jobId:id,executorId,previousPhase:'uncertain',previousError:f.job.error||null,submission:'unknown',generationRetried:false,
        cancelledAt:now(),planId,planDigest,physicalObservation:f.evidence,releaseProof:status.releaseProof};
      await atomicJson(join(f.directory,'preparation-cancelled.json'),receipt);
      f.job.phase='cancelled';f.job.preparationCancellation=receipt;f.job.error='Preparation cancelled after physical stop inspection; earlier submission outcome remains unknown';return this.save(f.job);
    }finally{this.ticking=false;}
  }
  async idleFenceFacts(id,executorId) {
    await this.maintenanceGuard();
    if(executorId!==this.identity)throw new Error('Executor identity changed');
    const job=this.getJob(id),directory=join(this.root,'jobs',id);
    if(!job||job.kind==='installation'||job.phase!=='uncertain'||!job.runtimeSession)throw new Error('A fenced managed attempt is required');
    if(this.pendingJobs().some(j=>j.id!==id))throw new Error('Preserve other pending admissions before fence maintenance');
    if(await this.runnerAlive(job,directory))throw new Error('The accepted runner remains live');
    if(await lstat(join(directory,'runtime-admission.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))throw new Error('An accepted runtime packet exists; use normal attempt recovery');
    const files={};for(const name of ['request.json','runner-owner.json','receipt.json'])files[name]=digest(await readFile(join(directory,name)));
    const receipt=JSON.parse(await readFile(join(directory,'receipt.json'),'utf8'));
    if(receipt.phase!=='uncertain')throw new Error('The runner has a terminal outcome to collect');
    const descriptor=managedDescriptor(job.installation.runtime?.managed),session=this.sessions.records().find(s=>s.id===job.runtimeSession.id);
    if(!session||session.owner!==this.identity||session.installationId!==job.installation.id||canonical(session.descriptor)!==canonical(descriptor))throw new Error('The frozen managed owner differs');
    if(this.sessions.records().some(s=>s.id!==session.id&&s.status?.phase!=='stopped'))throw new Error('Preserve another live managed session');
    const status=await this.sessions.inspect(session);
    if(status.activeAttempt||!['ready','warm_idle','unloaded_idle','stopped'].includes(status.phase))throw new Error('The owned runtime is active or needs inspection');
    const inputDigest=this.db.prepare('SELECT digest FROM jobs WHERE id=?').get(id).digest;
    return {job,directory,session,status,files,inputDigest};
  }
  async planIdleFenceCancellation(id,executorId) {
    if(this.ticking||this.recovering||this.closed)throw new Error('Executor maintenance is busy');this.ticking=true;
    try{
      const f=await this.idleFenceFacts(id,executorId);
      const plan={version:1,id:randomUUID(),jobId:id,executorId,action:'cancel-idle-fenced-attempt',inputDigest:f.inputDigest,sessionId:f.session.id,
        driverRevision:f.session.descriptor.driverRevision,files:f.files,processIdentity:f.status.processIdentity,generation:f.status.generation,
        submission:'unknown',expiresAt:new Date(Date.now()+10*60000).toISOString(),
        description:'Cancel this fenced attempt whose observer stopped without a runtime admission packet. Stop only its verified idle managed runtime, verify physical release, retain every file and unknown earlier outcome, and never retry generation.'};
      const result={...plan,digest:digest(plan)};await atomicJson(join(f.directory,'idle-fence-cancel-plan.json'),result);return result;
    }finally{this.ticking=false;}
  }
  async cancelIdleFence(id,{executorId,planId,planDigest}) {
    if(this.ticking||this.recovering||this.closed)throw new Error('Executor maintenance is busy');this.ticking=true;
    try{
      const f=await this.idleFenceFacts(id,executorId),saved=JSON.parse(await readFile(join(f.directory,'idle-fence-cancel-plan.json'),'utf8'));
      const {digest:expected,...plan}=saved;
      if(saved.id!==planId||expected!==planDigest||digest(plan)!==expected||saved.expiresAt<now()||saved.jobId!==id||saved.executorId!==executorId||
        saved.inputDigest!==f.inputDigest||saved.sessionId!==f.session.id||saved.driverRevision!==f.session.descriptor.driverRevision||canonical(saved.files)!==canonical(f.files)||
        canonical(saved.processIdentity)!==canonical(f.status.processIdentity)||saved.generation!==f.status.generation)throw new Error('Idle fence cancellation review changed or expired');
      await atomicJson(join(f.directory,'idle-fence-cancel-intent.json'),saved);
      // Offline maintenance owns the only admission boundary. The sole pending
      // identity is explicitly being cancelled; never clear a backend queue.
      const driver=await this.sessions.driver(f.session.descriptor);
      if(!driver.setPendingAdmissions)throw new Error('Managed driver cannot retire its pending admission');
      await this.maintenanceGuard();
      await driver.setPendingAdmissions({session:f.session,descriptor:f.session.descriptor},[]);
      const stopped=await this.sessions.release(f.session);
      if(stopped.phase!=='stopped'||!stopped.releaseProof)throw new Error('Owned runtime release remains unverified');
      const evidence=await this.preparationInspector(f.session,this.identity);
      const status=this.sessions.retireAfterAbsentInspection(f.session,evidence);
      const receipt={version:1,phase:'cancelled',jobId:id,executorId,previousPhase:'uncertain',previousError:f.job.error||null,submission:'unknown',generationRetried:false,
        cancelledAt:now(),planId,planDigest,physicalObservation:evidence,releaseProof:status.releaseProof};
      await atomicJson(join(f.directory,'idle-fence-cancelled.json'),receipt);f.job.phase='cancelled';f.job.idleFenceCancellation=receipt;return this.save(f.job);
    }finally{this.ticking=false;}
  }
  acceptReceipt(job,receipt) {
    Object.assign(job,receipt);
    if(receipt.phase==='completed')delete job.error;
    this.save(job);
    if(job.kind==='installation'&&job.phase==='completed')this.db.prepare('INSERT OR IGNORE INTO installations VALUES (?,?,?)').run(job.installation.id,job.appId,JSON.stringify({...job.installation,observations:receipt.result?.readiness?.observations}));
  }
  async tick() {
    if(this.ticking || this.closed || this.recovering)return;this.ticking=true;
    try {
      await this.sessions.protectPending(this.pendingJobs().map(j=>j.id));
      if (this.memory.busyReason()) this.memory.activity(this.memory.busyReason());
      for(const job of this.pendingJobs().filter(row=>ACTIVE.includes(row.phase))) {
        if (job.recoveryApplying) continue;
        const directory=join(this.root,'jobs',job.id);
        try {const receipt=JSON.parse(await readFile(join(directory,'receipt.json'),'utf8'));this.acceptReceipt(job,receipt);
          if(receipt.phase==='uncertain')try{await this.reconcileAccepted(job,directory);}catch(error){job.phase='uncertain';job.error=error.message;this.save(job);}
        }
        catch(error){if(error.code!=='ENOENT')throw error;
          try {const checkpoint=JSON.parse(await readFile(join(directory,'checkpoint.json'),'utf8'));Object.assign(job,checkpoint);this.save(job);}catch(e){if(e.code!=='ENOENT')throw e;}
          if(!await this.runnerAlive(job,directory)){
            // The runner can publish its receipt and exit after the first read
            // missed it. Recheck before surfacing an ambiguous execution.
            try{this.acceptReceipt(job,JSON.parse(await readFile(join(directory,'receipt.json'),'utf8')));continue;}
            catch(e){if(e.code!=='ENOENT')throw e;}
            job.phase='uncertain';job.error='Runner stopped without a terminal receipt. Verify the same accepted attempt before releasing the executor.';this.save(job);
            try{await this.reconcileAccepted(job,directory);}catch(e){job.error=e.message;this.save(job);}
          }
        }
      }
      if(this.pendingJobs().some(row=>ACTIVE.includes(row.phase)))return;
      const job=this.pendingJobs().find(row=>row.phase==='queued');if(!job){await this.sessions.observations();await this.memory.tick();return;}
      if(job.readinessWait && !job.readinessWait.resolvedAt) {
        // A job may have spent its whole deadline behind another GPU job.
        // Always recheck at expiry: elapsed queue time alone is not a failure.
        if(Date.now()<Date.parse(job.readinessWait.nextAttemptAt) && Date.now()<Date.parse(job.readinessWait.deadlineAt))return;
      }
      delete job.activity;
      job.phase='preparing';this.save(job);
      const directory=join(this.root,'jobs',job.id);
      try {
        if(job.kind!=='installation'){
          const readiness=await this.inspectInstallation(job.installation);
          if(!readiness.features.includes(job.feature)) {
            if(isEnvironmentBusy(readiness,job.feature)){
              if(job.readinessWait && !job.readinessWait.resolvedAt && Date.now()>=Date.parse(job.readinessWait.deadlineAt)) {
                job.readinessIssues=readiness.issues;
                throw new Error('Environment remained busy beyond the 5 minute readiness deadline; no generation was submitted.');
              }
              deferReadiness(job,readiness);this.save(job);return;
            }
            job.readinessIssues=readiness.issues;
            throw new Error(readiness.problems.join('; '));
          }
          if(job.readinessWait)job.readinessWait.resolvedAt=now();
        }
        const cpuSetup=job.kind==='installation'&&job.installation.setup?.requiresGpu===false;
        if(cpuSetup&&job.installation.setup.services?.length)throw new Error('CPU-only setup cannot start runtime services');
        const managed=job.kind!=='installation'&&Boolean(job.installation.runtime?.managed);
        const requiredRuntimes=job.installation.runtime?.comfyUrls??null;
        // Inspect before changing any runtime. Managed drivers verify process,
        // queue and GPU ownership again at preparation and final admission.
        if(!cpuSetup && (job.kind!=='installation'||job.installation.setup) && !await this.prepareGpu({allowStoppedRuntimes:job.kind==='installation'||managed,requiredRuntimes,inspectOnly:true})){
          job.phase='queued';job.activity='Waiting for adopted runtimes to be reachable and idle';this.save(job);return;
        }
        // Installation inputs are setup commands, not a generation model chain.
        // Verification-only installs leave a healthy warm session untouched.
        const runtimeSession=job.kind==='installation'
          ? (job.installation.setup&&!cpuSetup?await this.sessions.prepare({...job,installation:{...job.installation,runtime:undefined}}):null)
          : await this.sessions.prepare(job);
        if(runtimeSession){job.runtimeSession=runtimeSession;this.save(job);}
        if(!cpuSetup && (job.kind!=='installation'||job.installation.setup) && !await this.prepareGpu({allowStoppedRuntimes:job.kind==='installation',requiredRuntimes,skipFreeUrls:managed?new Set(requiredRuntimes || []):new Set()})){
          job.phase='queued';job.activity='Waiting for adopted runtimes to be reachable and idle';this.save(job);return;
        }
        await mkdir(join(directory,'inputs'),{recursive:true,mode:0o700});
        for(const file of job.files || [])await copyFile(this.storage.object('input:'+file.hash).path,contained(join(directory,'inputs'),file.name));
        await atomicJson(join(directory,'request.json'),{job,installation:job.installation});
        await this.spawnRunner(job,directory);
      }catch(error){
        // A driver may have created a runtime before losing its response.
        // Preserve admission until its recorded identity can be inspected.
        const uncertain=this.sessions.records().some(session=>session.error || session.status?.phase==='needs_inspection');
        job.phase=uncertain?'uncertain':'failed';job.error=error.message;this.save(job);
      }
    }finally{this.ticking=false;}
  }
  async releaseMemory(executorId) {
    if(executorId!==this.identity)throw Object.assign(new Error('Executor identity changed. Refresh this machine.'),{status:409});
    if(this.ticking || this.recovering || this.closed)throw Object.assign(new Error('The executor is busy. Try again when its current operation finishes.'),{status:409});
    const busy=this.memory.busyReason();if(busy)throw Object.assign(new Error(busy),{status:409});
    this.ticking=true;
    try{const sessions=await this.sessions.releaseIdle();return {...await this.memory.release(),sessions};}finally{this.ticking=false;}
  }
  async close() {this.closed=true;this.directoryUsage?.close();clearInterval(this.timer);while(this.ticking)await new Promise(resolve=>setTimeout(resolve,20));this.storage.close();}
}
