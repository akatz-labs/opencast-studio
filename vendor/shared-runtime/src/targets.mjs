import { readFileSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { spawn } from "node:child_process";
import { digest } from "./manifest.mjs";

const BRIDGE = readFileSync(new URL("./comfygit-target.py", import.meta.url), "utf8");
const MAX_OUTPUT = 16 * 1024 * 1024;
const TARGET_FIELDS = new Set([
  "id",
  "name",
  "kind",
  "host",
  "port",
  "workspace",
  "modelsRoot",
  "libraryRoot",
  "pythonExecutable",
]);
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export function validateTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target))
    throw new Error("Select an execution target");
  for (const key of Object.keys(target))
    if (!TARGET_FIELDS.has(key)) throw new Error(`Unknown target setting: ${key}`);
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(target.id ?? "") ||
    typeof target.name !== "string" ||
    !target.name.trim()
  )
    throw new Error("Target needs an ID and name");
  if (!["local", "ssh"].includes(target.kind)) throw new Error("Target must be local or SSH");
  const absolute = target.kind === "ssh" ? posix.isAbsolute : isAbsolute;
  for (const key of ["workspace", "libraryRoot"])
    if (typeof target[key] !== "string" || !absolute(target[key]) || /[\0\r\n]/.test(target[key]))
      throw new Error(`${key} must be an absolute path on the execution target`);
  if (target.modelsRoot && (!absolute(target.modelsRoot) || /[\0\r\n]/.test(target.modelsRoot)))
    throw new Error("modelsRoot must be an absolute target path");
  if (
    typeof target.pythonExecutable !== "string" ||
    !absolute(target.pythonExecutable) ||
    /[\0\r\n]/.test(target.pythonExecutable)
  )
    throw new Error("Select the absolute path of a ComfyGit Python interpreter");
  if (target.kind === "ssh") {
    if (
      typeof target.host !== "string" ||
      !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(target.host)
    )
      throw new Error("Enter an SSH host alias or user@hostname");
    if (
      target.port !== undefined &&
      (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)
    )
      throw new Error("SSH port must be between 1 and 65535");
  }
  return { ...target };
}

export function targetInvocation(target) {
  validateTarget(target);
  if (target.kind === "local") return { command: target.pythonExecutable, args: ["-c", BRIDGE] };
  return {
    command: "ssh",
    args: [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      ...(target.port ? ["-p", String(target.port)] : []),
      "--",
      target.host,
      `${shellQuote(target.pythonExecutable)} -c ${shellQuote(BRIDGE)}`,
    ],
  };
}

export function executeTarget(target, request, { signal, timeout = 120000 } = {}) {
  const invocation = targetInvocation(target);
  if (signal?.aborted) return Promise.reject(new Error("Inspection cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      errors = "",
      failure,
      killTimer;
    const stop = (message) => {
      failure ??= new Error(message);
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 3000);
      killTimer.unref();
    };
    const abort = () => stop("Inspection cancelled");
    const timer = setTimeout(() => stop("Target inspection timed out"), timeout);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data) => {
      if (output.length + data.length > MAX_OUTPUT)
        return stop("Target inventory exceeds the output limit");
      output += data.toString();
    });
    child.stderr.on("data", (data) => {
      errors = (errors + data.toString()).slice(-8000);
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.stdin.on("error", () => {}); // Process failure is reported by close.
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      let result;
      try {
        result = JSON.parse(output);
      } catch {
        return reject(new Error(errors.trim() || "Target did not return a ComfyGit inventory"));
      }
      if (code !== 0 || result.error)
        return reject(new Error(result.error || errors.trim() || "Target inspection failed"));
      resolve(result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function buildReusePlan(target, snapshot) {
  validateTarget(target);
  const inventory = snapshot.inventory;
  if (
    snapshot.schemaVersion !== 1 ||
    inventory?.schema_version !== 2 ||
    inventory.kind !== "workspace_inventory" ||
    !Array.isArray(inventory.models) ||
    !Array.isArray(inventory.environments) ||
    !Array.isArray(snapshot.analyses)
  )
    throw new Error("Unsupported ComfyGit inventory contract");
  if (inventory.workspace_path !== target.workspace)
    throw new Error("Target returned another workspace");
  const warnings = [];
  if (target.modelsRoot && target.modelsRoot !== inventory.models_directory)
    warnings.push(
      "The requested model folder differs from this workspace. Inspection uses the existing workspace folder; changing it requires an explicit storage operation.",
    );
  const indexed = new Map(inventory.models.map((model) => [model.short_hash, model]));
  const apps = snapshot.analyses.map((analysis) => {
    const models = analysis.models.map((required) => {
      const match = indexed.get(required.hash);
      const usable = (match?.locations ?? []).filter(
        (location) =>
          location.present &&
          !location.changed &&
          location.observation_state === "present" &&
          location.independently_usable &&
          (required.size == null || location.observed_size === required.size),
      );
      const sizeMatches = required.size == null || match?.file_size === required.size;
      const action =
        usable.length && sizeMatches
          ? "reuse"
          : required.expected_path_present || match?.locations.some((location) => location.present)
            ? "verify"
            : required.sources.length
              ? "download"
              : "missing-source";
      return {
        hash: required.hash,
        filename: required.filename,
        relativePath: required.relative_path,
        sizeBytes: required.size,
        action,
        locations: usable.map((location) => ({
          root: location.base_directory,
          path: location.relative_path,
        })),
        identityEvidence:
          action === "reuse" ? "ComfyGit indexed identity and unchanged observed file" : null,
      };
    });
    const withAction = (action) => models.filter((model) => model.action === action);
    return {
      id: analysis.id,
      recipeSha256: analysis.recipeSha256,
      nodeCount: analysis.nodeCount,
      workflowCount: analysis.workflowCount,
      models,
      reuseCount: withAction("reuse").length,
      reuseBytes: withAction("reuse").reduce((sum, model) => sum + (model.sizeBytes ?? 0), 0),
      downloadCount: withAction("download").length,
      downloadBytes: withAction("download").reduce((sum, model) => sum + (model.sizeBytes ?? 0), 0),
      unknownDownloadSizes: withAction("download").filter((model) => model.sizeBytes == null)
        .length,
      verificationCount: withAction("verify").length,
      blockedCount: withAction("missing-source").length,
    };
  });
  return {
    schemaVersion: 1,
    planId: digest(JSON.stringify({ target, snapshot })),
    observedAt: inventory.observed_at,
    coreVersion: snapshot.coreVersion,
    targetId: target.id,
    workspace: inventory.workspace_path,
    modelsRoot: inventory.models_directory,
    indexedModelCount: inventory.models.length,
    indexedModelBytes: inventory.models.reduce((sum, model) => sum + model.file_size, 0),
    environments: inventory.environments.map((environment) => ({
      name: environment.name,
      complete: environment.complete,
      manifestSha256: environment.manifest_sha256,
    })),
    apps,
    warnings,
    runtimeDownloadBytes: null,
  };
}

export async function inspectTarget(target, recipes, options = {}) {
  for (const recipe of recipes)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(recipe.id) || digest(recipe.manifest) !== recipe.sha256)
      throw new Error("Catalog recipe digest mismatch");
  const snapshot = await executeTarget(target, { workspace: target.workspace, recipes }, options);
  return buildReusePlan(target, snapshot);
}
