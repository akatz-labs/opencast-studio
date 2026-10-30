import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compatibility, hash, identifier, integer, record, sessionStatus } from './session-contracts.js';
const fail = (message) => Object.assign(new Error(message), { status: 409 });
export function managedDescriptor(value) {
    const v = record(value);
    if (Object.keys(v).some(k => !['version', 'driver', 'driverRevision', 'recipeRevision', 'environmentId', 'idlePolicy', 'configuration'].includes(k)))
        throw new Error('Unknown managed runtime field');
    if (v.version !== 1 || typeof v.driver !== 'string' || !isAbsolute(v.driver))
        throw new Error('Pinned managed runtime driver required');
    const policy = record(v.idlePolicy);
    if (Object.keys(policy).some(k => !['unloadSeconds', 'stopSeconds'].includes(k)))
        throw new Error('Unknown idle policy field');
    const unloadSeconds = integer(policy.unloadSeconds, 'unload duration', 1);
    const stopSeconds = integer(policy.stopSeconds, 'stop duration', 1);
    if (stopSeconds < unloadSeconds || stopSeconds > 86400)
        throw new Error('Invalid managed idle policy');
    return { version: 1, driver: v.driver, driverRevision: hash(v.driverRevision), recipeRevision: hash(v.recipeRevision), environmentId: identifier(v.environmentId),
        idlePolicy: { unloadSeconds, stopSeconds }, configuration: record(v.configuration) };
}
export function compatible(a, b) {
    return a !== null && Object.keys(b).every(k => a[k] === b[k]);
}
/** Executor-owned records; the declared driver is the single process/idle owner. */
export class RuntimeSessions {
    owner;
    root;
    store;
    loadDriver;
    constructor(owner, root, store, loadDriver) {
        this.owner = owner;
        this.root = root;
        this.store = store;
        this.loadDriver = loadDriver;
    }
    records() { return this.store.load(); }
    async driver(descriptor) {
        if (this.loadDriver)
            return this.loadDriver(descriptor);
        const actual = createHash('sha256').update(await readFile(descriptor.driver)).digest('hex');
        if (actual !== descriptor.driverRevision)
            throw fail('Managed runtime driver revision changed');
        const module = await import(pathToFileURL(descriptor.driver).href);
        const v = record(module);
        for (const method of ['inspectRuntime', 'prepareRuntime', 'releaseRuntime'])
            if (typeof v[method] !== 'function')
                throw new Error('Managed driver lacks ' + method);
        return v;
    }
    accept(session, observation) {
        const retired = this.records().find(s => s.id === session.id && s.retirementEvidence);
        if (retired?.status?.phase === 'stopped')
            return retired.status;
        const status = sessionStatus(observation);
        if (status.id !== session.id || status.owner !== this.owner || status.installationId !== session.installationId || status.recipeRevision !== session.descriptor.recipeRevision || status.generation < session.generation)
            throw fail('Managed runtime observation identity changed');
        const previous = session.status?.processIdentity, current = status.processIdentity;
        if (previous && current && (previous.boot !== current.boot || (status.generation === session.generation &&
            (previous.pid !== current.pid || previous.start !== current.start))))
            throw fail('Managed process identity changed without a verified generation');
        session.generation = status.generation;
        session.status = status;
        delete session.error;
        this.store.save(session);
        return status;
    }
    async inspect(session) {
        const retired = this.records().find(s => s.id === session.id && s.retirementEvidence);
        if (retired?.status?.phase === 'stopped')
            return retired.status;
        try {
            return this.accept(session, await (await this.driver(session.descriptor)).inspectRuntime({ session, descriptor: session.descriptor }));
        }
        catch (error) {
            const retired = this.records().find(s => s.id === session.id && s.retirementEvidence);
            if (retired?.status?.phase === 'stopped')
                return retired.status;
            session.error = error instanceof Error ? error.message : 'Runtime inspection failed';
            if (session.status)
                session.status = { ...session.status, phase: 'needs_inspection' };
            this.store.save(session);
            throw error;
        }
    }
    async observations() {
        const results = [];
        for (const session of this.records()) {
            if (session.status?.phase === 'stopped') {
                results.push(session.status);
                continue;
            }
            results.push(await this.inspect(session));
        }
        return results;
    }
    async idleObservation(session) {
        const deadline = Date.now() + 90000;
        let status = await this.inspect(session);
        while (['starting', 'stopping'].includes(status.phase) && !status.activeAttempt && Date.now() < deadline) {
            await new Promise(done => setTimeout(done, 250));
            status = await this.inspect(session);
        }
        return status;
    }
    async release(session) {
        const before = await this.idleObservation(session);
        if (before.phase === 'stopped')
            return before;
        if (before.activeAttempt || !['ready', 'warm_idle', 'unloaded_idle'].includes(before.phase))
            throw fail('Managed session is active or uncertain');
        const after = this.accept(session, await (await this.driver(session.descriptor)).releaseRuntime({ session, descriptor: session.descriptor }));
        if (after.phase !== 'stopped' || !after.releaseProof)
            throw fail('Managed runtime has not proved release');
        return after;
    }
    async prepare(job) {
        const descriptor = job.installation.runtime?.managed === undefined ? null : managedDescriptor(job.installation.runtime.managed);
        const wanted = descriptor ? compatibility(record(job.inputs).runtimeCompatibility) : null;
        if (descriptor && wanted && (wanted.recipeRevision !== descriptor.recipeRevision || wanted.adapterRevision !== job.installation.revision))
            throw fail('Job compatibility differs from its pinned installation');
        let selected;
        for (const session of this.records()) {
            if (session.status?.phase === 'stopped')
                continue;
            const status = await this.idleObservation(session);
            if (status.phase === 'stopped')
                continue;
            if (status.activeAttempt || !['ready', 'warm_idle', 'unloaded_idle'].includes(status.phase))
                throw fail('Managed runtime ownership needs inspection or is active');
            const same = descriptor && wanted && session.installationId === job.installation.id && session.descriptor.recipeRevision === descriptor.recipeRevision &&
                session.descriptor.driverRevision === descriptor.driverRevision && session.descriptor.environmentId === descriptor.environmentId &&
                session.processAllocator === wanted.allocator;
            if (same)
                selected = session;
            else
                await this.release(session);
        }
        if (!descriptor || !wanted)
            return null;
        if (!selected) {
            selected = { version: 1, id: randomUUID(), owner: this.owner, installationId: job.installation.id, descriptor,
                directory: join(this.root, 'runtime-sessions', randomUUID()), generation: 1, processAllocator: wanted.allocator, status: null };
            await mkdir(selected.directory, { recursive: true, mode: 0o700 });
            this.store.save(selected); // durable identity before a process may start
        }
        try {
            this.accept(selected, await (await this.driver(descriptor)).prepareRuntime({ session: selected, descriptor, job, compatibility: wanted }));
            return selected;
        }
        catch (error) {
            selected.error = error instanceof Error ? error.message : 'Managed runtime preparation failed';
            if (selected.status)
                selected.status = { ...selected.status, phase: 'needs_inspection' };
            this.store.save(selected);
            throw error;
        }
    }
    async releaseIdle() {
        const results = [];
        for (const session of this.records())
            if (session.status?.phase !== 'stopped')
                results.push(await this.release(session));
        return results;
    }
    retireAfterAbsentInspection(session, evidence) {
        if (session.owner !== this.owner || evidence.owner !== this.owner || evidence.sessionId !== session.id || evidence.descriptorRevision !== session.descriptor.driverRevision ||
            evidence.controllerProcessesAbsent !== true || evidence.runtimePortClosed !== true || evidence.gpuComputeEmpty !== true || evidence.runtimeInboxEmpty !== true || evidence.submission !== 'unknown')
            throw fail('Physical preparation stop proof differs');
        hash(evidence.specSha256);
        const observedAt = new Date().toISOString();
        const status = sessionStatus({ version: 1, id: session.id, owner: this.owner, installationId: session.installationId, recipeRevision: session.descriptor.recipeRevision, generation: session.generation,
            phase: 'stopped', processIdentity: null, compatibility: null, activeAttempt: null, idleSeconds: 0, unloadSeconds: session.descriptor.idlePolicy.unloadSeconds, stopSeconds: session.descriptor.idlePolicy.stopSeconds,
            modelEntries: 0, cacheHits: session.status?.cacheHits || 0, observedAt, releaseProof: { stopped: true, gpuReleased: true, observedAt } });
        session.retirementEvidence = evidence;
        session.status = status;
        delete session.error;
        this.store.save(session);
        return status;
    }
    async protectPending(jobIds) {
        for (const session of this.records()) {
            if (!session.status || session.status.phase === 'stopped')
                continue;
            const driver = await this.driver(session.descriptor);
            if (driver.setPendingAdmissions)
                await driver.setPendingAdmissions({ session, descriptor: session.descriptor }, jobIds);
        }
    }
}
