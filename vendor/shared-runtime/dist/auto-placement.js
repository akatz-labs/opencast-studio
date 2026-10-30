import { compatibility, identifier, record, sessionStatus, timestamp } from './session-contracts.js';
/** Placement is a pre-admission hint. The worker remains the sole FIFO owner. */
export function placementSnapshot(value, expectedId) {
    const v = record(value);
    if (v.executorId !== expectedId || !Array.isArray(v.jobs) || !Array.isArray(v.sessions))
        throw new Error('Worker placement observation has a different identity');
    const phases = v.jobs.map(j => String(record(j).phase));
    if (phases.some(p => !['queued', 'preparing', 'rendering', 'finalizing', 'uncertain'].includes(p)))
        throw new Error('Unknown worker admission phase');
    const sessions = v.sessions.map(s => {
        const row = record(s);
        return { installationId: identifier(row.installationId), status: row.status === null || row.status === undefined || row.error ? null : sessionStatus(row.status) };
    });
    return { executorId: identifier(v.executorId), checkedAt: timestamp(v.checkedAt), pending: phases.length,
        fenced: !Array.isArray(v.gpuCompute) || Boolean(v.gpuError) || phases.includes('uncertain') || sessions.some(s => !s.status || s.status.phase === 'needs_inspection') ||
            (phases.length === 0 && Array.isArray(v.externalGpuCompute) && v.externalGpuCompute.length > 0), sessions };
}
export function equalCompatibility(a, b) {
    return Object.keys(a).every(k => a[k] === b[k]);
}
export function rankPlacement(snapshot, installationId, wanted) {
    const desired = wanted === undefined ? null : compatibility(wanted);
    const warm = snapshot.sessions.some(s => s.installationId === installationId && s.status?.phase === 'warm_idle' &&
        s.status.modelEntries > 0 && s.status.compatibility && desired && equalCompatibility(s.status.compatibility, desired));
    const available = snapshot.pending === 0 && !snapshot.fenced;
    return { score: available ? (warm ? 0 : 1) : (snapshot.fenced ? 10000 : 2 + snapshot.pending),
        decision: { version: 1, mode: 'auto', reason: available ? (warm ? 'compatible-warm' : 'available') : 'worker-fifo', observedAt: snapshot.checkedAt } };
}
