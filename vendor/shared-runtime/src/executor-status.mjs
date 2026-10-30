import { DirectoryUsage } from './executor-directory-usage.mjs';
import { statfs, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function disk(path) {
  let existing = path;
  while (!(await stat(existing).catch(() => null))) {
    const parent = dirname(existing);
    if (parent === existing) return { path, measured: false };
    existing = parent;
  }
  try {
    const fs = await statfs(existing);
    return {
      path,
      measured: true,
      capacityBytes: fs.blocks * fs.bsize,
      availableBytes: fs.bavail * fs.bsize,
    };
  } catch {
    return { path, measured: false };
  }
}

export async function executorStatus(executor) {
  let gpus = [],
    gpuError = null;
  try {
    const { stdout } = await execute(
      "nvidia-smi",
      [
        "--query-gpu=name,memory.total,memory.used,utilization.gpu",
        "--format=csv,noheader,nounits",
      ],
      { windowsHide: true, timeout: 5000, maxBuffer: 64000 },
    );
    gpus = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, total, used, utilization] = line.split(",").map((v) => v.trim());
        return {
          name,
          memoryBytes: Number(total) * 1024 ** 2,
          usedMemoryBytes: Number(used) * 1024 ** 2,
          utilization: Number(utilization),
        };
      });
  } catch {
    gpuError = "GPU measurements are unavailable on this machine.";
  }
  let gpuCompute=[];
  try {
    const {stdout}=await execute('nvidia-smi',['--query-compute-apps=pid,process_name,used_memory','--format=csv,noheader,nounits'],{windowsHide:true,timeout:5000,maxBuffer:64000});
    gpuCompute=stdout.trim().split('\n').filter(Boolean).map(line=>{const [pid,name,memory]=line.split(',').map(v=>v.trim());return {pid:Number(pid),process:name,usedMemoryBytes:Number(memory)*1024**2};});
  } catch { /* Missing telemetry never establishes a free GPU. */ }
  const installations = executor.installations();
  const paths = [
    ...new Set([
      executor.storage.paths.dataRoot,
      ...installations.flatMap((i) => i.setup?.writes || []),
    ]),
  ];
  executor.directoryUsage ||= new DirectoryUsage();
  const usage = executor.directoryUsage.snapshot(paths);
  const modelFiles = [
    ...new Map(
      installations
        .flatMap((i) => i.probes.filter((p) => p.kind === "file" && p.modelHash))
        .map((p) => [p.path, p]),
    ).values(),
  ];
  const jobs = executor
    .pendingJobs()
    .filter((j) => !TERMINAL.has(j.phase))
    .map((j) => ({
      id: j.id,
      appId: j.appId,
      kind: j.kind || "generation",
      phase: j.phase,
      activity: j.activity,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      error: j.error,
    }));
  const sessions=[];
  for(const session of executor.sessions.records()) {
    try {
      const status=session.status?.phase==='stopped'?session.status:await executor.sessions.inspect(session);
      sessions.push({id:session.id,installationId:session.installationId,status});
    } catch(error) {
      sessions.push({id:session.id,installationId:session.installationId,status:session.status,error:error.message});
    }
  }
  return {
    executorId: executor.identity,
    sessions,
    memory: executor.memory.status(),
    hostname: hostname(),
    platform: process.platform,
    home: homedir(),
    checkedAt: new Date().toISOString(),
    gpus,
    gpuCompute,
    externalGpuCompute:gpuCompute.filter(p=>!sessions.some(s=>s.status?.processIdentity?.pid===p.pid)),
    gpuError,
    disks: await Promise.all(paths.map(async (path,index)=>({...await disk(path), usage:usage[index]}))),
    jobs,
    models: {
      declaredFiles: modelFiles.length,
      declaredBytes: modelFiles.reduce((sum, p) => sum + (p.expectedSize || 0), 0),
      paths: [...new Set(modelFiles.map((p) => dirname(p.path)))],
    },
  };
}
