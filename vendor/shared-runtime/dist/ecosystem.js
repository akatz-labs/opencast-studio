/** Stable per-user storage; installations reference immutable runtime revisions. */
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { configPath, ecosystemDataRoot, modelStorageRoot, resolveAppConfig } from '../src/index.mjs';
import { storagePaths } from '../src/storage.mjs';
import { mediaConfig } from '../src/media.mjs';
const idPattern = /^[a-z0-9][a-z0-9-]{0,159}$/;
function appId(value) { if (!idPattern.test(value))
    throw Error('Invalid app ID'); return value; }
function absolute(value) { return typeof value === 'string' && isAbsolute(value) && !/[\0\r\n]/.test(value); }
export async function ecosystemPaths(id, options = {}) {
    appId(id);
    const dataRoot = ecosystemDataRoot(options), configRoot = dirname(configPath(options));
    const configured = resolveAppConfig(id, {}, options);
    const modelsRoot = modelStorageRoot(options), media = await mediaConfig(options);
    return { schemaVersion: 1, dataRoot, configRoot,
        appRoot: configured.dataRoot || storagePaths(id, options).root, modelsRoot,
        huggingFaceCache: join(modelsRoot, 'huggingface', 'hub'), mediaRoot: media.root, mediaUrl: media.url,
        cacheRoot: join(dataRoot, 'cache'), toolsRoot: join(dataRoot, 'tools'),
        runtimesRoot: join(dataRoot, 'runtimes', id), executorRoot: storagePaths('executor', options).root,
        installationFile: join(configRoot, 'installations', id + '.json') };
}
function installation(value, id) {
    if (!value || typeof value !== 'object')
        throw Error('Invalid saved installation');
    const r = value;
    if (r.schemaVersion !== 1 || r.appId !== id || typeof r.revision !== 'string' || !/^[a-f0-9]{64}$/.test(r.revision) ||
        !absolute(r.root) || !absolute(r.modelsRoot) || !Number.isInteger(r.executorPort) || Number(r.executorPort) < 1 || Number(r.executorPort) > 65535 ||
        Object.keys(r).some(k => !['schemaVersion', 'appId', 'revision', 'root', 'modelsRoot', 'executorPort'].includes(k)))
        throw Error('Invalid saved installation');
    return r;
}
export async function readInstallation(id, options = {}) {
    const path = (await ecosystemPaths(id, options)).installationFile;
    try {
        return installation(JSON.parse(await readFile(path, 'utf8')), id);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
/** Call only after setup has completed. A changed pointer requires a new review. */
export async function saveInstallation(value, expected, options = {}) {
    installation(value, value.appId);
    const path = (await ecosystemPaths(value.appId, options)).installationFile;
    await mkdir(dirname(path), { recursive: true });
    const lock = path + '.lock';
    let handle;
    try {
        handle = await import('node:fs/promises').then(fs => fs.open(lock, 'wx', 0o600));
    }
    catch (error) {
        if (error.code === 'EEXIST')
            throw Error('Installation selection is being changed; retry after setup finishes');
        throw error;
    }
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
        const current = await readInstallation(value.appId, options);
        if (JSON.stringify(current) !== JSON.stringify(expected))
            throw Error('Installation selection changed during setup; existing selection preserved');
        await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
    }
    finally {
        await unlink(temporary).catch(() => { });
        await handle.close();
        await unlink(lock);
    }
    return value;
}
/** Cache paths follow the Hugging Face index; no parallel model catalog is created. */
export function huggingFaceSnapshot(cache, repo, revision) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) || !/^[a-f0-9]{40}$/.test(revision))
        throw Error('Use a pinned Hugging Face model identity');
    return join(resolve(cache), 'models--' + repo.replace('/', '--'), 'snapshots', revision);
}
