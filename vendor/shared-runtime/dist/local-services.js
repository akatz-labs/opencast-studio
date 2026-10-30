/** Start or discover the existing shared services, never an app-owned substitute. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, open, rename, rm, stat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ecosystemPaths } from './ecosystem.js';
import { captureProcessIdentity, processAlive } from './process-identity.js';
const execute = promisify(execFile);
const pause = (ms) => new Promise(done => setTimeout(done, ms));
const errorCode = (error) => error?.code;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function record(value) { if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid service response'); return value; }
async function canonical(path) { try {
    return await realpath(path);
}
catch (error) {
    if (errorCode(error) === 'ENOENT')
        return resolve(path);
    throw error;
} }
async function health(kind, url, root, capabilities) {
    let response;
    try {
        response = await fetch(url + (kind === 'media' ? '/v1/health' : '/v1/health'), { signal: AbortSignal.timeout(1500) });
    }
    catch (error) {
        if (errorCode(error.cause) === 'ECONNREFUSED')
            return null;
        throw Error('Cannot verify the existing ' + kind + ' service; no replacement was started', { cause: error });
    }
    if (!response.ok)
        throw Error('The configured ' + kind + ' endpoint is occupied or unhealthy; no replacement was started');
    const value = record(await response.json()), id = value[kind === 'media' ? 'libraryId' : 'executorId'], available = value.capabilities;
    if (value.apiVersion !== 1 || typeof id !== 'string' || !id || !Array.isArray(available) || !capabilities.every(c => available.includes(c)))
        throw Error('The existing ' + kind + ' service is incompatible; preserve it and review an update');
    if (typeof value.storageRoot === 'string') {
        if (await canonical(value.storageRoot) !== await canonical(root))
            throw Error('The existing ' + kind + ' service uses a different storage root; preserve its configuration');
    }
    else {
        // Earlier compatible releases did not expose a root. Match their durable identity.
        let expected;
        try {
            if (kind === 'executor')
                expected = record(JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'))).instanceId;
            else {
                const db = new DatabaseSync(join(root, 'catalog.sqlite'), { readOnly: true });
                try {
                    expected = db.prepare('SELECT id FROM library').get()?.id;
                }
                finally {
                    db.close();
                }
            }
        }
        catch {
            throw Error('Cannot prove the existing ' + kind + ' service owns the configured storage root');
        }
        if (expected !== id)
            throw Error('The existing ' + kind + ' service identity differs from the configured storage root');
    }
    return id;
}
async function lock(path) {
    const owner = captureProcessIdentity(process.pid);
    if (!owner)
        throw Error('Shared service startup currently requires qualified Linux process ownership');
    const token = randomUUID(), body = JSON.stringify({ owner, token });
    await mkdir(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            await mkdir(path);
            await writeFile(join(path, 'owner.json'), body, { flag: 'wx', mode: 0o600 });
            return async () => { if (await readFile(join(path, 'owner.json'), 'utf8') === body)
                await rm(path, { recursive: true }); };
        }
        catch (error) {
            if (errorCode(error) !== 'EEXIST')
                throw error;
        }
        try {
            const previous = await readFile(join(path, 'owner.json'), 'utf8'), v = record(JSON.parse(previous)), p = record(v.owner);
            if (p.platform !== 'linux' || typeof p.pid !== 'number' || typeof p.start !== 'string' || typeof p.boot !== 'string')
                throw Error('Ambiguous service startup lock');
            if (!processAlive(p) && await readFile(join(path, 'owner.json'), 'utf8') === previous) {
                await rm(path, { recursive: true });
                continue;
            }
        }
        catch (error) {
            if (errorCode(error) !== 'ENOENT')
                throw error;
        }
        await pause(100);
    }
    throw Error('Another shared service startup is still in progress');
}
async function stagePackage(toolsRoot) {
    // Runtime bridge to the existing JS packer avoids a declaration cycle through dist/.
    const { bootstrapPlan } = await import(new URL('../src/executor-bootstrap.mjs', import.meta.url).href);
    const plan = await bootstrapPlan();
    const directory = join(toolsRoot, 'app-config', plan.bundleDigest);
    async function verify() { for (const file of plan.files) {
        if (hash(await readFile(join(directory, file.name))) !== hash(Buffer.from(file.body, 'base64')))
            throw Error('Installed shared service code changed; existing files were preserved');
    } }
    try {
        await stat(directory);
        await verify();
        return { directory, digest: plan.bundleDigest };
    }
    catch (error) {
        if (errorCode(error) !== 'ENOENT')
            throw error;
    }
    await mkdir(dirname(directory), { recursive: true });
    const temporary = directory + '.' + randomUUID();
    await mkdir(temporary);
    try {
        for (const file of plan.files) {
            if (!/^(?:(?:src|dist)\/)?[a-zA-Z0-9._-]+$/.test(file.name) || file.name.split('/').includes('..'))
                throw Error('Unsafe shared package member');
            const target = join(temporary, file.name);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, Buffer.from(file.body, 'base64'), { flag: 'wx', mode: 0o600 });
        }
        try {
            await rename(temporary, directory);
        }
        catch (error) {
            if (!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error) || ''))
                throw error;
        }
        await verify();
        return { directory, digest: plan.bundleDigest };
    }
    finally {
        await rm(temporary, { recursive: true, force: true });
    }
}
async function ensure(kind, options = {}) {
    if ((options.platform || process.platform) !== 'linux' || process.platform !== 'linux')
        throw Error('Shared local service startup is currently qualified on Linux only');
    const paths = await ecosystemPaths('services', options), root = kind === 'media' ? paths.mediaRoot : paths.executorRoot;
    const port = options.port ?? Number((options.env || process.env).AKATZ_EXECUTOR_PORT || 8841);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw Error('Invalid executor port');
    const url = kind === 'media' ? paths.mediaUrl : 'http://127.0.0.1:' + port;
    const capabilities = options.requiredCapabilities || (kind === 'media' ? ['app-registry', 'project-registry', 'mp4'] : []);
    const directory = join(paths.dataRoot, 'services'), receiptPath = join(directory, kind + '.json');
    async function observed(id, reused) {
        let process = null;
        try {
            const value = record(JSON.parse(await readFile(receiptPath, 'utf8')));
            if (value.id === id && value.url === url && value.root === root)
                process = value.process;
        }
        catch (error) {
            if (errorCode(error) !== 'ENOENT')
                throw error;
        }
        return { kind, url, root, id, reused, process };
    }
    const initial = await health(kind, url, root, capabilities);
    if (initial)
        return observed(initial, true);
    const release = await lock(join(directory, kind + '.bootstrap.lock'));
    try {
        const existing = await health(kind, url, root, capabilities);
        if (existing)
            return observed(existing, true);
        // A live service may be starting or bound elsewhere. Never steal its state.
        try {
            const old = record(JSON.parse(await readFile(receiptPath, 'utf8')));
            if (old.process && processAlive(old.process))
                throw Error('The shared ' + kind + ' service process is alive but unavailable; inspect its log');
        }
        catch (error) {
            if (errorCode(error) !== 'ENOENT')
                throw error;
        }
        const bundle = await stagePackage(paths.toolsRoot), logPath = join(directory, kind + '.log');
        const env = { ...process.env, ...options.env, AKATZ_DATA_ROOT: paths.dataRoot,
            AKATZ_EXECUTOR_ROOT: root, AKATZ_EXECUTOR_PORT: String(port), AKATZ_EXECUTOR_BUNDLE_DIGEST: bundle.digest,
            AKATZ_MEDIA_ROOT: paths.mediaRoot, AKATZ_MEDIA_URL: paths.mediaUrl };
        let child = null, pid, unit = null, failure;
        let userManager = false;
        try {
            const result = await execute('systemctl', ['--user', 'show', '--property=Version', '--value'], { timeout: 3000 });
            userManager = Boolean(result.stdout.trim());
        }
        catch { }
        if (userManager) {
            // Detaching a process does not escape the app's systemd cgroup. Give shared
            // services their own transient units so stopping an app cannot kill them.
            unit = 'akatz-' + kind + '-' + hash(root + '|' + url).slice(0, 16) + '.service';
            const names = ['PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'AKATZ_CONFIG', 'AKATZ_MODELS_ROOT',
                'AKATZ_DATA_ROOT', 'AKATZ_EXECUTOR_ROOT', 'AKATZ_EXECUTOR_PORT', 'AKATZ_EXECUTOR_BUNDLE_DIGEST',
                'AKATZ_MEDIA_ROOT', 'AKATZ_MEDIA_URL'];
            const environment = env;
            const arguments_ = ['--user', '--quiet', '--collect', '--service-type=exec', '--unit=' + unit,
                '--property=WorkingDirectory=' + bundle.directory, '--property=StandardOutput=append:' + logPath,
                '--property=StandardError=append:' + logPath,
                ...names.flatMap(name => environment[name] === undefined ? [] : ['--setenv=' + name + '=' + environment[name]]),
                process.execPath, join(bundle.directory, 'src', kind + '-server.mjs')];
            await execute('systemd-run', arguments_, { timeout: 10000 });
            const result = await execute('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'], { timeout: 3000 });
            pid = Number(result.stdout.trim());
            if (!Number.isInteger(pid) || pid < 1)
                throw Error('Shared service did not acquire a systemd process owner; inspect ' + logPath);
        }
        else {
            const log = await open(logPath, 'a', 0o600);
            try {
                child = spawn(process.execPath, [join(bundle.directory, 'src', kind + '-server.mjs')], { cwd: bundle.directory, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
                child.once('error', error => { failure = error; });
                child.unref();
                pid = child.pid;
            }
            finally {
                await log.close();
            }
        }
        let processIdentity = pid ? captureProcessIdentity(pid) : null;
        for (let attempt = 0; attempt < 100; attempt++) {
            if (failure)
                throw failure;
            if ((child && (child.exitCode !== null || child.signalCode !== null)) || (!child && processIdentity && !processAlive(processIdentity)))
                throw Error('Shared ' + kind + ' service exited; inspect ' + join(directory, kind + '.log'));
            const id = await health(kind, url, root, capabilities);
            if (id) {
                processIdentity = pid ? captureProcessIdentity(pid) : null;
                if (!processIdentity)
                    throw Error('Cannot verify the shared service process owner; inspect its log');
                const receipt = { schemaVersion: 1, kind, url, root, id, process: processIdentity, packageDigest: bundle.digest, unit };
                const temporary = receiptPath + '.' + randomUUID();
                await writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
                await rename(temporary, receiptPath);
                return { ...receipt, reused: false };
            }
            await pause(100);
        }
        throw Error('Shared ' + kind + ' startup did not finish; inspect its log before retrying');
    }
    finally {
        await release();
    }
}
export const ensureSharedMedia = (options = {}) => ensure('media', options);
export const ensureSharedExecutor = (options = {}) => ensure('executor', options);
