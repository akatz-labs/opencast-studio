import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { record, recoveryObservation, identifier, hash } from './session-contracts.js';
function canonical(value) {
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object') {
        const v = record(value);
        return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    }
    return JSON.stringify(value);
}
const digest = (v) => createHash('sha256').update(canonical(v)).digest('hex');
export async function inspectAccepted(job, directory, expectedInputDigest) {
    if (!job.installation.capabilities?.includes('accepted-attempt-v1'))
        throw new Error('Adapter lacks accepted-attempt-v1');
    identifier(job.id);
    hash(expectedInputDigest);
    const request = record(JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')));
    const captured = record(request.job);
    if (captured.id !== job.id || captured.appId !== job.appId || captured.executorId !== job.executorId)
        throw new Error('Accepted job identity changed');
    const immutable = {};
    const fields = captured.admissionFields;
    const allowed = ['appId', 'instanceId', 'sourceJobId', 'installationId', 'feature', 'inputs', 'files', 'executorId'];
    if (!Array.isArray(fields) || fields.some(k => typeof k !== 'string' || !allowed.includes(k)))
        throw new Error('Accepted request fields are missing or invalid');
    for (const key of fields)
        immutable[key] = captured[key];
    if (digest(immutable) !== expectedInputDigest)
        throw new Error('Accepted input digest changed');
    const adapterBytes = await readFile(job.installation.adapter);
    if (createHash('sha256').update(adapterBytes).digest('hex') !== job.installation.revision)
        throw new Error('Accepted adapter revision changed');
    const module = await import(pathToFileURL(job.installation.adapter).href);
    const adapter = record(module);
    if (typeof adapter.inspectAcceptedAttempt !== 'function' || typeof adapter.resumeAccepted !== 'function')
        throw new Error('Adapter has no accepted-attempt observation/resume contract');
    const inspect = adapter.inspectAcceptedAttempt;
    const observation = recoveryObservation(await inspect({ job: captured, installation: request.installation, directory, runtimeSession: captured.runtimeSession }));
    if (observation.jobId !== job.id)
        throw new Error('Recovery proof belongs to another job');
    const checkpointBytes = await readFile(join(directory, 'checkpoint.json'), 'utf8').catch(error => { if (error.code === 'ENOENT')
        return null; throw error; });
    if (checkpointBytes) {
        const checkpoint = record(JSON.parse(checkpointBytes));
        if (checkpoint.attemptId !== undefined && observation.attemptId !== checkpoint.attemptId)
            throw new Error('Recovery attempt differs from the saved checkpoint');
    }
    if (observation.outcome === 'active' && observation.runtimeSessionId !== job.runtimeSession?.id)
        throw new Error('Recovery runtime binding changed');
    // Non-submission remains on the existing reviewed recovery path. This module
    // permits observation/collection only, never a new GPU attempt.
    return observation;
}
