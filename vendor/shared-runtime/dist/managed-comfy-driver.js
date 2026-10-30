/** Shared process/session control for trusted app-owned Comfy operation adapters. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, link, unlink, stat } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { hash, identifier, integer, record, sessionStatus, text } from './session-contracts.js';
const actions = new Set(['inspect', 'pending', 'launch', 'release', 'enqueue', 'cancel', 'observe', 'finish']);
const pause = (ms) => new Promise(done => setTimeout(done, ms));
function path(value, label) { const result = text(value, label); if (!isAbsolute(result))
    throw new Error(label + ' requires a worker-local absolute path'); return result; }
export function comfyControlConfiguration(value) {
    const v = record(value), port = integer(v.port, 'runtime port', 1);
    if (port > 65535)
        throw new Error('Invalid runtime port');
    return { python: path(v.python, 'Python'), controller: path(v.controller, 'Controller'), controllerRevision: hash(v.controllerRevision), contract: path(v.contract, 'Contract'), contractRevision: hash(v.contractRevision),
        cgExecutable: path(v.cgExecutable, 'ComfyGit'), environmentPath: path(v.environmentPath, 'Environment'), mediaRoot: path(v.mediaRoot, 'Media root'), ownerStateDirectory: path(v.ownerStateDirectory, 'Ownership guard'), port };
}
async function fileHash(location) { const digest = createHash('sha256'); for await (const bytes of createReadStream(location))
    digest.update(bytes); return digest.digest('hex'); }
async function publishOnce(location, value) {
    await mkdir(dirname(location), { recursive: true });
    const pending = location + '.' + randomUUID() + '.pending';
    await writeFile(pending, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    try {
        await link(pending, location);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    finally {
        await unlink(pending);
    }
}
/** App configuration validation and graph/output semantics stay with each consumer. */
export function createComfyControl(configuration = comfyControlConfiguration) {
    async function specification(context) {
        const config = configuration(context.descriptor.configuration);
        if (context.compatibility && context.compatibility.allocator !== context.session.processAllocator)
            throw new Error('Frozen job differs from the owned process allocator');
        if (await fileHash(config.controller) !== config.controllerRevision || await fileHash(config.contract) !== config.contractRevision)
            throw new Error('Pinned runtime tools changed');
        const location = join(context.session.directory, 'spec.json');
        const spec = { session_id: context.session.id, owner: context.session.owner, installation_id: context.session.installationId, recipe_revision: context.descriptor.recipeRevision,
            root: join(config.mediaRoot, 'sessions', context.session.id), media_root: config.mediaRoot, environment_path: config.environmentPath, port: config.port, input_directory: join(config.mediaRoot, 'inputs'),
            contract: config.contract, cg_executable: config.cgExecutable, owner_state_directory: config.ownerStateDirectory, allocator: context.session.processAllocator,
            unload_seconds: context.descriptor.idlePolicy.unloadSeconds, stop_seconds: context.descriptor.idlePolicy.stopSeconds, worker: 'shared-executor' };
        await publishOnce(location, spec);
        const saved = record(JSON.parse(await readFile(location, 'utf8')));
        for (const key of ['session_id', 'owner', 'installation_id', 'recipe_revision', 'root', 'media_root', 'input_directory', 'contract', 'environment_path', 'port', 'cg_executable', 'owner_state_directory', 'allocator', 'unload_seconds', 'stop_seconds'])
            if (saved[key] !== spec[key])
                throw new Error('Saved runtime session binding changed');
        if (context.compatibility && saved.allocator !== context.compatibility.allocator)
            throw new Error('Saved process allocator differs from the frozen job');
        return { config, path: location, spec: saved };
    }
    async function control(context, action, body = {}) {
        if (!actions.has(action))
            throw new Error('Unknown owned runtime action');
        const { config, path } = await specification(context);
        return new Promise((done, reject) => {
            const child = spawn(config.python, [config.controller, path, '--control', action], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            let output = '', errors = '';
            const timer = setTimeout(() => { child.kill(); reject(new Error('Runtime control timed out; inspect its recorded identity')); }, 30000);
            child.on('error', error => { clearTimeout(timer); reject(error); });
            child.stdin.on('error', () => { });
            child.stdout.on('data', bytes => { output += String(bytes); if (Buffer.byteLength(output) > 8 * 1024 ** 2) {
                child.kill();
                reject(new Error('Runtime control response exceeds its bound'));
            } });
            child.stderr.on('data', bytes => { errors = (errors + String(bytes)).slice(-4000); });
            child.on('close', code => { clearTimeout(timer); if (code !== 0)
                return reject(new Error(errors || 'Runtime control failed')); try {
                done(JSON.parse(output));
            }
            catch {
                reject(new Error('Runtime control returned an invalid receipt'));
            } });
            child.stdin.end(JSON.stringify(body));
        });
    }
    async function inspectRuntime(context) { return sessionStatus(await control(context, 'inspect')); }
    async function setPendingAdmissions(context, ids) { await control(context, 'pending', { jobs: ids.map(identifier) }); }
    async function prepareRuntime(context) {
        const { spec } = await specification(context);
        if (!await stat(join(String(spec.root), 'state.json')).catch(() => null))
            await control(context, 'launch');
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
            const observed = await inspectRuntime(context);
            if (['ready', 'warm_idle', 'unloaded_idle'].includes(observed.phase))
                return observed;
            if (observed.phase === 'stopped' || (observed.phase === 'needs_inspection' && await stat(join(String(spec.root), 'failure.json')).catch(() => null)))
                throw new Error('Managed session startup failed; inspect its retained receipt');
            await pause(500);
        }
        throw new Error('Runtime readiness timed out; inspect the same session before retry');
    }
    async function releaseRuntime(context) {
        const before = await inspectRuntime(context);
        if (before.phase === 'stopped')
            return before;
        await control(context, 'release');
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            const observed = await inspectRuntime(context);
            if (observed.phase === 'stopped')
                return observed;
            if (observed.phase === 'needs_inspection')
                throw new Error('Owned runtime release needs inspection');
            await pause(500);
        }
        throw new Error('Runtime has not proved GPU release');
    }
    return { specification, control, inspectRuntime, setPendingAdmissions, prepareRuntime, releaseRuntime };
}
