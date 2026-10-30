import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
const ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA = /^[a-f0-9]{64}$/;
export const digest = value => createHash('sha256').update(value).digest('hex');
function record(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
export function portablePath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || /^[a-z]:/i.test(name) || name.includes('\\') || name.split('/').some(part => part === '..' || part === '')) throw new Error(`Invalid portable path: ${name}`);
  const path = resolve(root, name);
  const actual = realpathSync(path), base = realpathSync(root);
  if (relative(base, actual).startsWith('..') || isAbsolute(relative(base, actual))) throw new Error(`File escapes app package: ${name}`);
  return path;
}
export function verifyFile(root, ref) {
  record(ref, 'file reference', ['path', 'sha256']);
  if (!SHA.test(ref.sha256 ?? '')) throw new Error('File reference requires SHA-256');
  const path = portablePath(root, ref.path);
  if (digest(readFileSync(path)) !== ref.sha256) throw new Error(`File digest mismatch: ${ref.path}`);
  return path;
}
export function readAppManifest(path) {
  const root = dirname(resolve(path)), descriptor = JSON.parse(readFileSync(path, 'utf8'));
  record(descriptor, 'app', ['schemaVersion', 'id', 'title', 'components', 'features', 'validation']);
  if (descriptor.schemaVersion !== 2 || !ID.test(descriptor.id ?? '')) throw new Error('Expected a v2 composite app descriptor');
  if (!descriptor.components || !descriptor.features) throw new Error('Components and features are required');
  record(descriptor.components, 'components', Object.keys(descriptor.components));
  for (const [id, c] of Object.entries(descriptor.components)) {
    if (!ID.test(id)) throw new Error(`Invalid component ID: ${id}`);
    record(c, id, ['kind','label','platforms','dependsOn','recipe','python','requirements','source','imports','entrypoints','environment','modelSnapshots','executable','versionPrefix','versionArgs','bundled','extraIndexUrl']);
    if (!['comfygit','python','native'].includes(c.kind)) throw new Error(`Invalid component kind: ${id}`);
    if (!Array.isArray(c.platforms) || !c.platforms.length || c.platforms.some(p => !/^(linux|darwin|win32)-(x64|arm64)$/.test(p))) throw new Error(`Invalid platforms: ${id}`);
    if (c.dependsOn && (!Array.isArray(c.dependsOn) || c.dependsOn.some(v => !ID.test(v)))) throw new Error(`Invalid dependencies: ${id}`);
    if (c.kind === 'comfygit') verifyFile(root, c.recipe);
    if (c.kind === 'python') {
      if (!/^3\.\d+$/.test(c.python ?? '')) throw new Error(`Python major.minor required: ${id}`);
      const requirements = readFileSync(verifyFile(root, c.requirements), 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
      if (!requirements.length || requirements.some(line => !/^[\w.-]+==[^\s;]+$/.test(line) && !/^[\w.-]+ @ git\+https:\/\/.+@[a-f0-9]{40}$/.test(line) && !/^[\w.-]+ @ https:\/\/[^\s]+\.whl#sha256=[a-f0-9]{64}$/.test(line))) throw new Error('Python requirements must pin each version or Git revision');
      if (!Array.isArray(c.imports) || c.imports.some(name => !/^[a-zA-Z_][\w.]*$/.test(name))) throw new Error(`Invalid Python imports: ${id}`);
      if (c.source) {
        record(c.source, 'source', ['url','revision']);
        if (!/^https:\/\//.test(c.source.url ?? '') || !/^[a-f0-9]{40}$/.test(c.source.revision ?? '')) throw new Error('Python source needs HTTPS URL and immutable commit');
      }
      if (c.extraIndexUrl && !/^https:\/\//.test(c.extraIndexUrl)) throw new Error('Package index requires HTTPS');
    }
    if (c.kind === 'native') {
      if(c.versionArgs!==undefined&&(!Array.isArray(c.versionArgs)||!c.versionArgs.length||c.versionArgs.length>8||c.versionArgs.some(arg=>typeof arg!=='string'||arg.length>256||arg.includes('\0'))))throw new Error('Invalid native version arguments');
      if (typeof c.executable !== 'string' || !/^[\w.-]+$/.test(c.executable) || typeof c.versionPrefix !== 'string' || !c.versionPrefix) throw new Error(`Native executable/version required: ${id}`);
      if (c.bundled) verifyFile(root, c.bundled);
    }
    if (c.entrypoints) { record(c.entrypoints, 'entrypoints', Object.keys(c.entrypoints)); for (const [name, ref] of Object.entries(c.entrypoints)) { if (!ID.test(name)) throw new Error('Invalid entrypoint'); verifyFile(root, ref); } }
    if (c.environment) { record(c.environment, 'environment', Object.keys(c.environment)); for (const [key, value] of Object.entries(c.environment)) if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string') throw new Error('Invalid component environment'); }
    if (c.modelSnapshots) {
      const models = JSON.parse(readFileSync(verifyFile(root, c.modelSnapshots), 'utf8'));
      if (!Array.isArray(models)) throw new Error('Model snapshots must be an array');
      for (const model of models) {
        record(model, 'model snapshot', ['repo_id','revision','provider','required_files']);
        if (model.provider !== 'huggingface' || !/^[\w.-]+\/[\w.-]+$/.test(model.repo_id) || !/^[a-f0-9]{40}$/.test(model.revision)) throw new Error('Model snapshots need pinned HF revisions');
        if (!Array.isArray(model.required_files) || !model.required_files.length || model.required_files.some(f => typeof f !== 'string' || f.startsWith('/') || f.includes('\\') || f.split('/').includes('..'))) throw new Error('Invalid required snapshot files');
      }
    }
  }
  const order = [], visiting = new Set(), seen = new Set();
  function visit(id) { if (seen.has(id)) return; if (!descriptor.components[id]) throw new Error(`Unknown component dependency: ${id}`); if (visiting.has(id)) throw new Error(`Component dependency cycle: ${id}`); visiting.add(id); for (const dependency of descriptor.components[id].dependsOn ?? []) visit(dependency); visiting.delete(id); seen.add(id); order.push(id); }
  for (const id of Object.keys(descriptor.components)) visit(id);
  record(descriptor.features, 'features', Object.keys(descriptor.features));
  for (const [id, feature] of Object.entries(descriptor.features)) { record(feature, 'feature', ['label','requires']); if (!ID.test(id) || !Array.isArray(feature.requires) || !feature.requires.length || feature.requires.some(id => !descriptor.components[id])) throw new Error(`Invalid feature: ${id}`); }
  return { descriptor, root, path: resolve(path), order, sha256: digest(readFileSync(path)) };
}
