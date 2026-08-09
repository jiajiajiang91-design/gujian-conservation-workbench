import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class MemoryStorage {
  constructor(seed = {}) { this.values = new Map(Object.entries(seed)); this.failWrites = false; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) {
    if (this.failWrites) throw new Error("QUOTA_EXCEEDED");
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

function responseFor(url) {
  const file = path.resolve(ROOT, String(url).replaceAll("/", path.sep));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) {
    return { ok: false, status: 404, async json() { throw new Error("NOT_FOUND"); } };
  }
  return { ok: true, status: 200, async json() { return JSON.parse(fs.readFileSync(file, "utf8")); } };
}

async function makeBrowser(seed = {}) {
  const storage = new MemoryStorage(seed);
  const sandbox = {
    console, localStorage: storage, fetch: async url => responseFor(url),
    Blob, URL, setTimeout, clearTimeout
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "data.js"), "utf8"), sandbox, { filename: "data.js" });
  await sandbox.ProjectData.init();
  return { sandbox, storage };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test("内置项目通过同一 schema，且两个数据集确实不同", async () => {
  const { sandbox } = await makeBrowser();
  const list = sandbox.ProjectData.list();
  assert.ok(list.length >= 2);
  const gaodu = await sandbox.ProjectData.load("gaodu");
  const dongcheng = await sandbox.ProjectData.load("dongcheng");
  assert.equal(sandbox.ProjectData.validate(gaodu).ok, true);
  assert.equal(sandbox.ProjectData.validate(dongcheng).ok, true);
  assert.notEqual(gaodu.项目.名称, dongcheng.项目.名称);
  assert.notDeepEqual(gaodu.构件.map(x => x.名称), dongcheng.构件.map(x => x.名称));
  assert.notDeepEqual(gaodu.尺寸关系[0].项, dongcheng.尺寸关系[0].项);
  assert.equal(gaodu.项目.可对外正式交付, false);
  assert.equal(dongcheng.项目.可对外正式交付, false);
  assert.equal(gaodu.实测.some(x => x.状态 === "measured"), false);
  assert.equal(dongcheng.实测.some(x => x.状态 === "measured"), false);

  for (const bundle of [gaodu, dongcheng]) {
    for (const value of Object.values(bundle.资源)) {
      const resource = sandbox.ProjectData.resolveResource(value);
      assert.ok(resource.startsWith("assets/"));
      assert.equal(fs.existsSync(path.join(ROOT, resource)), true, resource);
    }
    for (const item of bundle.资料.filter(x => x.类型 === "照片" && x.文件)) {
      assert.equal(fs.existsSync(path.join(ROOT, "assets", item.文件)), true, item.文件);
    }
  }
});

test("不可信导入会拦截远程资源、坏框、未知来源和危险字段", async () => {
  const { sandbox } = await makeBrowser();
  const base = await sandbox.ProjectData.load("gaodu");

  const remote = clone(base);
  remote.资源.主图 = "https://example.com/track.png";
  assert.equal(sandbox.ProjectData.validate(remote).ok, false);

  const badBox = clone(base);
  badBox.构件[0].框 = [0, 0, 2, 1];
  assert.equal(sandbox.ProjectData.validate(badBox).ok, false);

  const badSource = clone(base);
  badSource.构件[0].状态 = "model_guess";
  assert.equal(sandbox.ProjectData.validate(badSource).ok, false);

  const dangerous = JSON.parse(JSON.stringify(base).replace(/^\{/, '{"__proto__":{"polluted":true},'));
  const result = sandbox.ProjectData.validate(dangerous);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(x => x.includes("不允许的字段")));
  assert.equal({}.polluted, undefined);
});

test("导出包分离原始证据、当前业务、工作流和审计，并可作为副本导入", async () => {
  const { sandbox } = await makeBrowser();
  const bundle = await sandbox.ProjectData.load("gaodu");
  sandbox.ProjectData.activate(bundle);
  const state = {
    任务卡: bundle.任务卡, 人员: bundle.人员, 资料: bundle.资料, 实测: bundle.实测,
    构件: bundle.构件, 存疑: bundle.存疑, 现状: bundle.现状, 图纸样式: bundle.图纸样式,
    检查问题: [], 交付: bundle.交付, 正式图资源: bundle.资源.正式图,
    当前步骤: "parts", 步骤状态: { parts: "stop" }, 解锁到: 3, 退回记录: [],
    修改记录: [{ 动作: "测试", before: null, after: { ok: true } }], 构件库: [], 排除记录: []
  };
  const exported = sandbox.ProjectData.buildExport(state);
  assert.equal(exported.packageType, "gujian-project-export");
  assert.ok(exported.原始证据 && exported.当前业务 && exported.工作流 && exported.审计);
  assert.equal(Object.hasOwn(exported, "消息"), false);
  assert.doesNotMatch(JSON.stringify(exported), /api[_-]?key|authorization/i);

  const text = JSON.stringify(exported);
  const imported = await sandbox.ProjectData.importFile({ size: Buffer.byteLength(text), async text() { return text; } });
  assert.notEqual(imported.bundle.项目.id, "gaodu");
  assert.equal(imported.bundle.项目.originProjectId, "gaodu");
  assert.equal(imported.bundle.构件.length, bundle.构件.length);
  assert.equal(imported.bundle.导入工作流.当前步骤, "parts");
});

test("Store 按项目隔离状态、保留旧存档，并阻止处理中切换", async () => {
  const legacy = JSON.stringify({ 步骤状态: { task: "done", materials: "idle", datum: "idle", parts: "idle",
    condition: "idle", style: "idle", drawing: "idle", delivery: "idle" }, 消息: [], 构件库: [], 排除记录: [] });
  const { sandbox, storage } = await makeBrowser({ "gujian-wt-state": legacy });
  sandbox.API = { hasPending: () => false };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "store.js"), "utf8"), sandbox, { filename: "store.js" });
  const gaodu = await sandbox.ProjectData.load("gaodu");
  sandbox.Store.init(gaodu, sandbox.ProjectData.list());
  assert.ok(storage.getItem("gujian-wt-state"));
  assert.ok(storage.getItem("gujian-wt-state:gaodu"));

  const originalName = sandbox.Store.get().构件[0].名称;
  sandbox.Store.editPart("P01", { 名称: "高都测试构件" }, "隔离测试");
  assert.equal(sandbox.Store.get().正式图资源.status, "stale");
  await sandbox.Store.switchProject("dongcheng");
  assert.notEqual(sandbox.Store.get().构件[0].名称, "高都测试构件");
  sandbox.Store.editPart("P01", { 名称: "东呈测试构件" }, "隔离测试");
  await sandbox.Store.switchProject("gaodu");
  assert.equal(sandbox.Store.get().构件[0].名称, "高都测试构件");
  assert.notEqual(sandbox.Store.get().构件[0].名称, originalName);

  sandbox.API = { hasPending: () => true };
  await assert.rejects(sandbox.Store.switchProject("dongcheng"), /正在处理/);
  assert.equal(sandbox.Store.activeProjectId(), "gaodu");

  storage.failWrites = true;
  sandbox.Store.emit();
  assert.match(sandbox.Store.get().存储错误, /立即导出/);
});

test("UI 转义覆盖 HTML 文本和属性引号", async () => {
  const { sandbox } = await makeBrowser();
  sandbox.PROV = { badge: value => String(value) };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "ui.js"), "utf8"), sandbox, { filename: "ui.js" });
  assert.equal(sandbox.UI.esc('" onclick="x<y & z\''), "&quot; onclick=&quot;x&lt;y &amp; z&#39;");
});
