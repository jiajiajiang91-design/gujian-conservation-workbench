import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pythonPath = resolve(projectRoot, "workers/cad/.venv/Scripts/python.exe");
const geometryStagingRoot = resolve(projectRoot, "apps/server/.data/cad-staging");
const drawingStagingRoot = resolve(projectRoot, "apps/server/.data/drawing-staging");
const fontPath = resolve(projectRoot, "workers/cad/t0b_v2/assets/fonts/noto-sans-sc/GujianSansSC-Regular.ttf");

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface DrawingWorkerResult {
  buildRecordHash: string;
  outputDirectory: string;
  assets: Array<{ kind: string; fileName: string; mimeType: string; sha256: string; byteLength: number }>;
}

export interface DrawingWorkerRun {
  process: ChildProcess;
  result: Promise<DrawingWorkerResult>;
}

export interface DrawingWorker {
  start(input: { jobId: string; sourceCadJobId: string; matrix: unknown }): DrawingWorkerRun;
  readAsset(jobId: string, fileName: string): Buffer;
}

export class PythonDrawingWorker implements DrawingWorker {
  start(input: { jobId: string; sourceCadJobId: string; matrix: unknown }): DrawingWorkerRun {
    const jobDirectory = resolve(drawingStagingRoot, input.jobId);
    if (dirname(jobDirectory) !== drawingStagingRoot) throw new Error("DRAWING_JOB_PATH_INVALID");
    const geometryDirectory = resolve(geometryStagingRoot, input.sourceCadJobId, "output");
    if (relative(geometryStagingRoot, geometryDirectory).startsWith("..") || !existsSync(resolve(geometryDirectory, "manifest.json"))) {
      throw new Error("DRAWING_SOURCE_GEOMETRY_NOT_FOUND");
    }
    const inputPath = resolve(jobDirectory, "input", "artifact-matrix.json");
    const outputDirectory = resolve(jobDirectory, "output");
    if (existsSync(jobDirectory)) rmSync(jobDirectory, { recursive: true, force: true });
    mkdirSync(dirname(inputPath), { recursive: true });
    writeFileSync(inputPath, JSON.stringify(input.matrix), { encoding: "utf8", flag: "wx" });
    const child = spawn(pythonPath, [
      "-m", "workers.cad.project_drawings.build_package", "--matrix", inputPath,
      "--geometry-dir", geometryDirectory, "--font", fontPath, "--output", outputDirectory,
    ], { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const result = new Promise<DrawingWorkerResult>((resolveResult, rejectResult) => {
      let stderr = "";
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", rejectResult);
      child.once("exit", (code) => {
        if (code !== 0) return rejectResult(new Error(`DRAWING_WORKER_FAILED:${stderr.slice(-1_500)}`));
        try {
          const recordPath = resolve(outputDirectory, "drawing-build-record.json");
          const recordBytes = readFileSync(recordPath);
          const record = JSON.parse(recordBytes.toString("utf8")) as { assets: DrawingWorkerResult["assets"] };
          resolveResult({
            buildRecordHash: sha256(recordBytes), outputDirectory,
            assets: [...record.assets, { kind: "checkReport", fileName: "drawing-build-record.json", mimeType: "application/json", sha256: sha256(recordBytes), byteLength: recordBytes.length }],
          });
        } catch (error) {
          rejectResult(error);
        }
      });
    });
    return { process: child, result };
  }

  readAsset(jobId: string, fileName: string): Buffer {
    if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(fileName)) throw new Error("DRAWING_ASSET_NAME_INVALID");
    const directory = resolve(drawingStagingRoot, jobId, "output");
    const path = resolve(directory, ...fileName.split("/"));
    if (relative(directory, path).startsWith("..")) throw new Error("DRAWING_ASSET_PATH_INVALID");
    const record = JSON.parse(readFileSync(resolve(directory, "drawing-build-record.json"), "utf8")) as { assets: Array<{ fileName: string }> };
    if (fileName !== "drawing-build-record.json" && !record.assets.some((item) => item.fileName === fileName)) throw new Error("DRAWING_ASSET_NOT_DECLARED");
    return readFileSync(path);
  }
}
