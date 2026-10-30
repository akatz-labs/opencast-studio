import { readFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { hashFile, syncDirectory } from './storage.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const conflict = message => Object.assign(new Error(message), { status: 409 });
const readOptional = path => readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const exists = path => stat(path).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });

function requireStopped(job) {
  if (!Number.isInteger(job.pid) || job.pid < 1) throw conflict('Runner identity is missing; this recovery path cannot prove it stopped.');
  try { process.kill(job.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  throw conflict('The recorded runner is still alive. Recovery cannot release its slot.');
}
async function inspect(executor, jobId, adapterRevision) {
  const job = executor.getJob(jobId);
  if (!job || job.phase !== 'uncertain' || job.recoveryApplying) throw conflict('Only an uncertain job without a pending recovery can be inspected.');
  requireStopped(job);
  if (!/^[a-f0-9]{64}$/.test(adapterRevision)) throw new Error('A verified recovery adapter revision is required.');
  const adapter = executor.storage.object('adapter:' + adapterRevision);
  if (!adapter || (await hashFile(adapter.path)).hash !== adapterRevision) throw conflict('Recovery adapter bytes do not match their revision.');
  const modulePath = await executor.storage.materializeObject('adapter:' + adapterRevision, 'adapters/' + adapterRevision + '.mjs');
  const module = await import(pathToFileURL(modulePath).href);
  if (module.recoveryAppId !== job.appId || typeof module.inspectRecovery !== 'function') throw conflict('This adapter does not verify recovery for this app.');
  const directory = join(executor.root, 'jobs', job.id);
  const receipt = await readOptional(join(directory, 'receipt.json'));
  const checkpoint = await readOptional(join(directory, 'checkpoint.json'));
  if (!receipt || JSON.parse(receipt).phase !== 'uncertain') throw conflict('An uncertain runner receipt is required for this recovery path.');
  const evidence = await module.inspectRecovery({ job, installation: job.installation, directory, receipt: JSON.parse(receipt), checkpoint: checkpoint ? JSON.parse(checkpoint) : null });
  if (evidence?.safeToRetry !== true || evidence?.submission !== 'not-submitted' || typeof evidence.reason !== 'string') throw conflict('The app could not prove this request was never submitted.');
  requireStopped(job);
  const inputDigest = executor.db.prepare('SELECT digest FROM jobs WHERE id=?').get(job.id).digest;
  const fingerprint = hash({ id: job.id, executorId: executor.identity, inputDigest, phase: job.phase, pid: job.pid, submission: job.submission, promptId: job.promptId, receipt: hash(receipt), checkpoint: checkpoint && hash(checkpoint) });
  return { job, fingerprint, evidence };
}

export async function planRecovery(executor, jobId, { adapterRevision, executorId } = {}) {
  if (executorId !== executor.identity) throw conflict('Executor identity changed. Inspect the intended machine first.');
  const { job, fingerprint, evidence } = await inspect(executor, jobId, adapterRevision);
  const plan = { kind: 'job-recovery', id: randomUUID(), jobId: job.id, executorId, appId: job.appId,
    adapterRevision, fingerprint, evidence, action: 'retry-not-submitted',
    description: 'Retry the same saved request after proving no GPU submission occurred. Preserve the original inputs, seed, installation and failed attempt. Queued work will resume.',
    expiresAt: new Date(Date.now() + 10 * 60000).toISOString() };
  const digest = hash(plan);
  executor.db.prepare('INSERT INTO plans VALUES (?,?,?)').run(plan.id, digest, JSON.stringify(plan));
  return { ...plan, digest };
}

export async function confirmRecovery(executor, jobId, { planId, digest, executorId } = {}) {
  if (executorId !== executor.identity) throw conflict('Executor identity changed.');
  if (executor.recovering) throw conflict('Another recovery is applying. Inspect it before retrying.');
  executor.recovering = true;
  try {
    while (executor.ticking) await new Promise(resolve => setTimeout(resolve, 20));
    const stored = executor.db.prepare('SELECT digest,document FROM plans WHERE id=?').get(planId);
    if (!stored || stored.digest !== digest) throw conflict('Confirm the exact reviewed recovery plan.');
    const plan = JSON.parse(stored.document);
    if (plan.kind !== 'job-recovery' || plan.jobId !== jobId || plan.executorId !== executorId) throw conflict('The recovery plan belongs to a different job or machine.');
    let job = executor.getJob(jobId);
    if (job.recoveryHistory?.some(record => record.planId === planId)) return job;
    if (job.recoveryApplying?.planId !== planId) {
      if (new Date(plan.expiresAt).getTime() < Date.now()) throw conflict('Recovery plan expired. Inspect the job again.');
      const current = await inspect(executor, jobId, plan.adapterRevision);
      if (current.fingerprint !== plan.fingerprint || hash(current.evidence) !== hash(plan.evidence)) throw conflict('Recovery evidence changed. Inspect the job again.');
      job = current.job;
      job.recoveryApplying = { planId, reviewedAt: new Date().toISOString() };
      executor.save(job);
    }
    requireStopped(job);
    const directory = join(executor.root, 'jobs', job.id);
    const archive = join(executor.root, 'jobs', 'attempts', job.id, planId);
    await mkdir(join(executor.root, 'jobs', 'attempts', job.id), { recursive: true, mode: 0o700 });
    const [sourceExists, archiveExists] = await Promise.all([exists(directory), exists(archive)]);
    if (sourceExists && !archiveExists) await rename(directory, archive);
    else if (sourceExists || !archiveExists) throw conflict('Attempt archive is inconsistent; preserve it for inspection.');
    await syncDirectory(join(executor.root, 'jobs'));
    await syncDirectory(join(executor.root, 'jobs', 'attempts', job.id));
    job.recoveryHistory = [...(job.recoveryHistory || []), { planId, recoveredAt: new Date().toISOString(), evidence: plan.evidence, archive, priorError: job.error }];
    for (const key of ['pid', 'workflow', 'submission', 'promptId', 'runtimeTerminal', 'result', 'error', 'completedAt', 'activity', 'recoveryApplying']) delete job[key];
    job.phase = 'queued';
    return executor.save(job);
  } finally { executor.recovering = false; }
}
