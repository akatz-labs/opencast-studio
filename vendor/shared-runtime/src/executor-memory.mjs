// Machine-local cache policy. All cleanup runs under Executor.ticking so a
// generation cannot dispatch while we inspect queues or request an unload.
const KEY = 'memory:policy';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const conflict = message => Object.assign(new Error(message), {status: 409});
export class ExecutorMemory {
  constructor(executor, {clock = Date.now, pollMs = 5000} = {}) {
    this.executor = executor;
    this.clock = clock;
    this.pollMs = pollMs;
    const saved = executor.db.prepare('SELECT value FROM preferences WHERE key=?').get(KEY);
    this.idleTimeoutSeconds = saved ? JSON.parse(saved.value).idleTimeoutSeconds : 900;
    this.idleSince = null;
    this.nextPoll = 0;
    this.attempted = false;
    this.state = 'waiting';
    this.reason = 'Waiting to observe idle runtime queues.';
    this.lastRelease = null;
    this.epoch = 0;
  }
  busyReason() {
    if (this.executor.recovering) return 'Job recovery is in progress.';
    if ((this.executor.pendingJobs?.() || this.executor.jobs()).some(job => !TERMINAL.has(job.phase))) return 'Generation or installation work is queued, active, or uncertain.';
    if (this.executor.hasActiveResourceJobs?.()) return 'Resource work is in progress.';
    return null;
  }
  activity(reason = 'Waiting for work to finish.') {
    this.epoch++;
    this.idleSince = null;
    this.attempted = false;
    if (this.state === 'releasing') return;
    this.state = 'waiting';
    this.reason = reason;
  }
  status() {
    const busy = this.busyReason();
    return {executorId: this.executor.identity, idleTimeoutSeconds: this.idleTimeoutSeconds,
      state: this.state === 'releasing' ? 'releasing' : busy ? 'waiting' : this.idleTimeoutSeconds === null ? 'disabled' : this.state,
      reason: busy || this.reason,
      idleSince: this.idleSince === null ? null : new Date(this.idleSince).toISOString(),
      releaseAt: !busy && !this.attempted && this.idleSince !== null && this.idleTimeoutSeconds !== null ? new Date(this.idleSince + this.idleTimeoutSeconds * 1000).toISOString() : null,
      lastRelease: this.lastRelease};
  }
  configure({executorId, idleTimeoutSeconds, ...extra}) {
    if (executorId !== this.executor.identity) throw conflict('Executor identity changed. Refresh this machine.');
    if (Object.keys(extra).length || (idleTimeoutSeconds !== null && (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 1 || idleTimeoutSeconds > 86400)))
      throw new Error('idleTimeoutSeconds must be null (Never) or an integer from 1 to 86400.');
    if (this.state === 'releasing') throw conflict('Memory cleanup is in progress. Try again when it finishes.');
    if (idleTimeoutSeconds !== this.idleTimeoutSeconds) {
      this.executor.db.prepare('INSERT INTO preferences VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify({idleTimeoutSeconds}));
      this.idleTimeoutSeconds = idleTimeoutSeconds;
      this.activity('Waiting to observe idle runtime queues.');
      this.nextPoll = 0;
    }
    return this.status();
  }
  async queues() {
    // Managed drivers own acknowledged cleanup and process timers. Never issue
    // competing /free calls from the legacy machine policy against them.
    const managed = this.executor.managedRuntimeUrls?.() || new Set();
    const urls = [...new Set(this.executor.installations().flatMap(item => item.runtime?.comfyUrls || []))].filter(url => !managed.has(url));
    const online = [];
    for (const origin of urls) {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password)
        throw new Error('Managed GPU runtimes must use worker loopback.');
      let response;
      try { response = await fetch(origin + '/queue', {signal: AbortSignal.timeout(4000)}); }
      catch (error) { if (error.cause?.code === 'ECONNREFUSED') continue; throw new Error('An adopted runtime queue could not be checked.'); }
      if (!response.ok) throw new Error('An adopted runtime queue could not be checked.');
      const queue = await response.json();
      if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error('An adopted runtime returned an unrecognized queue.');
      if (queue.queue_running.length || queue.queue_pending.length) throw conflict('An adopted runtime has running or queued work.');
      online.push(origin);
    }
    return online;
  }
  async tick() {
    const busy = this.busyReason();
    if (busy) { this.activity(busy); return; }
    if (this.idleTimeoutSeconds === null || this.clock() < this.nextPoll) return;
    this.nextPoll = this.clock() + this.pollMs;
    try {
      await this.queues();
      const raced = this.busyReason();
      if (raced) { this.activity(raced); return; }
      if (this.idleSince === null) this.idleSince = this.clock();
      if (this.attempted) return;
      this.state = 'warm';
      this.reason = 'Cached models may remain loaded while waiting for follow-up work.';
      if (this.idleTimeoutSeconds !== null && this.clock() - this.idleSince >= this.idleTimeoutSeconds * 1000) await this.release(this.epoch);
    } catch (error) {
      if (!this.attempted) this.activity(error.message);
    }
  }
  async release(automaticEpoch) {
    const busy = this.busyReason();
    if (busy) { this.activity(busy); throw conflict(busy); }
    let online;
    try { online = await this.queues(); }
    catch (error) { this.activity(error.message); throw error; }
    const raced = this.busyReason();
    if (raced) { this.activity(raced); throw conflict(raced); }
    if (automaticEpoch !== undefined && (automaticEpoch !== this.epoch || this.idleTimeoutSeconds === null)) return this.status();
    // /free is asynchronous: acknowledgement proves a request, not the amount
    // of reclaimed VRAM/RAM. Never automatically replay an ambiguous POST.
    this.state = 'releasing';
    this.reason = 'Requesting cache cleanup from idle runtimes.';
    this.attempted = true;
    const receipt = {requestedAt: new Date(this.clock()).toISOString(), runtimes: [], outcome: 'requested'};
    this.lastRelease = receipt;
    try {
      for (const origin of online) {
        await this.queues();
        const reason = this.busyReason();
        if (reason) throw conflict(reason);
        const response = await fetch(origin + '/free', {method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({unload_models: true, free_memory: true}), signal: AbortSignal.timeout(30000)});
        if (!response.ok) throw new Error('A runtime did not acknowledge memory cleanup. Inspect it before retrying.');
        receipt.runtimes.push(origin);
      }
      this.state = 'requested';
      this.reason = online.length ? 'Cache cleanup requested. The next generation reloads models as needed.' : 'No adopted runtimes are running.';
    } catch (error) {
      receipt.outcome = 'incomplete';
      this.state = 'error';
      this.reason = error.message;
      throw error;
    }
    return this.status();
  }
}
