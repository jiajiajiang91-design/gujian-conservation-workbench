import { afterEach, describe, expect, it, vi } from "vitest";

import { loadDemoLibrary, type DemoLibraryManifest } from "./demo-library-loader";

// 装载逻辑的覆盖放在这里，不靠 App 测试顺带覆盖：
// 组件里那条链测试无法等待，放进界面测试只会制造竞争。

const MANIFEST: DemoLibraryManifest = {
  schemaVersion: "demo-library-1",
  projects: [
    { demoId: "alpha", fileName: "alpha.zip", projectName: "甲", limitationZh: "示例", projectId: "11111111-1111-4111-8111-111111111111" },
    { demoId: "beta", fileName: "beta.zip", projectName: "乙", limitationZh: "示例", projectId: "22222222-2222-4222-8222-222222222222" },
  ],
};

interface FetchCase {
  manifest?: DemoLibraryManifest | null;
  failPackages?: ReadonlySet<string>;
}

function stubFetch(options: FetchCase = {}) {
  const calls: string[] = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("demo/manifest.json")) {
      if (options.manifest === null) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(options.manifest ?? MANIFEST), { status: 200 });
    }
    const fileName = url.split("/").at(-1)!;
    if (options.failPackages?.has(fileName)) return new Response(null, { status: 500 });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return calls;
}

function packagesStub() {
  const imported: string[] = [];
  return {
    imported,
    service: {
      import: vi.fn(async (_bytes: Uint8Array, fileName: string) => {
        imported.push(fileName);
        return "imported";
      }),
    },
  };
}

function run(existing: readonly string[], packages: ReturnType<typeof packagesStub>) {
  return loadDemoLibrary({
    packages: packages.service as never,
    existingProjectIds: new Set(existing),
    actorId: "33333333-3333-4333-8333-333333333333",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("演示项目装载", () => {
  it("按清单逐个导入", async () => {
    stubFetch();
    const packages = packagesStub();
    const result = await run([], packages);
    expect(result.loaded).toEqual(["alpha", "beta"]);
    expect(packages.imported).toEqual(["alpha.zip", "beta.zip"]);
  });

  it("清单取不到时不装载也不报错", async () => {
    stubFetch({ manifest: null });
    const packages = packagesStub();
    const result = await run([], packages);
    expect(result).toEqual({ loaded: [], skipped: [], failed: [] });
    expect(packages.service.import).not.toHaveBeenCalled();
  });

  it("本地已有的项目跳过，不覆盖已做过的操作", async () => {
    stubFetch();
    const packages = packagesStub();
    const result = await run([MANIFEST.projects[0]!.projectId], packages);
    expect(result.skipped).toEqual(["alpha"]);
    expect(result.loaded).toEqual(["beta"]);
    expect(packages.imported).toEqual(["beta.zip"]);
  });

  it("单个包失败不影响其余，失败逐条留下", async () => {
    stubFetch({ failPackages: new Set(["alpha.zip"]) });
    const packages = packagesStub();
    const result = await run([], packages);
    expect(result.loaded).toEqual(["beta"]);
    expect(result.failed.map((item) => item.demoId)).toEqual(["alpha"]);
  });

  it("并发调用只装载一次", async () => {
    const calls = stubFetch();
    const packages = packagesStub();
    const [left, right] = await Promise.all([run([], packages), run([], packages)]);
    expect(right).toBe(left);
    expect(packages.imported).toEqual(["alpha.zip", "beta.zip"]);
    expect(calls.filter((url) => url.endsWith("manifest.json"))).toHaveLength(1);
  });
});
