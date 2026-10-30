/** Versioned wire contracts. This module is browser safe. */
export const SESSION_CAPABILITIES = ['managed-runtime-v1', 'accepted-attempt-v1', 'staged-resources-v1'];
export function record(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected an object');
    return value;
}
export function text(value, label) {
    if (typeof value !== 'string' || !value.length || value.length > 4096)
        throw new Error('Invalid ' + label);
    return value;
}
export function identifier(value) {
    const result = text(value, 'identifier');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(result))
        throw new Error('Invalid identifier');
    return result;
}
export function hash(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        throw new Error('Invalid content hash');
    return value;
}
export function integer(value, label, minimum = 0) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
        throw new Error('Invalid ' + label);
    return value;
}
export function timestamp(value) {
    const result = text(value, 'timestamp');
    if (!Number.isFinite(Date.parse(result)))
        throw new Error('Invalid timestamp');
    return result;
}
function exact(value, keys) {
    for (const key of Object.keys(value))
        if (!keys.includes(key))
            throw new Error('Unknown field: ' + key);
}
export function compatibility(value) {
    const v = record(value);
    exact(v, ['recipeRevision', 'adapterRevision', 'modelDigest', 'modelConfigurationDigest', 'precision', 'residency', 'allocator']);
    if (!['full', 'offload', 'stream', 'layer-stream'].includes(String(v.residency)))
        throw new Error('Invalid residency');
    return { recipeRevision: hash(v.recipeRevision), adapterRevision: hash(v.adapterRevision), modelDigest: hash(v.modelDigest),
        modelConfigurationDigest: hash(v.modelConfigurationDigest), precision: text(v.precision, 'precision'),
        residency: v.residency, allocator: text(v.allocator, 'allocator') };
}
export function processIdentity(value) {
    const v = record(value);
    exact(v, ['platform', 'pid', 'start', 'boot']);
    if (v.platform !== 'linux')
        throw new Error('Worker process platform has not been qualified');
    return { platform: 'linux', pid: integer(v.pid, 'pid', 1), start: text(v.start, 'process start'), boot: text(v.boot, 'boot identity') };
}
export function sessionStatus(value) {
    const v = record(value);
    exact(v, ['version', 'id', 'owner', 'installationId', 'recipeRevision', 'generation', 'phase', 'processIdentity', 'compatibility', 'activeAttempt', 'idleSeconds', 'unloadSeconds', 'stopSeconds', 'modelEntries', 'cacheHits', 'observedAt', 'releaseProof']);
    if (v.version !== 1 || !['starting', 'ready', 'active', 'warm_idle', 'unloaded_idle', 'stopping', 'stopped', 'needs_inspection'].includes(String(v.phase)))
        throw new Error('Unsupported session state');
    if (typeof v.idleSeconds !== 'number' || !Number.isFinite(v.idleSeconds) || v.idleSeconds < 0)
        throw new Error('Invalid idle duration');
    const result = { version: 1, id: identifier(v.id), owner: identifier(v.owner), installationId: identifier(v.installationId), recipeRevision: hash(v.recipeRevision),
        generation: integer(v.generation, 'generation', 1), phase: v.phase,
        processIdentity: v.processIdentity === null ? null : processIdentity(v.processIdentity),
        compatibility: v.compatibility === null ? null : compatibility(v.compatibility),
        activeAttempt: v.activeAttempt === null ? null : identifier(v.activeAttempt), idleSeconds: v.idleSeconds,
        unloadSeconds: integer(v.unloadSeconds, 'unload duration', 1), stopSeconds: integer(v.stopSeconds, 'stop duration', 1),
        modelEntries: integer(v.modelEntries, 'model count'), cacheHits: integer(v.cacheHits, 'cache hits'), observedAt: timestamp(v.observedAt) };
    if (result.stopSeconds < result.unloadSeconds)
        throw new Error('Stop precedes unload');
    if (v.releaseProof !== undefined) {
        const p = record(v.releaseProof);
        exact(p, ['stopped', 'gpuReleased', 'observedAt']);
        if (p.stopped !== true || p.gpuReleased !== true)
            throw new Error('Release has no terminal proof');
        result.releaseProof = { stopped: true, gpuReleased: true, observedAt: timestamp(p.observedAt) };
    }
    if (result.phase === 'stopped' && !result.releaseProof)
        throw new Error('Stopped session requires release proof');
    if (result.phase === 'active' && !result.activeAttempt)
        throw new Error('Active session requires attempt identity');
    return result;
}
export function artifactManifest(value) {
    const v = record(value);
    exact(v, ['version', 'jobId', 'attemptId', 'files']);
    if (v.version !== 1 || !Array.isArray(v.files) || !v.files.length)
        throw new Error('Invalid artifact manifest');
    const names = new Set();
    const files = v.files.map(file => {
        const f = record(file);
        exact(f, ['name', 'hash', 'size', 'mime', 'role']);
        const name = text(f.name, 'artifact name');
        if (name.includes('\\') || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..') || names.has(name))
            throw new Error('Invalid artifact name');
        names.add(name);
        return { name, hash: hash(f.hash), size: integer(f.size, 'artifact size'), mime: text(f.mime, 'MIME'), role: text(f.role, 'artifact role') };
    });
    return { version: 1, jobId: identifier(v.jobId), attemptId: identifier(v.attemptId), files };
}
export function executionBinding(value, availableCapabilities) {
    const v = record(value);
    exact(v, ['version', 'backend', 'executorId', 'installationId', 'installationRevision', 'operation', 'operationRevision', 'requestDigest', 'targetId', 'requiredCapabilities']);
    if (v.version !== 1 || !['shared-local', 'shared-ssh', 'hosted'].includes(String(v.backend)) || !Array.isArray(v.requiredCapabilities))
        throw new Error('Unsupported execution binding');
    const requiredCapabilities = v.requiredCapabilities.map(c => text(c, 'capability'));
    if (requiredCapabilities.some(c => !availableCapabilities.includes(c)))
        throw new Error('Required execution capability is unavailable');
    return { version: 1, backend: v.backend, executorId: identifier(v.executorId), installationId: identifier(v.installationId), installationRevision: hash(v.installationRevision),
        operation: identifier(v.operation), operationRevision: hash(v.operationRevision), requestDigest: hash(v.requestDigest), targetId: identifier(v.targetId), requiredCapabilities };
}
export function recoveryObservation(value) {
    const v = record(value);
    const base = { version: 1, jobId: identifier(v.jobId), attemptId: identifier(v.attemptId), evidenceDigest: hash(v.evidenceDigest) };
    if (v.version !== 1)
        throw new Error('Unsupported recovery version');
    if (v.outcome === 'active') {
        exact(v, ['version', 'outcome', 'jobId', 'attemptId', 'evidenceDigest', 'runtimeSessionId', 'backendId']);
        return { ...base, outcome: 'active', runtimeSessionId: identifier(v.runtimeSessionId), backendId: identifier(v.backendId) };
    }
    if (v.outcome === 'terminal') {
        exact(v, ['version', 'outcome', 'jobId', 'attemptId', 'evidenceDigest', 'manifest']);
        const manifest = artifactManifest(v.manifest);
        if (manifest.jobId !== base.jobId || manifest.attemptId !== base.attemptId)
            throw new Error('Recovered artifact identity differs');
        return { ...base, outcome: 'terminal', manifest };
    }
    if (v.outcome === 'not-submitted') {
        exact(v, ['version', 'outcome', 'jobId', 'attemptId', 'evidenceDigest', 'safeToRetry', 'reviewed', 'reason']);
        if (v.safeToRetry !== true || v.reviewed !== true)
            throw new Error('Non-submission requires reviewed evidence');
        return { ...base, outcome: 'not-submitted', safeToRetry: true, reviewed: true, reason: text(v.reason, 'reason') };
    }
    if (v.outcome === 'uncertain') {
        exact(v, ['version', 'outcome', 'jobId', 'attemptId', 'evidenceDigest', 'reason']);
        return { ...base, outcome: 'uncertain', reason: text(v.reason, 'reason') };
    }
    throw new Error('Unsupported recovery outcome');
}
export function cancellationResult(value) {
    const v = record(value);
    const jobId = identifier(v.jobId);
    if (v.version !== 1)
        throw new Error('Unsupported cancellation version');
    if (v.outcome === 'requested') {
        exact(v, ['version', 'outcome', 'jobId', 'requestedAt']);
        return { version: 1, outcome: 'requested', jobId, requestedAt: timestamp(v.requestedAt) };
    }
    if (v.outcome === 'cancelled') {
        exact(v, ['version', 'outcome', 'jobId', 'terminalEvidenceDigest', 'gpuReleased']);
        if (v.gpuReleased !== true)
            throw new Error('Cancellation has no GPU terminal proof');
        return { version: 1, outcome: 'cancelled', jobId, terminalEvidenceDigest: hash(v.terminalEvidenceDigest), gpuReleased: true };
    }
    if (v.outcome === 'completed') {
        exact(v, ['version', 'outcome', 'jobId', 'manifest']);
        const manifest = artifactManifest(v.manifest);
        if (manifest.jobId !== jobId)
            throw new Error('Completion identity differs');
        return { version: 1, outcome: 'completed', jobId, manifest };
    }
    throw new Error('Unsupported cancellation outcome');
}
