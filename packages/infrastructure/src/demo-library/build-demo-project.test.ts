import "fake-indexeddb/auto";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { IndexedDbProjectRepository, openWorkbenchDatabase } from "../indexeddb-project-repository.js";
import { ProjectPackageService } from "../project-package-service.js";
import { buildDemoProject } from "./build-demo-project.js";
import { DAI_LOY_DEMO, DEMO_PROJECTS, GAODU_DEMO } from "./demo-projects.js";
import type { DemoProjectDefinition } from "./definitions.js";

// 演示包的三条硬要求：可复现、可导入、不把演示数据显示成真实结果。

function repository(tag: string): IndexedDbProjectRepository {
  return new IndexedDbProjectRepository(openWorkbenchDatabase(`gujian-demo-${tag}-${crypto.randomUUID()}`));
}

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

// 用小体量替身跑构建，避免测试依赖大文件；真实文件由生成脚本读盘。
// 声明了由产品解析的资料例外：替身字节解析不出来，读真实文件才有意义。
async function stubFiles(definition: DemoProjectDefinition): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const source of definition.sources) {
    if (!source.filePath) continue;
    files.set(source.filePath, source.parseWithProduct
      ? new Uint8Array(await readFile(resolve(ROOT, source.filePath)))
      : new TextEncoder().encode(`stub:${source.key}`));
  }
  return files;
}

async function build(definition: DemoProjectDefinition, tag: string) {
  return buildDemoProject({ definition, files: await stubFiles(definition), repository: repository(tag) });
}

describe("演示项目包生成", () => {
  // 08 第 2 节的可复现指的是导入后得到相同结果，不是每次生成同一串字节：
  // 版本号与操作记录号由仓储在写入时生成，不同次生成必然不同。
  it("重复生成得到相同的项目号与相同的内容", async () => {
    const first = await build(GAODU_DEMO, "repeat-a");
    const second = await build(GAODU_DEMO, "repeat-b");
    expect(second.projectId).toBe(first.projectId);
    expect(second.buildingId).toBe(first.buildingId);

    const read = (bytes: Uint8Array, tag: string) =>
      new ProjectPackageService(repository(tag)).parse(bytes, "demo.gujian.zip").snapshot;
    const left = read(first.packageBytes, "repeat-read-a");
    const right = read(second.packageBytes, "repeat-read-b");
    expect(right.project).toEqual(left.project);
    expect(right.buildings).toEqual(left.buildings);
    expect(right.evidences).toEqual(left.evidences);
    expect(right.facts).toEqual(left.facts);
    expect(right.issues.map((item) => ({ ...item, sourceRef: null, producer: null })))
      .toEqual(left.issues.map((item) => ({ ...item, sourceRef: null, producer: null })));
  });

  it("两个演示项目的项目号不同", async () => {
    const daiLoy = await build(DAI_LOY_DEMO, "id-a");
    const gaodu = await build(GAODU_DEMO, "id-b");
    expect(daiLoy.projectId).not.toBe(gaodu.projectId);
  });

  it("生成的包能被导入解析", async () => {
    const built = await build(DAI_LOY_DEMO, "parse");
    const packages = new ProjectPackageService(repository("parse-target"));
    const parsed = packages.parse(built.packageBytes, "demo.gujian.zip");
    expect(parsed.snapshot.project.id).toBe(built.projectId);
    expect(parsed.snapshot.project.name).toBe(DAI_LOY_DEMO.projectName);
    expect(parsed.auditEvents.length).toBeGreaterThan(0);
  });

  it("演示数据一律标为示例来源，不冒充人工确认或识别结果", async () => {
    for (const definition of DEMO_PROJECTS) {
      const built = await build(definition, `producer-${definition.demoId}`);
      const parsed = new ProjectPackageService(repository(`producer-target-${definition.demoId}`))
        .parse(built.packageBytes, "demo.gujian.zip");
      for (const fact of parsed.snapshot.facts) {
        expect(fact.producer.producerType, `${definition.demoId}/${fact.field}`).toBe("demo");
      }
    }
  });

  it("不写测量记录，实测条数为零", async () => {
    for (const definition of DEMO_PROJECTS) {
      const built = await build(definition, `measure-${definition.demoId}`);
      expect(built.measurementCount, definition.demoId).toBe(0);
      expect(built.completeMeasurementCount, definition.demoId).toBe(0);
    }
  });

  it("拿不到原件的资料登记为缺失，不悄悄少一条", async () => {
    const built = await build(GAODU_DEMO, "missing");
    const declared = GAODU_DEMO.sources.filter((source) => source.filePath === null).length;
    expect(built.evidenceCount).toBe(GAODU_DEMO.sources.length);
    expect(built.missingEvidenceCount).toBe(declared);
    expect(declared).toBeGreaterThan(0);
  });

  it("缺原件的资料在包里仍标为缺失，不被改成可用", async () => {
    const built = await build(GAODU_DEMO, "content-status");
    const parsed = new ProjectPackageService(repository("content-status-target"))
      .parse(built.packageBytes, "demo.gujian.zip");
    const missingIds = new Set(parsed.snapshot.evidences
      .filter((item) => item.dataStatus === "missing").map((item) => item.assetId));
    expect(missingIds.size).toBeGreaterThan(0);
    for (const asset of parsed.assets) {
      if (missingIds.has(asset.id)) expect(asset.contentStatus, asset.fileName).toBe("missing");
    }
  });

  it("含缺原件资料的包能完整导入，不整批失败", async () => {
    const built = await build(GAODU_DEMO, "import-missing");
    const target = repository("import-missing-target");
    const projectId = await new ProjectPackageService(target).import(built.packageBytes, "demo.gujian.zip", crypto.randomUUID());
    const head = await target.getProjectHead(projectId);
    expect(head).not.toBeNull();
    expect(head!.snapshot.evidences).toHaveLength(GAODU_DEMO.sources.length);
    const assets = await target.getProjectAssets(projectId);
    expect(assets).toHaveLength(GAODU_DEMO.sources.length);
    const missing = assets.filter((item) => item.record.contentStatus === "missing");
    expect(missing).toHaveLength(GAODU_DEMO.sources.filter((source) => source.filePath === null).length);
  });

  it("定义里声明了路径却没给文件就报错，不降级成缺失", async () => {
    await expect(buildDemoProject({
      definition: GAODU_DEMO,
      files: new Map(),
      repository: repository("strict"),
    })).rejects.toThrow(/DEMO_SOURCE_FILE_MISSING/);
  });

  it("每个演示项目都带阻断项，正式资格全部阻断，代理成果不阻断", async () => {
    for (const definition of DEMO_PROJECTS) {
      const built = await build(definition, `issue-${definition.demoId}`);
      expect(built.issueCount, definition.demoId).toBeGreaterThan(0);
      const parsed = new ProjectPackageService(repository(`issue-target-${definition.demoId}`))
        .parse(built.packageBytes, "demo.gujian.zip");
      for (const issue of parsed.snapshot.issues) {
        expect(issue.blocksFormalEligibility, `${definition.demoId}/${issue.id}`).toBe(true);
        expect(issue.blocksProxyOutcome, `${definition.demoId}/${issue.id}`).toBe(false);
      }
    }
  });

  it("阻断说明写清缺什么与后果，不只给一个状态词", async () => {
    for (const definition of DEMO_PROJECTS) {
      for (const issue of definition.issues) {
        expect(issue.descriptionZh.length, `${definition.demoId}/${issue.key}`).toBeGreaterThan(30);
      }
    }
  });

  it("每个演示项目都写明适用边界", () => {
    for (const definition of DEMO_PROJECTS) {
      expect(definition.limitationZh.length, definition.demoId).toBeGreaterThan(10);
    }
  });
});
