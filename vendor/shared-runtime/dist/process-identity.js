import { readFileSync } from 'node:fs';
/** Qualified Linux ownership; legacy platforms do not inherit this capability. */
export function captureProcessIdentity(pid) {
    if (process.platform !== 'linux' || !Number.isInteger(pid) || pid < 1)
        return null;
    try {
        const raw = readFileSync('/proc/' + pid + '/stat', 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (fields[0] === 'Z' || fields[0] === 'X' || !fields[19])
            return null;
        return { platform: 'linux', pid, start: fields[19], boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
    }
    catch {
        return null;
    }
}
export function sameProcess(a, b) {
    return a !== null && b !== null && a.platform === b.platform && a.pid === b.pid && a.start === b.start && a.boot === b.boot;
}
export function processAlive(identity) {
    return sameProcess(identity, captureProcessIdentity(identity.pid));
}
