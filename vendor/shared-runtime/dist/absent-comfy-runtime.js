/** Linux-only physical stop observation for an explicitly cancelled preparation.
 * This proves no owned work can continue; it never proves that no work ran earlier.
 */
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { connect } from 'node:net';
import { comfyControlConfiguration } from './managed-comfy-driver.js';
import { record } from './session-contracts.js';
const command = promisify(execFile);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function portClosed(port) {
    return new Promise((done, fail) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.setTimeout(2000);
        socket.once('connect', () => { socket.destroy(); done(false); });
        socket.once('timeout', () => { socket.destroy(); fail(new Error('Runtime port observation timed out')); });
        socket.once('error', (error) => { socket.destroy(); if (error.code === 'ECONNREFUSED')
            done(true);
        else
            fail(error); });
    });
}
export async function inspectAbsentComfyRuntime(session, expectedOwner) {
    if (process.platform !== 'linux' || session.owner !== expectedOwner)
        throw new Error('Preparation stop inspection requires the owning Linux worker');
    const config = comfyControlConfiguration(session.descriptor.configuration), specPath = join(session.directory, 'spec.json');
    for (const [path, expected] of [[config.controller, config.controllerRevision], [config.contract, config.contractRevision]])
        if (sha(await readFile(path)) !== expected)
            throw new Error('Pinned preparation tools changed');
    if ((await lstat(specPath)).isSymbolicLink())
        throw new Error('Session binding is a symlink');
    const specBytes = await readFile(specPath), spec = record(JSON.parse(String(specBytes)));
    const expected = { session_id: session.id, owner: session.owner, installation_id: session.installationId, recipe_revision: session.descriptor.recipeRevision,
        environment_path: config.environmentPath, port: config.port, contract: config.contract, cg_executable: config.cgExecutable, owner_state_directory: config.ownerStateDirectory,
        root: join(config.mediaRoot, 'sessions', session.id), media_root: config.mediaRoot, input_directory: join(config.mediaRoot, 'inputs'), allocator: session.processAllocator };
    if (Object.entries(expected).some(([key, value]) => spec[key] !== value))
        throw new Error('Owned session binding differs');
    const inbox = await readdir(join(String(spec.root), 'inbox')).catch(error => { if (error.code === 'ENOENT')
        return []; throw error; });
    if (inbox.some(name => name.endsWith('.json')))
        throw new Error('An owned runtime inbox still contains an admission');
    const observedAt = new Date().toISOString(), matchingProcesses = [];
    for (const entry of await readdir('/proc')) {
        if (!/^\d+$/.test(entry))
            continue;
        try {
            const state = await readFile('/proc/' + entry + '/stat', 'utf8');
            if (state.slice(state.lastIndexOf(')') + 2).startsWith('Z '))
                continue;
            const args = (await readFile('/proc/' + entry + '/cmdline')).toString().split('\0');
            const ownsSpec = args.includes(config.controller) && args.includes(specPath);
            const ownsRuntime = [join(config.environmentPath, 'ComfyUI'), join(config.environmentPath, 'ComfyUI', 'main.py')].some(path => args.includes(path)) &&
                args.some((arg, index) => arg === '--port' && args[index + 1] === String(config.port));
            if (ownsSpec || ownsRuntime)
                matchingProcesses.push(Number(entry));
        }
        catch (error) {
            if (!['ENOENT', 'ESRCH'].includes(error.code || ''))
                throw error;
        }
    }
    if (matchingProcesses.length)
        throw new Error('An owned preparation/controller process remains live');
    if (!await portClosed(config.port))
        throw new Error('The bound runtime port remains occupied');
    const gpu = await command('nvidia-smi', ['--query-gpu=uuid', '--format=csv,noheader'], { timeout: 5000, maxBuffer: 65536 });
    if (!gpu.stdout.trim())
        throw new Error('GPU inventory could not be verified');
    const compute = await command('nvidia-smi', ['--query-compute-apps=pid', '--format=csv,noheader,nounits'], { timeout: 5000, maxBuffer: 65536 });
    if (compute.stdout.trim())
        throw new Error('GPU compute remains active; preparation is preserved');
    return { version: 1, owner: expectedOwner, sessionId: session.id, descriptorRevision: session.descriptor.driverRevision, specSha256: sha(specBytes), observedAt,
        controllerProcessesAbsent: true, runtimePortClosed: true, gpuComputeEmpty: true, runtimeInboxEmpty: true, gpuInventory: gpu.stdout.trim().split('\n'), submission: 'unknown' };
}
