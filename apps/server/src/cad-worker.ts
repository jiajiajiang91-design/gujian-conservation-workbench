import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pythonPath = resolve(projectRoot, "workers/cad/.venv/Scripts/python.exe");
const stagingRoot = resolve(projectRoot, "apps/server/.data/cad-staging");

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface CadWorkerResult {
  geometryRevisionId: string;
  geometrySignature: string;
  manifestHash: string;
  outputDirectory: string;
}

export interface CadWorkerRun {
  process: ChildProcess;
  result: Promise<CadWorkerResult>;
}

export interface CadWorker {
  start(input: { jobId: string; geometrySpec: unknown }): CadWorkerRun;
  readAsset(jobId: string, fileName: string): Buffer;
}

export class PythonCadWorker implements CadWorker {
  start(input: { jobId: string; geometrySpec: unknown }): CadWorkerRun {
    const jobDirectory = resolve(stagingRoot, input.jobId);
    if (dirname(jobDirectory) !== stagingRoot) throw new Error("CAD_JOB_PATH_INVALID");
    const inputPath = resolve(jobDirectory, "input", "geometry-spec.json");
    const outputDirectory = resolve(jobDirectory, "output");
    mkdirSync(dirname(inputPath), { recursive: true });
    writeFileSync(inputPath, JSON.stringify(input.geometrySpec), { encoding: "utf8", flag: "wx" });
    const child = spawn(pythonPath, [
      "-m", "workers.cad.project_geometry.build_job", "--input", inputPath, "--output", outputDirectory,
    ], { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const result = new Promise<CadWorkerResult>((resolveResult, rejectResult) => {
      let stdout = "";
      let stderr = "";
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", rejectResult);
      child.once("exit", (code) => {
        if (code !== 0) {
          // 对外错误码不带 stderr，作业目录留一份原文，排查不用重跑构建。
          try { writeFileSync(resolve(jobDirectory, "worker-stderr.log"), stderr, "utf8"); } catch { /* 落盘失败不掩盖原错误 */ }
          return rejectResult(new Error(`CAD_WORKER_FAILED:${stderr.slice(-1_500)}`));
        }
        try {
          const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
          const payload = JSON.parse(line) as Record<string, unknown>;
          const manifest = readFileSync(resolve(outputDirectory, "manifest.json"));
          const manifestHash = sha256(manifest);
          if (payload.status !== "succeeded" || payload.manifestHash !== manifestHash) throw new Error("CAD_WORKER_OUTPUT_HASH_MISMATCH");
          resolveResult({
            geometryRevisionId: String(payload.geometryRevisionId),
            geometrySignature: String(payload.geometrySignature), manifestHash, outputDirectory,
          });
        } catch (error) {
          rejectResult(error);
        }
      });
    });
    return { process: child, result };
  }

  readAsset(jobId: string, fileName: string): Buffer {
    if (!/^(manifest\.json|model\.(?:ifc|glb)|model-brep\.zip|source-map\.ndjson|geometry-report\.json|preview\.png)$/.test(fileName)) {
      throw new Error("CAD_ASSET_NAME_INVALID");
    }
    const directory = resolve(stagingRoot, jobId, "output");
    const path = resolve(directory, fileName);
    if (dirname(path) !== directory) throw new Error("CAD_ASSET_PATH_INVALID");
    return readFileSync(path);
  }
}
