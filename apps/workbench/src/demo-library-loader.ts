import type { ProjectPackageService } from "@gujian/infrastructure";

// 首次打开时装载演示项目。走的是用户导入项目包的同一条路径，
// 不另建代码分支，也不在界面里临时构造数据（08 演示项目定义 4、6）。
//
// 清单与包由 tools/build-demo-library.mjs 生成，前端不认识任何具体项目名，
// 项目名、限制说明都从清单读（技术架构 8.1）。

export interface DemoLibraryEntry {
  readonly demoId: string;
  readonly fileName: string;
  readonly projectName: string;
  readonly limitationZh: string;
  readonly projectId: string;
}

export interface DemoLibraryManifest {
  readonly schemaVersion: string;
  readonly projects: readonly DemoLibraryEntry[];
}

export interface DemoLoadResult {
  readonly loaded: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly { demoId: string; reason: unknown }[];
}

const MANIFEST_URL = "demo/manifest.json";

async function fetchManifest(base: string): Promise<DemoLibraryManifest | null> {
  const response = await fetch(`${base}${MANIFEST_URL}`);
  if (!response.ok) return null;
  const value = await response.json() as DemoLibraryManifest;
  if (!Array.isArray(value?.projects)) return null;
  return value;
}

// 同一次会话内只跑一次。开发模式下 effect 会执行两遍，两次并发导入同一个包
// 会在写入时撞键，表现为一半成功一半报错。
let inFlight: Promise<DemoLoadResult> | null = null;

// 已存在的项目不重复导入，也不覆盖：用户在演示项目上做过的操作要保留。
export function loadDemoLibrary(input: {
  packages: ProjectPackageService;
  existingProjectIds: ReadonlySet<string>;
  actorId: string;
  baseUrl?: string;
}): Promise<DemoLoadResult> {
  inFlight ??= runLoad(input).finally(() => { inFlight = null; });
  return inFlight;
}

async function runLoad(input: {
  packages: ProjectPackageService;
  existingProjectIds: ReadonlySet<string>;
  actorId: string;
  baseUrl?: string;
}): Promise<DemoLoadResult> {
  const base = input.baseUrl ?? "/";
  const manifest = await fetchManifest(base);
  if (!manifest) return { loaded: [], skipped: [], failed: [] };

  const loaded: string[] = [];
  const skipped: string[] = [];
  const failed: { demoId: string; reason: unknown }[] = [];
  for (const entry of manifest.projects) {
    if (input.existingProjectIds.has(entry.projectId)) {
      skipped.push(entry.demoId);
      continue;
    }
    try {
      const response = await fetch(`${base}demo/${entry.fileName}`);
      if (!response.ok) throw new Error("DEMO_PACKAGE_DOWNLOAD_FAILED");
      const bytes = new Uint8Array(await response.arrayBuffer());
      await input.packages.import(bytes, entry.fileName, input.actorId);
      loaded.push(entry.demoId);
    } catch (reason) {
      failed.push({ demoId: entry.demoId, reason });
    }
  }
  return { loaded, skipped, failed };
}
