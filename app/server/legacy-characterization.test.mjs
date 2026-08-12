import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readProject(id) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "projects", `${id}.json`), "utf8"));
}

test("高都迁移输入保留 4400 mm 尺寸冲突和缺失屋面高度", () => {
  const project = readProject("gaodu");
  const measurements = new Map(project.实测.map(item => [item.部位, item]));
  const relation = project.尺寸关系.find(item => item.id === "bay-width");
  const expected = relation.项.reduce((sum, item) => {
    const measurement = measurements.get(item.部位);
    assert.ok(measurement, item.部位);
    return sum + measurement.数值 * item.数量;
  }, 0);
  const actual = measurements.get(relation.结果).数值;

  assert.equal(actual, 15800);
  assert.equal(expected, 11400);
  assert.equal(actual - expected, 4400);
  assert.equal(Object.hasOwn(project, "代理制图输入"), false);
  assert.equal(project.实测.some(item => item.状态 === "measured"), false);
});

test("东呈迁移输入保留五开间关系和实测基准缺失", () => {
  const project = readProject("dongcheng");
  const relation = project.尺寸关系.find(item => item.id === "bay-width");

  assert.deepEqual(
    relation.项.map(item => [item.部位, item.数量]),
    [["明间面阔", 1], ["次间面阔", 2], ["梢间面阔", 2]]
  );
  assert.equal(relation.项.reduce((sum, item) => sum + item.数量, 0), 5);
  assert.equal(project.任务卡.实测基准.来源, "missing");
  assert.equal(project.实测.some(item => item.状态 === "measured"), false);
});

test("旧项目键只在项目内唯一，迁移时必须整体重映射", () => {
  const gaodu = readProject("gaodu");
  const dongcheng = readProject("dongcheng");

  assert.equal(gaodu.项目.id, "gaodu");
  assert.equal(dongcheng.项目.id, "dongcheng");
  assert.equal(gaodu.资料[0].id, "m1");
  assert.equal(dongcheng.资料[0].id, "m1");
  assert.equal(gaodu.构件[0].编号, "P01");
  assert.equal(dongcheng.构件[0].编号, "P01");
  assert.match(gaodu.资源.主图, /^assets\//);
  assert.match(dongcheng.资源.主图, /^assets\//);
});
