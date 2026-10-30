import { readFile, mkdir, rename, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { configPath } from "./index.mjs";
import { verifyFile, digest } from "./manifest.mjs";
import { readDesktopLaunch, localDesktopUrl, desktopIdentity, stopDesktopApp } from './desktop-runtime.mjs';

const ID = /^[a-z0-9][a-z0-9-]*$/;
export const desktopRegistryRoot = () =>
  process.env.AKATZ_DESKTOP_REGISTRY || join(dirname(configPath()), "desktop-apps");

export async function readGenerationPackage(root) {
  if (!isAbsolute(root)) throw new Error("Choose an absolute app folder");
  const packageRoot = resolve(root);
  const descriptor = JSON.parse(await readFile(join(packageRoot, "akatz-app.json"), "utf8"));
  const setupPath = join(packageRoot, "executor", "setup.json");
  const bytes = await readFile(setupPath);
  const setup = JSON.parse(bytes);
  if (
    setup.schemaVersion !== 1 ||
    !ID.test(setup.appId) ||
    setup.appId !== descriptor.id ||
    !setup.title?.trim()
  )
    throw new Error("Invalid generation setup package");
  if (
    !Array.isArray(setup.features) ||
    !setup.features.length ||
    setup.features.some((f) => !ID.test(f.id) || !f.label?.trim())
  )
    throw new Error("Declare generation features");
  if (
    !Array.isArray(setup.settingsFields) ||
    setup.settingsFields.some((f) => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(f.key) || !f.label?.trim())
  )
    throw new Error("Invalid generation settings");
  const modulePath = verifyFile(packageRoot, setup.module);
  for (const ref of setup.files || []) verifyFile(packageRoot, ref);
  return { ...setup, packageRoot, modulePath, setupDigest: digest(bytes) };
}

export async function generationManager(root, options = {}) {
  const setup = await readGenerationPackage(root);
  const module = await import(
    pathToFileURL(setup.modulePath).href + "?revision=" + setup.module.sha256
  );
  if (typeof module.createExecutors !== "function")
    throw new Error("App package has no generation setup entrypoint");
  return { setup, manager: module.createExecutors(options) };
}

export function desktopUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Enter the app opening URL without credentials");
  return url.href;
}

export async function planDesktopApp(input) {
  if (!isAbsolute(input.packageRoot)) throw new Error("Choose an absolute app folder");
  const packageRoot = resolve(input.packageRoot);
  const descriptorBytes = await readFile(join(packageRoot, "akatz-app.json"));
  const descriptor = JSON.parse(descriptorBytes);
  if (!ID.test(descriptor.id) || !descriptor.title?.trim())
    throw new Error("The folder needs a valid Akatz app descriptor");
  const hasSetup = await stat(join(packageRoot, "executor", "setup.json"))
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  const setup = hasSetup ? await readGenerationPackage(packageRoot) : null;
  const launch = await readDesktopLaunch(packageRoot);
  if (launch && launch.appId !== descriptor.id) throw new Error('Desktop startup belongs to a different app');
  const url = desktopUrl(input.url || (launch ? `http://127.0.0.1:${launch.defaultPort}/` : ''));
  if (launch) localDesktopUrl(url);
  const launchSettings = {};
  if (input.dataRoot?.trim()) {
    if (!isAbsolute(input.dataRoot)) throw new Error('Choose an absolute app data folder');
    launchSettings.dataRoot = resolve(input.dataRoot);
  }
  const plan = {
    appId: descriptor.id,
    title: setup?.title || descriptor.title,
    packageRoot,
    url,
    descriptorDigest: digest(descriptorBytes),
    setupDigest: setup?.setupDigest || null,
    version: setup?.version || null,
    launchDigest: launch?.digest || null,
    launchSettings,
    description:
      launch ? "Register this app and its verified startup package. Changed settings stop the previous app UI and API. Open starts them when needed. Generation resources are set up separately." : "Add this existing app to this computer’s library. Start its server independently before opening it.",
    writes: [join(desktopRegistryRoot(), descriptor.id + ".json"), ...(launchSettings.dataRoot ? [launchSettings.dataRoot] : [])],
    downloads: [],
  };
  return { ...plan, digest: digest(JSON.stringify(plan)) };
}

export async function registerDesktopApp(plan, confirmation) {
  const { digest: expected, ...body } = plan;
  if (expected !== confirmation || digest(JSON.stringify(body)) !== expected)
    throw new Error("App registration differs from the reviewed plan");
  const current = await planDesktopApp({ packageRoot: plan.packageRoot, url: plan.url, dataRoot: plan.launchSettings?.dataRoot });
  if (
    current.appId !== plan.appId ||
    current.setupDigest !== plan.setupDigest ||
    current.descriptorDigest !== plan.descriptorDigest
    || current.launchDigest !== plan.launchDigest
  )
    throw new Error("App package changed; review it again");
  desktopUrl(plan.url);
  const root = desktopRegistryRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = join(root, plan.appId + ".json"),
    temporary = file + "." + randomUUID() + ".tmp";
  const record = {
    schemaVersion: 1,
    appId: plan.appId,
    title: plan.title,
    packageRoot: plan.packageRoot,
    url: plan.url,
    version: plan.version,
    launchDigest: plan.launchDigest,
    launchSettings: plan.launchSettings,
    registeredAt: new Date().toISOString(),
  };
  let previous;
  try { previous = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.launchDigest && (previous.url !== record.url || desktopIdentity(previous) !== desktopIdentity(record)))
    await stopDesktopApp(previous);
  await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
  return record;
}

export async function listDesktopApps() {
  const root = desktopRegistryRoot();
  let names;
  try {
    names = await readdir(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    names
      .filter((name) => /^[a-z0-9][a-z0-9-]*\.json$/.test(name))
      .sort()
      .map(async (name) => {
        const record = JSON.parse(await readFile(join(root, name), "utf8"));
        if (record.schemaVersion !== 1 || name !== record.appId + ".json")
          throw new Error("Invalid desktop app registration");
        desktopUrl(record.url);
        const available = await stat(join(record.packageRoot, "akatz-app.json"))
          .then((info) => info.isFile())
          .catch(() => false);
        return {
          ...record,
          available,
          ...(!available ? { problem: "The local app folder is unavailable." } : {}),
        };
      }),
  );
}
