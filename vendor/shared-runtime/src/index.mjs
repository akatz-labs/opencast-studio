import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const FIELDS = new Set(['workspace', 'environment', 'dataRoot', 'serveUrl', 'comfyUrl', 'apiUrl', 'runtimeRoot', 'modelCache', 'components']);
const ENV_FIELDS = { workspace: 'COMFYGIT_HOME', environment: 'COMFYGIT_ENVIRONMENT', dataRoot: 'STUDIO_DATA_ROOT', serveUrl: 'COMFYGIT_SERVE_URL', comfyUrl: 'COMFY_BASE_URL', apiUrl: 'ASSET_STUDIO_API_URL' };
const PATH_FIELDS = new Set(['workspace', 'dataRoot', 'runtimeRoot', 'modelCache']);
const URL_FIELDS = new Set(['serveUrl', 'comfyUrl', 'apiUrl']);
const ID = /^[a-z0-9][a-z0-9-]*$/;
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function fields(value, label) {
  object(value, label);
  for (const [key, item] of Object.entries(value)) {
    if (!FIELDS.has(key)) throw new Error(`Unknown ${label} setting: ${key}`);
    if (key === 'components') {
      object(item, `${label}.components`);
      for (const [id, selection] of Object.entries(item)) {
        if (!ID.test(id)) throw new Error('Invalid component selection ID');
        object(selection, `component ${id}`);
        for (const [field, path] of Object.entries(selection)) {
          if (!['executable', 'sourceRoot', 'workRoot', 'modelCache'].includes(field) || typeof path !== 'string' || !isAbsolute(path)) throw new Error(`Component ${id}.${field} requires an absolute local path`);
        }
      }
      continue;
    }
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${label}.${key} must be a nonempty string`);
    if (PATH_FIELDS.has(key) && !isAbsolute(item)) throw new Error(`${label}.${key} must be an absolute path`);
    if (key === 'environment' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item)) throw new Error(`${label}.environment is invalid`);
    if (URL_FIELDS.has(key)) {
      const url = new URL(item);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`${label}.${key} must be an HTTP service origin without credentials`);
    }
  }
  return value;
}
export function configPath({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.AKATZ_CONFIG) {
    if (!isAbsolute(env.AKATZ_CONFIG)) throw new Error('AKATZ_CONFIG must be an absolute path');
    return env.AKATZ_CONFIG;
  }
  const base = platform === 'win32' ? (env.APPDATA || join(home, 'AppData', 'Roaming')) : platform === 'darwin' ? join(home, 'Library', 'Application Support') : (env.XDG_CONFIG_HOME || join(home, '.config'));
  return join(base, 'akatz', 'apps.json');
}
export function readConfig(options = {}) {
  const path = configPath(options);
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && !(options.env ?? process.env).AKATZ_CONFIG) return { path, config: { schemaVersion: 1, defaults: {}, apps: {} }, exists: false };
    throw new Error(`Cannot read Akatz configuration at ${path}: ${error.message}`);
  }
  object(config, 'config');
  if (config.schemaVersion !== 1) throw new Error('Unsupported Akatz configuration schemaVersion');
  for (const key of Object.keys(config)) if (!['schemaVersion', 'defaults', 'apps'].includes(key)) throw new Error(`Unknown config field: ${key}`);
  fields(config.defaults ?? {}, 'defaults');
  if (config.defaults?.environment || config.defaults?.dataRoot || config.defaults?.apiUrl || config.defaults?.components) throw new Error('environment, dataRoot, and apiUrl must be app-specific');
  object(config.apps ?? {}, 'apps');
  for (const [id, value] of Object.entries(config.apps ?? {})) {
    if (!ID.test(id)) throw new Error(`Invalid app ID: ${id}`);
    fields(value, `apps.${id}`);
  }
  return { path, config, exists: true };
}
export function resolveAppConfig(appId, defaults = {}, options = {}) {
  if (!ID.test(appId)) throw new Error('Invalid app ID');
  const env = options.env ?? process.env;
  const loaded = readConfig(options);
  // Callers may retain relative legacy data defaults; the shared file requires absolute paths.
  const values = { ...defaults };
  const sources = Object.fromEntries(Object.keys(defaults).map(key => [key, 'app-default']));
  for (const [source, overrides] of [['shared-default', loaded.config.defaults ?? {}], ['app-config', loaded.config.apps?.[appId] ?? {}], ['environment', Object.fromEntries(Object.entries(ENV_FIELDS).filter(([, name]) => env[name]?.trim()).map(([key, name]) => [key, env[name]]))]]) {
    for (const [key, value] of Object.entries(overrides)) { values[key] = key === 'components' ? Object.fromEntries([...new Set([...Object.keys(values.components ?? {}), ...Object.keys(value)])].map(id => [id, { ...values.components?.[id], ...value[id] }])) : value; sources[key] = source; }
  }
  for (const key of PATH_FIELDS) if (values[key]) values[key] = resolve(values[key]);
  fields(values, 'resolved');
  for (const key of URL_FIELDS) if (values[key]) values[key] = new URL(values[key]).origin;
  const environmentRoot = values.workspace && values.environment ? join(values.workspace, 'environments', values.environment) : null;
  return { appId, configPath: loaded.path, configured: loaded.exists, ...values, environmentRoot, sources };
}
export function verifyRecipe(descriptorPath) {
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  if (descriptor.schemaVersion !== 1 || !ID.test(descriptor.id ?? '') || descriptor.runtime !== 'comfygit') throw new Error('Invalid Akatz app descriptor');
  const recipe = object(descriptor.recipe, 'recipe');
  if (typeof recipe.path !== 'string' || isAbsolute(recipe.path) || recipe.path.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(recipe.sha256 ?? '')) throw new Error('Recipe must have a relative path and SHA-256');
  const path = resolve(dirname(descriptorPath), recipe.path);
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== recipe.sha256) throw new Error(`Recipe digest mismatch for ${descriptor.id}`);
  return { descriptor, recipePath: path, sha256: actual };
}
export async function inspectInstallation(config, { command = 'cg', run = execute } = {}) {
  if (!config.workspace || !config.environment) throw new Error('Select a ComfyGit workspace and app environment before inspection');
  if (!existsSync(join(config.workspace, '.metadata', 'workspace.json'))) throw new Error(`ComfyGit workspace is not initialized: ${config.workspace}`);
  const { stdout } = await run(command, ['inventory', '--json'], { env: { ...process.env, COMFYGIT_HOME: config.workspace }, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  const inventory = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (resolve(inventory.workspace_path) !== resolve(config.workspace)) throw new Error('ComfyGit returned a different workspace');
  const environment = inventory.environments.find(item => item.name === config.environment);
  return { workspace: inventory.workspace_path, modelsDirectory: inventory.models_directory, environment: environment ?? null, installed: Boolean(environment), candidates: inventory.environments.map(item => item.name) };
}

export function appDataRoot({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const base = platform === 'win32' ? (env.LOCALAPPDATA || join(home, 'AppData', 'Local')) : platform === 'darwin' ? join(home, 'Library', 'Application Support') : (env.XDG_DATA_HOME || join(home, '.local', 'share'));
  return join(base, 'akatz');
}

/** Shared namespace, with configuration overrides applied once for every consumer. */
export function ecosystemDataRoot(options = {}) {
  const env = options.env ?? process.env;
  let config = {};
  try { config = JSON.parse(readFileSync(join(dirname(configPath(options)), 'storage.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  object(config, 'storage');
  if (Object.keys(config).some(key => !['schemaVersion', 'root'].includes(key)) ||
      (config.schemaVersion !== undefined && config.schemaVersion !== 1) ||
      (config.root !== undefined && (typeof config.root !== 'string' || !isAbsolute(config.root))))
    throw new Error('Invalid shared storage configuration');
  const root = env.AKATZ_DATA_ROOT || config.root || appDataRoot(options);
  if (!isAbsolute(root) || /[\0\r\n]/.test(root)) throw new Error('Shared data root must be an absolute path');
  return resolve(root);
}

/** Machine-wide model bytes, separate from app databases, media and runtimes. */
export function modelStorageRoot(options = {}) {
  const env = options.env ?? process.env;
  let config = {};
  try { config = JSON.parse(readFileSync(join(dirname(configPath(options)), 'models.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  object(config, 'models');
  if (Object.keys(config).some(key => !['schemaVersion', 'root'].includes(key)) ||
      (config.schemaVersion !== undefined && config.schemaVersion !== 1) ||
      (config.root !== undefined && (typeof config.root !== 'string' || !config.root.trim() || !isAbsolute(config.root))))
    throw new Error('Invalid shared model storage configuration');
  const root = env.AKATZ_MODELS_ROOT || config.root || options.fallback || join(ecosystemDataRoot(options), 'models');
  if (typeof root !== 'string' || !isAbsolute(root) || /[\0\r\n]/.test(root)) throw new Error('Model root must be an absolute path');
  return resolve(root);
}
