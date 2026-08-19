import { describe, expect, it } from "vitest";

import { DEMO_PROJECTS } from "./demo-projects.js";

// 08 演示项目定义第 8 节：只有项目名标明这是演示项目，进入项目后
// 任务书、构件、尺寸、图纸、报告的内容都按真实业务写。
// 观看者知道这是演示案例，不需要在每个环节被提醒一次。
//
// 来源标记不在此列：界面把 demo 来源显示为示例资料，那是数据性质标注，
// 与用示例二字填充内容是两回事。

const FILLER_WORDS = ["示例", "样例", "占位", "测试用", "假数据", "demo 数据"];

function contentStrings(): { path: string; text: string }[] {
  const entries: { path: string; text: string }[] = [];
  for (const definition of DEMO_PROJECTS) {
    const push = (path: string, text: string | null | undefined) => {
      if (typeof text === "string" && text.length) entries.push({ path: `${definition.demoId}.${path}`, text });
    };
    push("buildingName", definition.buildingName);
    push("locationText", definition.locationText);
    push("limitationZh", definition.limitationZh);
    definition.sources.forEach((source, index) => {
      push(`sources[${index}].title`, source.title);
      push(`sources[${index}].intendedUse`, source.intendedUse);
      push(`sources[${index}].absenceReasonZh`, source.absenceReasonZh);
      source.parseWarnings.forEach((warning, warningIndex) => push(`sources[${index}].parseWarnings[${warningIndex}]`, warning));
    });
    definition.issues.forEach((issue, index) => push(`issues[${index}].descriptionZh`, issue.descriptionZh));
    definition.measurements.forEach((item, index) => push(`measurements[${index}].methodZh`, item.methodZh));
    push("task.name", definition.task.name);
    definition.task.scope.forEach((item, index) => push(`task.scope[${index}]`, item));
    definition.task.deliverables.forEach((item, index) => push(`task.deliverables[${index}]`, item));
    definition.task.regulationRefs.forEach((item, index) => push(`task.regulationRefs[${index}]`, item));
    const requirements = definition.task.artifactRequirements;
    if (requirements) {
      push("task.artifactRequirements.titleZh", requirements.titleZh);
      requirements.views.forEach((view, index) => push(`task.artifactRequirements.views[${index}].displayLabelZh`, view.displayLabelZh));
      requirements.sheets.forEach((sheet, index) => push(`task.artifactRequirements.sheets[${index}].displayLabelZh`, sheet.displayLabelZh));
    }
    if (definition.archetype) {
      push("archetype.sourceDeclarationZh", definition.archetype.sourceDeclarationZh);
      push("archetype.moduleSourceZh", definition.archetype.moduleSourceZh);
    }
  }
  return entries;
}

describe("演示内容用语", () => {
  it("项目名之外不出现示例、样例、占位字样", () => {
    const offenders = contentStrings()
      .filter((entry) => FILLER_WORDS.some((word) => entry.text.includes(word)))
      .map((entry) => `${entry.path}: ${entry.text.slice(0, 40)}`);
    expect(offenders).toEqual([]);
  });

  it("每个演示项目都有一句适用边界", () => {
    for (const definition of DEMO_PROJECTS) {
      expect(definition.limitationZh.length, definition.demoId).toBeGreaterThan(10);
    }
  });

  it("带形制参数的项目声明了尺寸来源", () => {
    for (const definition of DEMO_PROJECTS) {
      if (!definition.archetype) continue;
      expect(definition.archetype.sourceDeclarationZh.length, definition.demoId).toBeGreaterThan(20);
      expect(definition.archetype.estimatedDimensionKeys.length, definition.demoId).toBeGreaterThan(0);
    }
  });
});
